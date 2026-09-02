import type { OpenCodeClient } from "@opencode-ai/client/promise"

// Wire types of `GET /api/browser/tabs/:tabID/stream`. Server → client: binary message = one
// JSON header line + JPEG bytes. Client → server: JSON text message with one input event.
export type FrameHeader = {
  readonly tab: string
  readonly offsetTop: number
  readonly pageScaleFactor: number
  readonly deviceWidth: number
  readonly deviceHeight: number
  readonly scrollOffsetX: number
  readonly scrollOffsetY: number
  readonly timestamp?: number
}

export type StreamInput =
  | {
      readonly type: "mouse"
      readonly kind: "move" | "down" | "up"
      readonly x: number
      readonly y: number
      readonly button?: "none" | "left" | "middle" | "right"
      readonly clickCount?: number
      readonly modifiers?: number
    }
  | {
      readonly type: "wheel"
      readonly x: number
      readonly y: number
      readonly deltaX: number
      readonly deltaY: number
      readonly modifiers?: number
    }
  | {
      readonly type: "key"
      readonly kind: "down" | "up" | "char"
      readonly key: string
      readonly code: string
      readonly text?: string
      readonly modifiers?: number
    }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }

const decoder = new TextDecoder()

export function parseFrame(data: ArrayBuffer): { header: FrameHeader; image: Blob } | undefined {
  const bytes = new Uint8Array(data)
  const newline = bytes.indexOf(0x0a)
  if (newline <= 0) return undefined
  try {
    const header = JSON.parse(decoder.decode(bytes.subarray(0, newline))) as FrameHeader
    return { header, image: new Blob([bytes.subarray(newline + 1)], { type: "image/jpeg" }) }
  } catch {
    return undefined
  }
}

// CDP modifier mask: Alt=1, Ctrl=2, Meta=4, Shift=8.
export function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

// Same flow as the PTY client: mint a ticket over the authenticated API, then open the socket
// with it in the query string, since browsers cannot set headers on an upgrade.
export async function openStream(
  sdk: { readonly api: OpenCodeClient; readonly url: string },
  input: { readonly tabID: string; readonly directory: string },
) {
  const result = await sdk.api.browser.tab.ticket({
    tabID: input.tabID,
    location: { directory: input.directory },
    "x-opencode-ticket": "1",
  })
  const url = new URL(`/api/browser/tabs/${encodeURIComponent(input.tabID)}/stream`, sdk.url)
  url.searchParams.set("location[directory]", input.directory)
  url.searchParams.set("ticket", result.data.ticket)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  return socket
}
