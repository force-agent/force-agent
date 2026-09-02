import type { CdpTransport } from "./transport.js"

// Fallback wire for `--remote-debugging-port=0`: the browser-level DevTools WebSocket read from
// `<user-data-dir>/DevToolsActivePort`. Uses the runtime's global WebSocket (Bun and Node 22+).
export function websocketTransport(url: string): Promise<CdpTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const messages = new Set<(message: string) => void>()
    const closers = new Set<() => void>()
    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : undefined
      if (data === undefined) return
      for (const listener of messages) listener(data)
    })
    socket.addEventListener("close", () => {
      for (const listener of closers) listener()
    })
    socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${url}`)), { once: true })
    socket.addEventListener(
      "open",
      () =>
        resolve({
          send: (message) => socket.send(message),
          onMessage: (listener) => {
            messages.add(listener)
            return () => messages.delete(listener)
          },
          onClose: (listener) => {
            closers.add(listener)
            return () => closers.delete(listener)
          },
          close: () => socket.close(),
        }),
      { once: true },
    )
  })
}
