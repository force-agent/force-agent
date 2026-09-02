import { CdpClient, type CdpParams } from "../cdp/client.js"
import type { CdpTransport } from "../cdp/transport.js"
import { registerDesktop, type CdpConnection, type CdpProvider } from "./index.js"

// The Electron main process connects to the server over `/api/browser/provider` and relays
// `webContents.debugger` for one `WebContentsView` per tab. This module speaks that JSON protocol
// and presents it to `session.ts` as a regular browser-level CDP connection: the flat-session
// `Target.*` calls the session relies on are answered here from the desktop's tab list, and every
// page-level command (`sessionId` set) travels as `cdp.send` to the view that owns the tab.

export type DesktopTab = {
  readonly id: string
  readonly url: string
  readonly title: string
}

export type Hello = {
  readonly type: "hello"
  readonly profile: string
  readonly userAgent: string
  readonly tabs: ReadonlyArray<DesktopTab>
}

// desktop → server
export type Inbound =
  | Hello
  | { readonly type: "cdp.event"; readonly tabID: string; readonly method: string; readonly params?: CdpParams }
  | {
      readonly type: "cdp.result"
      readonly id: number
      readonly result?: CdpParams
      readonly error?: { readonly code: number; readonly message: string }
    }
  | { readonly type: "tab.list"; readonly tabs: ReadonlyArray<DesktopTab> }
  | { readonly type: "tab.attached"; readonly tabID: string }
  | { readonly type: "thumbnail"; readonly tabID: string; readonly version: number; readonly jpegBase64: string }

// server → desktop. Every request carries the CDP id so the desktop answers with `cdp.result`.
export type Outbound =
  | { readonly type: "cdp.send"; readonly id: number; readonly tabID: string; readonly method: string; readonly params: CdpParams }
  | { readonly type: "tab.create"; readonly id: number; readonly url: string }
  | { readonly type: "tab.close"; readonly id: number; readonly tabID: string }
  | { readonly type: "tab.activate"; readonly id: number; readonly tabID: string }

// The wire the server hands over: text frames in and out, plus the close signal. The handler
// adapts the Effect socket; tests adapt a Bun WebSocket.
export type DesktopSocket = {
  readonly send: (message: string) => void
  readonly onMessage: (listener: (message: string) => void) => () => void
  readonly onClose: (listener: () => void) => () => void
  readonly close: () => void
}

export type ThumbnailListener = (tabID: string, data: Uint8Array) => void

const HELLO_TIMEOUT_MS = 10_000

export function parse(raw: string): Inbound | undefined {
  try {
    const message = JSON.parse(raw) as Inbound
    return typeof message?.type === "string" ? message : undefined
  } catch {
    return undefined
  }
}

// One connected desktop. `attach` resolves once the desktop said hello and the provider is
// registered for `key`; the returned promise settles when the socket closes.
export function attach(key: string, socket: DesktopSocket): Promise<{ readonly closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      socket.close()
      reject(new Error("Desktop provider did not send hello"))
    }, HELLO_TIMEOUT_MS)
    const off = socket.onMessage((raw) => {
      const message = parse(raw)
      if (message?.type !== "hello") return
      clearTimeout(timer)
      off()
      resolve({ closed: new Desktop(key, socket, message).closed })
    })
    socket.onClose(() => {
      clearTimeout(timer)
      reject(new Error("Desktop provider closed before hello"))
    })
  })
}

class Desktop implements CdpProvider {
  readonly kind = "desktop" as const
  readonly closed: Promise<void>
  private readonly tabs = new Map<string, DesktopTab>()
  private readonly clients = new Set<Bridge>()
  private readonly thumbnails = new Set<ThumbnailListener>()
  private readonly unregister: () => void
  readonly profile: string
  readonly userAgent: string

  constructor(
    key: string,
    private readonly socket: DesktopSocket,
    hello: Hello,
  ) {
    this.profile = hello.profile
    this.userAgent = hello.userAgent
    for (const tab of hello.tabs) this.tabs.set(tab.id, tab)
    socket.onMessage((raw) => this.receive(raw))
    this.closed = new Promise((resolve) => {
      socket.onClose(() => {
        this.unregister()
        for (const bridge of this.clients) bridge.close()
        this.clients.clear()
        resolve()
      })
    })
    this.unregister = registerDesktop(key, this)
  }

  connect(): Promise<CdpConnection> {
    const bridge = new Bridge(this, this.tabs, (message) => this.socket.send(JSON.stringify(message)))
    this.clients.add(bridge)
    const client = new CdpClient(bridge)
    return Promise.resolve({
      client,
      close: async () => {
        this.clients.delete(bridge)
        client.close()
      },
      thumbnails: (listener) => {
        this.thumbnails.add(listener)
        return () => {
          this.thumbnails.delete(listener)
        }
      },
    })
  }

  private receive(raw: string) {
    const message = parse(raw)
    if (!message) return
    if (message.type === "thumbnail") {
      const data = new Uint8Array(Buffer.from(message.jpegBase64, "base64"))
      for (const listener of this.thumbnails) listener(message.tabID, data)
      return
    }
    if (message.type === "tab.list") {
      const next = new Map(message.tabs.map((tab) => [tab.id, tab]))
      const removed = [...this.tabs.keys()].filter((id) => !next.has(id))
      const added = [...next.values()].filter((tab) => !this.tabs.has(tab.id))
      const changed = [...next.values()].filter((tab) => {
        const previous = this.tabs.get(tab.id)
        return previous !== undefined && (previous.url !== tab.url || previous.title !== tab.title)
      })
      this.tabs.clear()
      for (const tab of next.values()) this.tabs.set(tab.id, tab)
      for (const bridge of this.clients) {
        for (const id of removed) bridge.emit("Target.targetDestroyed", { targetId: id })
        for (const tab of added) bridge.attached(tab)
        for (const tab of changed) bridge.emit("Target.targetInfoChanged", { targetInfo: targetInfo(tab) })
      }
      return
    }
    if (message.type === "tab.attached") {
      // The desktop re-attached its debugger to the view: the page-level domains enabled on
      // attach are gone, so every client attaches the tab again.
      const tab = this.tabs.get(message.tabID)
      if (tab) for (const bridge of this.clients) bridge.attached(tab)
      return
    }
    for (const bridge of this.clients) bridge.receive(message)
  }
}

const targetInfo = (tab: DesktopTab) => ({
  targetId: tab.id,
  type: "page",
  url: tab.url,
  title: tab.title,
  attached: true,
  canAccessOpener: false,
})

type Frame = { readonly id: number; readonly method: string; readonly params?: CdpParams; readonly sessionId?: string }

// One CdpClient's view of the desktop. Browser-level `Target.*` calls are answered locally from
// the shared tab list; page-level ones are forwarded with the tab id as CDP session id.
class Bridge implements CdpTransport {
  private readonly listeners = new Set<(message: string) => void>()
  private readonly closers = new Set<() => void>()
  private closed = false

  constructor(
    private readonly desktop: Desktop,
    private readonly tabs: Map<string, DesktopTab>,
    private readonly post: (message: Outbound) => void,
  ) {}

  send(message: string) {
    if (this.closed) return
    const frame = JSON.parse(message) as Frame
    const params = frame.params ?? {}
    if (frame.sessionId !== undefined) {
      this.post({ type: "cdp.send", id: frame.id, tabID: frame.sessionId, method: frame.method, params })
      return
    }
    switch (frame.method) {
      case "Browser.getVersion":
        return this.reply(frame.id, { product: "Electron", userAgent: this.desktop.userAgent })
      case "Browser.close":
      case "Target.setDiscoverTargets":
        return this.reply(frame.id, {})
      case "Target.setAutoAttach": {
        this.reply(frame.id, {})
        for (const tab of this.tabs.values()) this.attached(tab)
        return
      }
      case "Target.getTargets":
        return this.reply(frame.id, { targetInfos: [...this.tabs.values()].map(targetInfo) })
      case "Target.getTargetInfo": {
        const tab = this.tabs.get(String(params.targetId))
        if (!tab) return this.fail(frame.id, -32000, `No target with given id found: ${params.targetId}`)
        return this.reply(frame.id, { targetInfo: targetInfo(tab) })
      }
      case "Target.attachToTarget": {
        const tab = this.tabs.get(String(params.targetId))
        if (!tab) return this.fail(frame.id, -32000, `No target with given id found: ${params.targetId}`)
        this.attached(tab)
        return this.reply(frame.id, { sessionId: tab.id })
      }
      case "Target.createTarget":
        return this.post({ type: "tab.create", id: frame.id, url: String(params.url ?? "about:blank") })
      case "Target.closeTarget":
        return this.post({ type: "tab.close", id: frame.id, tabID: String(params.targetId) })
      case "Target.activateTarget":
        return this.post({ type: "tab.activate", id: frame.id, tabID: String(params.targetId) })
      default:
        return this.fail(frame.id, -32601, `${frame.method} is not available on the desktop provider`)
    }
  }

  onMessage(listener: (message: string) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onClose(listener: () => void) {
    this.closers.add(listener)
    return () => {
      this.closers.delete(listener)
    }
  }

  // Closing one client never closes the desktop socket; the desktop owns its views.
  close() {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closers) listener()
  }

  receive(message: Inbound) {
    if (message.type === "cdp.result") {
      if (message.error) return this.deliver({ id: message.id, error: message.error })
      return this.deliver({ id: message.id, result: message.result ?? {} })
    }
    if (message.type === "cdp.event") this.emit(message.method, message.params ?? {}, message.tabID)
  }

  attached(tab: DesktopTab) {
    this.emit("Target.attachedToTarget", { sessionId: tab.id, targetInfo: targetInfo(tab), waitingForDebugger: false })
  }

  emit(method: string, params: CdpParams, sessionId?: string) {
    this.deliver(sessionId === undefined ? { method, params } : { method, params, sessionId })
  }

  private reply(id: number, result: CdpParams) {
    queueMicrotask(() => this.deliver({ id, result }))
  }

  private fail(id: number, code: number, message: string) {
    queueMicrotask(() => this.deliver({ id, error: { code, message } }))
  }

  private deliver(message: Record<string, unknown>) {
    if (this.closed) return
    const raw = JSON.stringify(message)
    for (const listener of this.listeners) listener(raw)
  }
}
