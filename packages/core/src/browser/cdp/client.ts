import type { CdpTransport } from "./transport.js"

export type CdpParams = Record<string, unknown>

export type CdpEvent = {
  readonly method: string
  readonly params: CdpParams
  readonly sessionId?: string
}

export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message} (${code})`)
    this.name = "CdpError"
  }
}

type Pending = {
  readonly method: string
  readonly resolve: (value: CdpParams) => void
  readonly reject: (error: Error) => void
}

type Listener = (event: CdpEvent) => void

// Minimal CDP client: incrementing ids, flat sessions (`sessionId` on every frame after
// `Target.setAutoAttach({flatten:true})`), and event listeners keyed by method. No domain wrappers.
export class CdpClient {
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly closers = new Set<() => void>()
  private closed = false

  constructor(private readonly transport: CdpTransport) {
    transport.onMessage((raw) => this.receive(raw))
    transport.onClose(() => this.fail(new Error("CDP connection closed")))
  }

  onClose(listener: () => void): () => void {
    this.closers.add(listener)
    return () => {
      this.closers.delete(listener)
    }
  }

  send<T extends CdpParams = CdpParams>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject })
      this.transport.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    })
  }

  // Listen to one event method across all sessions; the listener sees the sessionId.
  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(listener)
    this.listeners.set(method, set)
    return () => {
      set.delete(listener)
    }
  }

  // Resolve once with the first matching event, or reject after `timeoutMs`.
  once(method: string, match: (event: CdpEvent) => boolean, timeoutMs: number): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      const off = this.on(method, (event) => {
        if (!match(event)) return
        clearTimeout(timer)
        off()
        resolve(event)
      })
    })
  }

  close() {
    if (this.closed) return
    this.transport.close()
    this.fail(new Error("CDP client closed"))
  }

  private receive(raw: string) {
    const message = parse(raw)
    if (message === undefined) return
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new CdpError(pending.method, message.error.code, message.error.message))
        return
      }
      pending.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== "string") return
    const event = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId }
    for (const listener of this.listeners.get(message.method) ?? []) listener(event)
  }

  private fail(error: Error) {
    const first = !this.closed
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!first) return
    for (const listener of this.closers) listener()
  }
}

type Frame = {
  readonly id?: number
  readonly method?: string
  readonly params?: CdpParams
  readonly result?: CdpParams
  readonly sessionId?: string
  readonly error?: { readonly code: number; readonly message: string }
}

function parse(raw: string): Frame | undefined {
  try {
    return JSON.parse(raw) as Frame
  } catch {
    return undefined
  }
}
