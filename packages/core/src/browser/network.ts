import type { Browser } from "@opencode-ai/schema/browser"
import type { CdpClient, CdpEvent } from "./cdp/client.js"

export const CAPACITY = 500
export const BODY_LIMIT = 256 * 1024

// Header values that would hand the model a credential it does not need: `browser_fetch` runs
// inside the page, so cookies and bearer tokens apply without ever being read.
const REDACTED = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"])

export type Filter = Pick<Browser.NetworkInput, "host" | "path" | "xhr" | "since" | "limit">

type Entry = {
  -readonly [K in keyof Browser.NetworkEntry]: Browser.NetworkEntry[K]
}

type Log = {
  readonly sessionId: string
  readonly entries: Entry[]
  readonly index: Map<string, Entry>
}

// Request log per tab: `Network.enable` on attach, a ring buffer of CAPACITY entries filled by
// `requestWillBeSent` / `responseReceived` / `loadingFailed`, and bodies fetched on demand with
// `Network.getResponseBody` (Chromium keeps them until the next navigation). Never Runtime.enable.
// `agent` says whether the agent holds control right now: requests captured while it does not
// (a person logging in, a handoff) are listed but their bodies stay private.
export class Network {
  private readonly logs = new Map<string, Log>()
  private readonly offs: Array<() => void>

  constructor(
    private readonly client: CdpClient,
    private readonly agent: () => boolean = () => true,
  ) {
    this.offs = [
      client.on("Network.requestWillBeSent", (event) => this.request(event)),
      client.on("Network.responseReceived", (event) => this.response(event)),
      client.on("Network.requestServedFromCache", (event) => this.cached(event)),
      client.on("Network.loadingFailed", (event) => this.failed(event)),
    ]
  }

  // Enabling again for the same session (the desktop re-attached its debugger) keeps the log.
  async enable(tabID: string, sessionId: string) {
    const existing = this.logs.get(tabID)
    this.logs.set(tabID, existing?.sessionId === sessionId ? existing : { sessionId, entries: [], index: new Map() })
    await this.client.send("Network.enable", { maxResourceBufferSize: 10 * 1024 * 1024 }, sessionId)
  }

  drop(tabID: string) {
    this.logs.delete(tabID)
  }

  close() {
    for (const off of this.offs) off()
    this.logs.clear()
  }

  // Newest first, after the filters; `total` is the count before `limit`.
  list(tabID: string, filter: Filter): { entries: Browser.NetworkEntry[]; total: number } {
    const log = this.logs.get(tabID)
    if (!log) return { entries: [], total: 0 }
    const matched = log.entries.filter((entry) => matches(entry, filter)).reverse()
    const limit = filter.limit ?? 50
    return { entries: matched.slice(0, limit).map(snapshot), total: matched.length }
  }

  async body(tabID: string, id: string): Promise<Browser.NetworkBody> {
    const log = this.logs.get(tabID)
    const entry = log?.index.get(id)
    if (!log || !entry) throw new Error(`No captured request ${id} in this tab`)
    if (entry.captured === "human")
      throw new Error(
        `Request ${id} was captured while a person was using the browser, so its body is not available; replay it with browser_fetch if you need the response.`,
      )
    const result = await this.client.send<{ body: string; base64Encoded: boolean }>(
      "Network.getResponseBody",
      { requestId: id },
      log.sessionId,
    )
    return decodeBody(id, result.body, result.base64Encoded, log.index.get(id)?.mimeType)
  }

  private log(event: CdpEvent) {
    if (event.sessionId === undefined) return
    for (const log of this.logs.values()) if (log.sessionId === event.sessionId) return log
    return undefined
  }

  private request(event: CdpEvent) {
    const log = this.log(event)
    if (!log) return
    const params = event.params as {
      requestId: string
      request: { url: string; method: string; headers: Record<string, string> }
      type?: string
      wallTime?: number
      redirectResponse?: unknown
    }
    const entry: Entry = {
      id: params.requestId,
      method: params.request.method,
      url: params.request.url,
      type: (params.type ?? "other").toLowerCase(),
      requestHeaders: redact(params.request.headers),
      timestamp: params.wallTime === undefined ? Date.now() : Math.round(params.wallTime * 1000),
      fromCache: false,
      captured: this.agent() ? "agent" : "human",
    }
    // A redirect reuses the requestId; the hop being followed replaces the earlier one.
    const previous = log.index.get(entry.id)
    if (previous) {
      const at = log.entries.indexOf(previous)
      if (at !== -1) log.entries.splice(at, 1)
    }
    log.entries.push(entry)
    log.index.set(entry.id, entry)
    if (log.entries.length > CAPACITY) {
      const evicted = log.entries.shift()
      if (evicted && log.index.get(evicted.id) === evicted) log.index.delete(evicted.id)
    }
  }

  private response(event: CdpEvent) {
    const entry = this.log(event)?.index.get(event.params.requestId as string)
    if (!entry) return
    const response = event.params.response as {
      status: number
      mimeType?: string
      headers: Record<string, string>
      fromDiskCache?: boolean
      fromServiceWorker?: boolean
    }
    entry.status = response.status
    entry.mimeType = response.mimeType
    entry.responseHeaders = redact(response.headers)
    entry.fromCache = entry.fromCache || response.fromDiskCache === true
  }

  private cached(event: CdpEvent) {
    const entry = this.log(event)?.index.get(event.params.requestId as string)
    if (entry) entry.fromCache = true
  }

  private failed(event: CdpEvent) {
    const entry = this.log(event)?.index.get(event.params.requestId as string)
    if (entry) entry.error = String(event.params.errorText ?? "failed")
  }
}

const XHR = new Set(["xhr", "fetch"])

function matches(entry: Entry, filter: Filter) {
  if (filter.xhr && !XHR.has(entry.type)) return false
  if (filter.since !== undefined && entry.timestamp < filter.since) return false
  if (filter.host !== undefined || filter.path !== undefined) {
    const url = parse(entry.url)
    if (!url) return false
    if (filter.host !== undefined && !url.hostname.toLowerCase().includes(filter.host.toLowerCase())) return false
    if (filter.path !== undefined && !url.pathname.includes(filter.path)) return false
  }
  return true
}

function parse(url: string) {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

function snapshot(entry: Entry): Browser.NetworkEntry {
  return { ...entry }
}

function redact(headers: Record<string, string> | undefined) {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {}))
    out[key] = REDACTED.has(key.toLowerCase()) ? "<redacted>" : value
  return out
}

export function isTextual(mime: string | undefined) {
  if (!mime) return false
  const type = mime.toLowerCase().split(";")[0].trim()
  return (
    type.startsWith("text/") ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded"
  )
}

// Base64 bodies with a textual mime type are decoded to text; others stay base64. Both are cut
// at BODY_LIMIT characters with `truncated` set so the caller can say so; a base64 cut lands on a
// group boundary so what remains still decodes.
export function decodeBody(id: string, raw: string, base64Encoded: boolean, mime: string | undefined): Browser.NetworkBody {
  const text = base64Encoded && isTextual(mime) ? Buffer.from(raw, "base64").toString("utf8") : raw
  const base64 = base64Encoded && !isTextual(mime)
  const limit = base64 ? BODY_LIMIT - (BODY_LIMIT % 4) : BODY_LIMIT
  return {
    id,
    body: text.length > limit ? text.slice(0, limit) : text,
    base64,
    truncated: text.length > limit,
  }
}
