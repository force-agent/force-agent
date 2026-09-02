import type { Readable, Writable } from "node:stream"
import type { CdpTransport } from "./transport.js"

// `--remote-debugging-pipe`: Chromium reads JSON frames from fd 3 and writes them to fd 4, each
// terminated by a NUL byte. Verified with `node:child_process.spawn` under Bun 1.4 (extra `pipe`
// entries in `stdio` become Socket streams); `Bun.spawn` only hands back raw fd numbers.
export function pipeTransport(input: Writable, output: Readable): CdpTransport {
  const messages = new Set<(message: string) => void>()
  const closers = new Set<() => void>()
  let buffer = ""
  output.setEncoding("utf8")
  output.on("data", (chunk: string) => {
    buffer += chunk
    while (true) {
      const end = buffer.indexOf("\0")
      if (end === -1) return
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      for (const listener of messages) listener(frame)
    }
  })
  const closed = () => {
    for (const listener of closers) listener()
  }
  output.on("close", closed)
  output.on("error", closed)
  return {
    send: (message) => {
      input.write(message + "\0")
    },
    onMessage: (listener) => {
      messages.add(listener)
      return () => messages.delete(listener)
    },
    onClose: (listener) => {
      closers.add(listener)
      return () => closers.delete(listener)
    },
    close: () => {
      input.end()
    },
  }
}
