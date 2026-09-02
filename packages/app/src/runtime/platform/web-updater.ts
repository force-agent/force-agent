import { createSignal } from "solid-js"
import type { UpdaterPlatform, UpdaterState } from "@/shell/updates/types"

/** `SelfUpdate.Status` as served by `GET /api/update` (only the fields the app reads). */
type UpdateStatus = {
  current: string
  latest?: string
  available: boolean
  canApply: boolean
  command?: string
  phase:
    | { type: "idle" }
    | { type: "checking" }
    | { type: "installing"; version: string }
    | { type: "restarting"; version: string; pid: number }
    | { type: "error"; message: string; hint?: string }
}

type Health = { version?: string; pid?: number }

/** The slice of the service worker API the updater touches; kept structural so tests can fake it. */
export type WebUpdaterWorker = {
  state: string
  postMessage(message: unknown): void
  addEventListener(type: "statechange", listener: () => void): void
  removeEventListener(type: "statechange", listener: () => void): void
}
export type WebUpdaterRegistration = {
  waiting: WebUpdaterWorker | null
  installing: WebUpdaterWorker | null
  update(): Promise<unknown>
  unregister(): Promise<boolean>
}
export type WebUpdaterServiceWorker = {
  getRegistration(): Promise<WebUpdaterRegistration | undefined>
}

export type WebUpdaterOptions = {
  /** Origin of the force-agent server that serves `/api/update` and `/api/health`. */
  baseUrl: string
  fetch?: typeof globalThis.fetch
  /** Basic credential (base64 `user:password`) when the page carries one; the browser's own cache covers the rest. */
  authorization?: () => string | null | undefined
  serviceWorker?: WebUpdaterServiceWorker
  reload?: () => void
  pollMs?: number
  /** Whole install → restart → healthy budget. */
  deadlineMs?: number
  /** How long to wait for the new service worker to install and activate before giving up on it. */
  serviceWorkerTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** The new server did not come back healthy within the deadline; the UI turns this into the manual command. */
export class WebUpdateTimeoutError extends Error {
  constructor(
    readonly version: string,
    readonly command: string | undefined,
  ) {
    super(command ? `Update to ${version} timed out; run: ${command}` : `Update to ${version} timed out`)
    this.name = "WebUpdateTimeoutError"
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createWebUpdater(options: WebUpdaterOptions): UpdaterPlatform {
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const sleep = options.sleep ?? defaultSleep
  const pollMs = options.pollMs ?? 1000
  const deadlineMs = options.deadlineMs ?? 90_000
  const swTimeoutMs = options.serviceWorkerTimeoutMs ?? 20_000
  const reload = options.reload ?? (() => window.location.reload())
  const [state, setState] = createSignal<UpdaterState>({ status: "idle" })
  let command: string | undefined

  async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" }
    const token = options.authorization?.()
    if (token) headers.authorization = `Basic ${token}`
    if (init?.body !== undefined) headers["content-type"] = "application/json"
    const response = await fetch(`${options.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(errorMessage(body) ?? `${response.status} ${response.statusText}`)
    return body as T
  }

  const health = () => request<Health>("/api/health")

  function fromStatus(status: UpdateStatus): UpdaterState {
    command = status.command
    const phase = status.phase
    if (phase.type === "installing") return { status: "installing", version: phase.version }
    if (phase.type === "restarting") return { status: "restarting", version: phase.version }
    if (phase.type === "error") return { status: "error", message: phaseMessage(phase) }
    if (!status.available || !status.latest) return { status: "up-to-date" }
    if (status.canApply) return { status: "ready", version: status.latest }
    return { status: "manual", version: status.latest, command: status.command }
  }

  async function check() {
    setState({ status: "checking" })
    const next = await request<UpdateStatus>("/api/update?refresh=true").then(fromStatus, (error) => ({
      status: "error" as const,
      message: error instanceof Error ? error.message : String(error),
    }))
    setState(next)
    return next
  }

  async function install() {
    const current = state()
    if (current.status !== "ready") return
    const version = current.version
    const deadline = Date.now() + deadlineMs
    const expired = () => Date.now() > deadline
    setState({ status: "installing", version })
    try {
      // The pid tells the old process from the new one when both answer with the same version.
      const before = await health().catch(() => undefined)
      let status = await request<UpdateStatus>("/api/update/apply", { method: "POST", body: { version } })
      while (status.phase.type !== "restarting") {
        if (status.phase.type === "error") throw new Error(phaseMessage(status.phase))
        // Already back on the new version: the restart happened between two polls.
        if (status.phase.type === "idle" && status.current === version) break
        if (expired()) throw new WebUpdateTimeoutError(version, command)
        await sleep(pollMs)
        // A failed poll means the old process is already gone: move on to the health probe.
        const next = await request<UpdateStatus>("/api/update").catch(() => undefined)
        if (!next) break
        status = next
      }
      setState({ status: "restarting", version })
      while (true) {
        if (expired()) throw new WebUpdateTimeoutError(version, command)
        await sleep(pollMs)
        // 503 while the process goes down and comes up, connection refused in between: keep polling.
        const now = await health().catch(() => undefined)
        if (!now || now.version !== version) continue
        if (before?.pid !== undefined && now.pid === before.pid) continue
        break
      }
      if (options.serviceWorker) await refreshServiceWorker(options.serviceWorker, sleep, swTimeoutMs)
      reload()
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  return { state, check, install }
}

/**
 * The PWA precache is registered with `skipWaiting: false`, so a plain reload would serve the
 * old UI from the cache. Fetch the new worker, promote it, and only then reload; when any step
 * fails, drop the registration so the reload goes to the network instead.
 */
async function refreshServiceWorker(
  container: WebUpdaterServiceWorker,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
) {
  const registration = await container.getRegistration().catch(() => undefined)
  if (!registration) return
  const drop = () => registration.unregister().catch(() => false)
  const updated = await registration.update().then(
    () => true,
    () => false,
  )
  if (!updated) {
    await drop()
    return
  }
  const worker = await workerReached(registration, "installed", sleep, timeoutMs)
  // No new worker: the build did not change, the precache already matches.
  if (worker === undefined) return
  if (worker === null) {
    await drop()
    return
  }
  worker.postMessage({ type: "SKIP_WAITING" })
  const activated = await stateReached(worker, "activated", sleep, timeoutMs)
  if (!activated) await drop()
}

/** Resolve the new worker once it is waiting (`installed`); `undefined` when there is none, `null` when it died. */
async function workerReached(
  registration: WebUpdaterRegistration,
  target: "installed",
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
) {
  if (registration.waiting) return registration.waiting
  const worker = registration.installing
  if (!worker) return undefined
  const ok = await stateReached(worker, target, sleep, timeoutMs)
  return ok ? worker : null
}

function stateReached(
  worker: WebUpdaterWorker,
  target: "installed" | "activated",
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
) {
  const past = target === "installed" ? ["installed", "activating", "activated"] : ["activated"]
  const reached = () => past.includes(worker.state)
  if (reached()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      worker.removeEventListener("statechange", listener)
      resolve(value)
    }
    const listener = () => {
      if (reached()) done(true)
      else if (worker.state === "redundant") done(false)
    }
    worker.addEventListener("statechange", listener)
    void sleep(timeoutMs).then(() => done(false))
  })
}

function phaseMessage(phase: { message: string; hint?: string }) {
  return phase.hint ? `${phase.message} (${phase.hint})` : phase.message
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const record = body as { message?: unknown; data?: { message?: unknown } }
  if (typeof record.message === "string") return record.message
  if (typeof record.data?.message === "string") return record.data.message
  return undefined
}
