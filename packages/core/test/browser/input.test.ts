import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { decode, dispatchInput } from "@opencode-ai/core/browser/input"
import { fakeCdp } from "./fake-cdp"

describe("browser input → CDP", () => {
  test("mouse events map to Input.dispatchMouseEvent with button defaults", async () => {
    const cdp = fakeCdp()
    await dispatchInput(cdp.client, "s1", { type: "mouse", kind: "move", x: 10, y: 20 })
    await dispatchInput(cdp.client, "s1", { type: "mouse", kind: "down", x: 10, y: 20, button: "right", clickCount: 2 })
    await dispatchInput(cdp.client, "s1", { type: "mouse", kind: "up", x: 10, y: 20 })
    expect(cdp.sent).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 10, y: 20, button: "none", clickCount: 0, modifiers: 0 },
        sessionId: "s1",
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 10, y: 20, button: "right", clickCount: 2, modifiers: 0 },
        sessionId: "s1",
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 },
        sessionId: "s1",
      },
    ])
  })

  test("wheel maps to mouseWheel", async () => {
    const cdp = fakeCdp()
    await dispatchInput(cdp.client, "s1", { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 120 })
    expect(cdp.sent[0]).toEqual({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 120, modifiers: 0 },
      sessionId: "s1",
    })
  })

  test("keys carry text for printable keys and virtual key codes for special ones", async () => {
    const cdp = fakeCdp()
    await dispatchInput(cdp.client, "s1", { type: "key", kind: "down", key: "a", code: "KeyA" })
    await dispatchInput(cdp.client, "s1", { type: "key", kind: "up", key: "a", code: "KeyA" })
    await dispatchInput(cdp.client, "s1", { type: "key", kind: "down", key: "Enter", code: "Enter" })
    await dispatchInput(cdp.client, "s1", { type: "key", kind: "down", key: "a", code: "KeyA", modifiers: 2 })
    await dispatchInput(cdp.client, "s1", { type: "key", kind: "char", key: "é", code: "", text: "é" })
    expect(cdp.sent.map((item) => item.params)).toEqual([
      {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 0,
        text: "a",
        unmodifiedText: "a",
      },
      { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0 },
      {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        modifiers: 0,
        text: "\r",
        unmodifiedText: "\r",
      },
      // Ctrl+A selects all; it must not insert an "a".
      { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
      { type: "char", key: "é", code: "", windowsVirtualKeyCode: 201, modifiers: 0, text: "é", unmodifiedText: "é" },
    ])
    expect(cdp.sent.every((item) => item.method === "Input.dispatchKeyEvent")).toBe(true)
  })

  test("paste inserts text and resize overrides device metrics", async () => {
    const cdp = fakeCdp()
    await dispatchInput(cdp.client, "s1", { type: "paste", text: "hello" })
    await dispatchInput(cdp.client, "s1", { type: "resize", width: 900, height: 600 })
    expect(cdp.sent).toEqual([
      { method: "Input.insertText", params: { text: "hello" }, sessionId: "s1" },
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: { width: 900, height: 600, deviceScaleFactor: 1, mobile: false },
        sessionId: "s1",
      },
    ])
  })

  test("decode accepts the JSON wire format and rejects junk", () => {
    const ok = decode(JSON.stringify({ type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 5 }))
    expect(Option.isSome(ok) && ok.value.type).toBe("wheel")
    expect(Option.isNone(decode(JSON.stringify({ type: "mouse", kind: "fly", x: 1, y: 2 })))).toBe(true)
    expect(Option.isNone(decode("not json"))).toBe(true)
  })
})
