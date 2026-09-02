export * as BrowserProvider from "./provider-client"

import { createHash } from "node:crypto"
import path from "node:path"
import { session, type BrowserWindow, type WebContents } from "electron"
import { Context, Effect, Layer } from "effect"
import type { BrowserViewBounds, BrowserViewLocation, ServerReadyData } from "../../shared/ipc-contract"
import { scoped } from "../native/logging"
import { BackgroundService } from "../service/background-service"
import { applyPolicy } from "./policy"
import { startThumbnails } from "./thumbnail"
import { ViewHost, type Tab } from "./view-host"

export interface Interface {
  readonly setBounds: (location: BrowserViewLocation, win: BrowserWindow, bounds: BrowserViewBounds) => void
  readonly setVisible: (location: BrowserViewLocation, win: BrowserWindow, visible: boolean) => void
  readonly focus: (location: BrowserViewLocation) => void
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/BrowserProvider") {}

type Log = (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void

// Wire messages mirror `@opencode-ai/core/browser/provider/desktop`.
type Inbound =
  | { type: "cdp.send"; id: number; tabID: string; method: string; params?: Record<string, unknown> }
  | { type: "tab.create"; id: number; url: string }
  | { type: "tab.close"; id: number; tabID: string }
  | { type: "tab.activate"; id: number; tabID: string }

type Outbound =
  | { type: "hello"; profile: string; userAgent: string; tabs: Tab[] }
  | { type: "cdp.event"; tabID: string; method: string; params: unknown }
  | { type: "cdp.result"; id: number; result?: unknown; error?: { code: number; message: string } }
  | { type: "tab.list"; tabs: Tab[] }
  | { type: "tab.attached"; tabID: string }
  | { type: "thumbnail"; tabID: string; version: number; jpegBase64: string }

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const REATTACH_MS = 500

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundService.Service
    const runFork = Effect.runForkWith(yield* Effect.context())
    const log: Log = (level, message, data) =>
      runFork(scoped("browser", level === "warn" ? Effect.logWarning(message, data) : Effect.logInfo(message, data)))
    const clients = new Map<string, Client>()

    // One client per project location, created by the first window that shows its browser panel.
    const ensure = (location: BrowserViewLocation, win: BrowserWindow) => {
      const key = `${location.directory}\u0000${location.workspaceID ?? ""}`
      const existing = clients.get(key)
      if (existing) {
        existing.host.host(win)
        return existing
      }
      const client = new Client(location, () => Effect.runPromise(background.connection), log)
      clients.set(key, client)
      client.host.host(win)
      client.connect()
      return client
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const client of clients.values()) client.dispose()
        clients.clear()
      }),
    )

    return Service.of({
      setBounds: (location, win, bounds) => ensure(location, win).host.setBounds(bounds),
      setVisible: (location, win, visible) => ensure(location, win).host.setVisible(visible),
      focus: (location) => clients.get(`${location.directory}\u0000${location.workspaceID ?? ""}`)?.host.focus(),
    })
  }),
)

class Client {
  readonly host: ViewHost
  private socket: WebSocket | undefined
  private backoff = BACKOFF_MIN_MS
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly stopThumbnails: () => void
  private readonly partition: string

  constructor(
    private readonly location: BrowserViewLocation,
    private readonly connection: () => Promise<ServerReadyData>,
    private readonly log: Log,
  ) {
    // Deliberately still the old brand. An Electron partition name IS the
    // on-disk directory holding that profile's cookies, so renaming it does not
    // migrate the profile — it abandons it, and the human logins performed
    // through `browser_handoff` are exactly what would be lost.
    this.partition = `persist:labharness-${profileFor(location)}`
    this.host = new ViewHost({
      partition: this.partition,
      onChange: () => this.send({ type: "tab.list", tabs: this.host.list() }),
      onCreate: (contents, tabID) => {
        applyPolicy(contents, {
          // A popup the person opened is listed but not activated: the server owns the active
          // tab and only learns of activation through its own `tab.activate`.
          onNewTab: (url) => this.host.create(url, false),
          downloads: path.join(location.directory, ".force", "downloads"),
          log: (message, data) => log("info", message, data),
        })
        this.attachDebugger(contents, tabID)
      },
    })
    this.stopThumbnails = startThumbnails(this.host, (tabID, version, jpegBase64) =>
      this.send({ type: "thumbnail", tabID, version, jpegBase64 }),
    )
  }

  connect() {
    if (this.disposed || this.socket) return
    void this.connection()
      .then((server) => {
        if (this.disposed) return
        const url = new URL("/api/browser/provider", server.url)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        url.searchParams.set("location[directory]", this.location.directory)
        if (this.location.workspaceID) url.searchParams.set("location[workspace]", this.location.workspaceID)
        // The global WebSocket cannot set headers; the server accepts Basic credentials as `auth_token`.
        url.searchParams.set(
          "auth_token",
          Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString("base64"),
        )
        const socket = new WebSocket(url)
        this.socket = socket
        socket.addEventListener("open", () => {
          this.backoff = BACKOFF_MIN_MS
          this.log("info", "browser provider connected", { directory: this.location.directory })
          // The views' UA: Chromium's own for this partition, minus the Electron token (view-host
          // strips the same from every view).
          this.send({
            type: "hello",
            profile: profileFor(this.location),
            userAgent: session.fromPartition(this.partition).getUserAgent().replace(/ Electron\/\S+/, ""),
            tabs: this.host.list(),
          })
        })
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return
          void this.handle(JSON.parse(event.data) as Inbound)
        })
        socket.addEventListener("close", () => {
          if (this.socket === socket) this.socket = undefined
          this.retry("closed")
        })
        socket.addEventListener("error", () => {
          if (this.socket === socket) this.socket = undefined
          socket.close()
        })
      })
      .catch((error: unknown) => {
        this.log("warn", "browser provider could not resolve the sidecar", { error: String(error) })
        this.retry("sidecar unavailable")
      })
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.stopThumbnails()
    this.socket?.close()
    this.socket = undefined
    this.host.dispose()
  }

  private retry(reason: string) {
    if (this.disposed || this.timer) return
    this.log("warn", "browser provider disconnected; reconnecting", { reason, inMs: this.backoff })
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.connect()
    }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
  }

  private send(message: Outbound) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private async handle(message: Inbound) {
    if (message.type === "tab.create") {
      const targetId = this.host.create(message.url)
      return this.send({ type: "cdp.result", id: message.id, result: { targetId } })
    }
    if (message.type === "tab.close") {
      this.host.close(message.tabID)
      return this.send({ type: "cdp.result", id: message.id, result: {} })
    }
    if (message.type === "tab.activate") {
      this.host.activate(message.tabID)
      return this.send({ type: "cdp.result", id: message.id, result: {} })
    }
    if (message.type !== "cdp.send") return
    const view = this.host.get(message.tabID)
    if (!view || view.webContents.isDestroyed())
      return this.send({
        type: "cdp.result",
        id: message.id,
        error: { code: -32000, message: `No tab with id ${message.tabID}` },
      })
    const result: unknown = await view.webContents.debugger
      .sendCommand(message.method, message.params ?? {})
      .catch((error: unknown) => new CommandFailure(error))
    if (result instanceof CommandFailure)
      return this.send({ type: "cdp.result", id: message.id, error: { code: -32000, message: result.message } })
    this.send({ type: "cdp.result", id: message.id, result })
  }

  // The debugger stays attached for the life of the view; DevTools or a crash can detach it,
  // in which case it is re-attached after a short pause and the server is told, since the
  // domains it enabled (Page, Network) did not survive the detach.
  private attachDebugger(contents: WebContents, tabID: string) {
    const api = contents.debugger
    const attach = (again: boolean) => {
      if (contents.isDestroyed() || api.isAttached()) return
      try {
        api.attach("1.3")
      } catch (error) {
        this.log("warn", "browser debugger attach failed", { tabID, error: String(error) })
        return
      }
      if (again) this.send({ type: "tab.attached", tabID })
    }
    api.on("message", (_event, method, params, sessionId) => {
      // Child targets (iframes) speak through their own session ids the server does not track.
      if (sessionId) return
      this.send({ type: "cdp.event", tabID, method, params })
    })
    api.on("detach", (_event, reason) => {
      if (contents.isDestroyed()) return
      this.log("warn", "browser debugger detached; re-attaching", { tabID, reason })
      setTimeout(() => attach(true), REATTACH_MS)
    })
    attach(false)
  }
}

class CommandFailure {
  readonly message: string
  constructor(error: unknown) {
    this.message = error instanceof Error ? error.message : String(error)
  }
}

// Partition names must be stable across restarts so cookies persist, and distinct per project.
function profileFor(location: BrowserViewLocation) {
  const base = path.basename(location.directory).replace(/[^a-z0-9_-]/gi, "_").slice(0, 32) || "project"
  const hash = createHash("sha1")
    .update(`${location.directory}\u0000${location.workspaceID ?? ""}`)
    .digest("hex")
    .slice(0, 8)
  return `${base}-${hash}`
}
