import { batch, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpenCodeClient, OpenCodeEvent } from "../promise"

export type ClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "unauthorized"
export type ClientConnectionEvent = {
  readonly type: "client.connection"
  readonly created: number
  readonly data: {
    readonly status: "connecting" | "connected" | "disconnected" | "reconnecting" | "unauthorized"
    readonly attempt: number
    readonly error?: string
  }
}

export type ClientConnectionOptions = {
  readonly reconnect?: (signal: AbortSignal) => Promise<OpenCodeClient>
  readonly onEvent: (event: OpenCodeEvent) => void
  readonly flushInterval?: number
  readonly pageLifecycle?: boolean
  readonly log?: {
    readonly debug?: (message: string, data?: Readonly<Record<string, unknown>>) => void
    readonly info?: (message: string, data?: Readonly<Record<string, unknown>>) => void
  }
}

const connectTimeout = 2_000
const reconnectDelay = 1_000
const reconnectDelayMax = 30_000

/**
 * Exponential backoff with jitter: 1s, 2s, 4s … capped at 30s. A server that
 * is gone (or a credential that stopped working) otherwise gets hammered once
 * a second for hours — observed as 17k reconnect attempts in one TUI process.
 */
export function reconnectBackoff(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(reconnectDelayMax, reconnectDelay * 2 ** Math.max(0, attempt - 1))
  return Math.round(base * (0.75 + random() * 0.5))
}
const connectionHistoryLimit = 50

/** Consecutive rejected credentials before the loop stops instead of retrying forever. */
const authFailureLimit = 3

export type ReconnectPolicy = { readonly stop: true } | { readonly stop: false; readonly delay: number }

/**
 * What to do after a failed attempt. A run of rejected credentials ends the
 * loop: a 401 does not heal on a timer, and retrying it forever is what turned
 * one orphaned client into 17k requests against a server that would never let
 * it in. Everything else backs off and tries again.
 */
export function reconnectPolicy(
  input: { readonly authFailures: number; readonly attempt: number },
  random: () => number = Math.random,
): ReconnectPolicy {
  if (input.authFailures >= authFailureLimit) return { stop: true }
  return { stop: false, delay: reconnectBackoff(input.attempt, random) }
}

/**
 * HTTP status behind a client error, when there is one. `UnexpectedStatus`
 * carries it in `cause`; a declared error body may carry it as a field.
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const direct = (error as { status?: unknown }).status
  if (typeof direct === "number") return direct
  const cause = (error as { cause?: unknown }).cause
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { status?: unknown }).status
    if (typeof nested === "number") return nested
  }
  return undefined
}

/**
 * A credential the server rejects never starts working on its own, so retrying
 * it on a timer is pure noise: one orphaned TUI pointed at a port another
 * server had taken accumulated 17k reconnects against a 401 in five hours.
 */
export function isAuthError(error: unknown): boolean {
  const status = httpStatusOf(error)
  if (status === 401 || status === 403) return true
  const tag = typeof error === "object" && error !== null ? (error as { _tag?: unknown })._tag : undefined
  return typeof tag === "string" && (tag === "UnauthorizedError" || tag === "ForbiddenError")
}

export function createClientConnection(initialApi: OpenCodeClient, options: ClientConnectionOptions) {
  const abort = new AbortController()
  const history: ClientConnectionEvent[] = []
  const [connection, setConnection] = createStore<{
    status: ClientConnectionStatus
    attempt: number
    error?: string
  }>({ status: "connecting", attempt: 0 })
  let api = initialApi
  let pending: OpenCodeEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let stream: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let generation = 0

  function record(status: ClientConnectionEvent["data"]["status"], attempt: number, error?: string) {
    history.push({ type: "client.connection", created: Date.now(), data: { status, attempt, error } })
    if (history.length > connectionHistoryLimit) history.shift()
  }

  function publish(event: OpenCodeEvent) {
    pending.push(event)
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      const events = pending
      pending = []
      batch(() => events.forEach(options.onEvent))
    }, options.flushInterval ?? 10)
  }

  async function connect(signal: AbortSignal, attempt: number) {
    let connectedAt: number | undefined
    const request = new AbortController()
    const cancel = () => request.abort(signal.reason)
    const timeout = setTimeout(() => request.abort(new Error("Timed out connecting to server")), connectTimeout)
    signal.addEventListener("abort", cancel, { once: true })

    try {
      record(attempt === 0 ? "connecting" : "reconnecting", attempt)
      options.log?.info?.("event stream connecting", { attempt })
      const iterator = api.event.subscribe({ signal: request.signal })[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (signal.aborted) return { error: undefined, connectedAt }
      if (first.done)
        return {
          error:
            request.signal.reason instanceof Error ? request.signal.reason : new Error("Event stream disconnected"),
          connectedAt,
        }
      if (first.value.type !== "server.connected")
        return { error: new Error("Event stream did not start with server.connected"), connectedAt }

      clearTimeout(timeout)
      record("connected", attempt)
      connectedAt = Date.now()
      options.log?.info?.("event stream connected")
      publish(first.value)
      setConnection({ status: "connected", attempt: 0, error: undefined })

      while (!signal.aborted) {
        const event = await iterator.next()
        if (signal.aborted) return { error: undefined, connectedAt }
        if (event.done) return { error: new Error("Event stream disconnected"), connectedAt }
        if ("durable" in event.value)
          options.log?.debug?.("event", {
            type: event.value.type,
            aggregateID: event.value.durable.aggregateID,
            seq: event.value.durable.seq,
          })
        publish(event.value)
      }
      return { error: undefined, connectedAt }
    } catch (error) {
      return { error, connectedAt }
    } finally {
      request.abort()
      clearTimeout(timeout)
      signal.removeEventListener("abort", cancel)
    }
  }

  async function runStream(active: number) {
    let attempt = 0
    let authFailures = 0
    while (!abort.signal.aborted && started && generation === active) {
      setConnection({ status: attempt === 0 ? "connecting" : "reconnecting", attempt })
      const controller = new AbortController()
      stream = controller
      const cancel = () => controller.abort(abort.signal.reason)
      abort.signal.addEventListener("abort", cancel)
      const result = await connect(controller.signal, attempt)
      abort.signal.removeEventListener("abort", cancel)
      if (abort.signal.aborted || !started || generation !== active) return
      if (result.connectedAt !== undefined) {
        authFailures = 0
        if (Date.now() - result.connectedAt >= reconnectDelay) attempt = 0
      }
      attempt += 1
      const message = errorMessage(result.error)
      record("disconnected", attempt, message)
      options.log?.info?.("event stream disconnected", { attempt, error: message })
      setConnection({ status: "reconnecting", attempt, error: message })

      authFailures = isAuthError(result.error) ? authFailures + 1 : 0

      // `reconnect` comes first even after a rejection: it may hand back a
      // client carrying a credential that works, which clears the count.
      if (options.reconnect) {
        const next = await options.reconnect(controller.signal).catch((error) => {
          if (!controller.signal.aborted)
            options.log?.info?.("server resolution failed", { attempt, error: errorMessage(error) })
        })
        if (abort.signal.aborted || controller.signal.aborted || !started || generation !== active) return
        if (next) {
          if (next !== api) authFailures = 0
          api = next
          if (attempt === 1) continue
        }
      }

      const policy = reconnectPolicy({ authFailures, attempt })
      if (policy.stop) {
        stopUnauthorized(attempt, message)
        return
      }
      await wait(policy.delay, controller.signal)
    }
  }

  /**
   * Ends the loop and says why. `started` goes back to false so a later
   * `start()` (new credential, user retry) picks the stream back up.
   */
  function stopUnauthorized(attempt: number, message: string | undefined) {
    started = false
    record("unauthorized", attempt, message)
    options.log?.info?.("event stream unauthorized; not retrying", { attempt, error: message })
    setConnection({ status: "unauthorized", attempt, error: message })
  }

  function start() {
    if (started) return run
    started = true
    const active = ++generation
    const previous = run
    const current = (async () => {
      if (previous) await previous
      await runStream(active)
    })().finally(() => {
      if (run !== current) return
      run = undefined
    })
    run = current
    return run
  }

  function stop() {
    started = false
    generation += 1
    stream?.abort()
  }

  onMount(() => {
    if (options.pageLifecycle) {
      const pagehide = () => stop()
      const pageshow = (event: PageTransitionEvent) => {
        if (event.persisted) void start()
      }
      window.addEventListener("pagehide", pagehide)
      window.addEventListener("pageshow", pageshow)
      onCleanup(() => {
        window.removeEventListener("pagehide", pagehide)
        window.removeEventListener("pageshow", pageshow)
      })
    }
    void start()
  })

  onCleanup(() => {
    stop()
    abort.abort()
    if (flushTimer) clearTimeout(flushTimer)
    pending = []
  })

  return {
    status: () => connection.status,
    attempt: () => connection.attempt,
    error: () => connection.error,
    internal: {
      history: () => history.slice(),
    },
  }
}

function errorMessage(error: unknown) {
  if (error === undefined) return undefined
  if (error instanceof Error) return error.message
  return String(error)
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
