import { Browser } from "@opencode-ai/schema/browser"
import { Schema } from "effect"
import type { CdpClient } from "./cdp/client.js"

export const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Browser.StreamInput))

// Windows virtual key codes Chromium needs for non-printable keys to act (Enter submits,
// Backspace deletes, arrows move). Printable keys derive theirs from the character.
const VIRTUAL_KEYS: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  Space: 32,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Insert: 45,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
}

const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const
const KEY_TYPES = { down: "keyDown", up: "keyUp", char: "char" } as const

// One panel input to its CDP command(s). Coordinates arrive in CSS px of the viewport.
export function dispatchInput(client: CdpClient, sessionId: string, input: Browser.StreamInput): Promise<unknown> {
  switch (input.type) {
    case "mouse":
      return client.send(
        "Input.dispatchMouseEvent",
        {
          type: MOUSE_TYPES[input.kind],
          x: input.x,
          y: input.y,
          button: input.button ?? (input.kind === "move" ? "none" : "left"),
          clickCount: input.clickCount ?? (input.kind === "move" ? 0 : 1),
          modifiers: input.modifiers ?? 0,
        },
        sessionId,
      )
    case "wheel":
      return client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: input.modifiers ?? 0,
        },
        sessionId,
      )
    case "key": {
      const printable = input.key.length === 1
      const text = input.text ?? (input.key === "Enter" ? "\r" : printable ? input.key : undefined)
      // Ctrl/Meta chords must not insert their letter; Alt and Shift still type.
      const chord = ((input.modifiers ?? 0) & 6) !== 0
      return client.send(
        "Input.dispatchKeyEvent",
        {
          type: KEY_TYPES[input.kind],
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode:
            VIRTUAL_KEYS[input.key] ??
            VIRTUAL_KEYS[input.code] ??
            (printable ? input.key.toUpperCase().charCodeAt(0) : 0),
          modifiers: input.modifiers ?? 0,
          ...(text !== undefined && !chord && input.kind !== "up" ? { text, unmodifiedText: text } : {}),
        },
        sessionId,
      )
    }
    case "paste":
      return client.send("Input.insertText", { text: input.text }, sessionId)
    case "resize":
      return client.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: Math.min(Math.max(input.width, 200), 4096),
          height: Math.min(Math.max(input.height, 150), 4096),
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId,
      )
  }
}
