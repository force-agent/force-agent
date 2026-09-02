import fs from "node:fs"
import type { Browser } from "@opencode-ai/schema/browser"
import type { CdpClient } from "./cdp/client.js"

export type Target = {
  readonly client: CdpClient
  readonly sessionId: string
  readonly refs: ReadonlyMap<string, number>
}

export class RefNotFoundError extends Error {
  constructor(readonly ref: string) {
    super(`Unknown ref ${ref}; take a new browser_snapshot and retry with a current ref`)
    this.name = "BrowserRefNotFoundError"
  }
}

export class PasswordRefusedError extends Error {
  constructor() {
    super("Typing into a password field is refused; use browser_handoff so the person can enter it")
    this.name = "BrowserPasswordRefusedError"
  }
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
}

const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }

export async function act(target: Target, input: Browser.ActInput): Promise<void> {
  switch (input.action) {
    case "click": {
      const point = await center(target, requireRef(target, input.ref))
      await mouse(target, "mouseMoved", point)
      await mouse(target, "mousePressed", point, { button: "left", clickCount: 1 })
      await mouse(target, "mouseReleased", point, { button: "left", clickCount: 1 })
      return
    }
    case "hover": {
      await mouse(target, "mouseMoved", await center(target, requireRef(target, input.ref)))
      return
    }
    case "type": {
      const backendNodeId = requireRef(target, input.ref)
      await refusePassword(target, backendNodeId)
      await target.client.send("DOM.focus", { backendNodeId }, target.sessionId)
      // Replace the current value: select-all on inputs and textareas, no-op elsewhere.
      await callOn(target, backendNodeId, "function(){ if (typeof this.select === 'function') this.select() }")
      await target.client.send("Input.insertText", { text: input.text ?? "" }, target.sessionId)
      return
    }
    case "press": {
      if (input.ref !== undefined)
        await target.client.send("DOM.focus", { backendNodeId: requireRef(target, input.ref) }, target.sessionId)
      await press(target, input.key ?? "Enter")
      return
    }
    case "select": {
      const backendNodeId = requireRef(target, input.ref)
      const result = await callOn(
        target,
        backendNodeId,
        `function(value){
          const options = Array.from(this.options ?? [])
          const option = options.find((o) => o.value === value || o.label === value || o.textContent.trim() === value)
          if (!option) return false
          this.value = option.value
          this.dispatchEvent(new Event("input", { bubbles: true }))
          this.dispatchEvent(new Event("change", { bubbles: true }))
          return true
        }`,
        [input.value ?? input.text ?? ""],
      )
      if (result !== true) throw new Error(`Option not found in ${input.ref}: ${input.value ?? input.text}`)
      return
    }
    case "scroll": {
      const point =
        input.ref === undefined ? await viewportCenter(target) : await center(target, requireRef(target, input.ref))
      await mouse(target, "mouseWheel", point, { deltaX: 0, deltaY: input.deltaY ?? 600 })
      return
    }
    case "upload": {
      const files = input.files ?? []
      const missing = files.find((file) => !fs.existsSync(file))
      if (missing !== undefined) throw new Error(`File not found: ${missing}`)
      await target.client.send(
        "DOM.setFileInputFiles",
        { backendNodeId: requireRef(target, input.ref), files: [...files] },
        target.sessionId,
      )
      return
    }
  }
}

function requireRef(target: Target, ref: string | undefined) {
  if (ref === undefined) throw new Error("This action needs a ref from browser_snapshot")
  const backendNodeId = target.refs.get(ref)
  if (backendNodeId === undefined) throw new RefNotFoundError(ref)
  return backendNodeId
}

async function refusePassword(target: Target, backendNodeId: number) {
  const described = await target.client.send<{ node: { attributes?: string[] } }>(
    "DOM.describeNode",
    { backendNodeId },
    target.sessionId,
  )
  const attributes = described.node.attributes ?? []
  const attribute = (name: string) => {
    const index = attributes.findIndex((item, position) => position % 2 === 0 && item.toLowerCase() === name)
    return index === -1 ? undefined : attributes[index + 1]?.toLowerCase()
  }
  if (attribute("type") === "password" || attribute("autocomplete")?.includes("password"))
    throw new PasswordRefusedError()
}

async function center(target: Target, backendNodeId: number) {
  await target.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, target.sessionId).catch(() => undefined)
  const box = await target.client.send<{ model: { content: number[] } }>(
    "DOM.getBoxModel",
    { backendNodeId },
    target.sessionId,
  )
  const quad = box.model.content
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  }
}

async function viewportCenter(target: Target) {
  const metrics = await target.client.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(
    "Page.getLayoutMetrics",
    {},
    target.sessionId,
  )
  return { x: metrics.cssVisualViewport.clientWidth / 2, y: metrics.cssVisualViewport.clientHeight / 2 }
}

function mouse(target: Target, type: string, point: { x: number; y: number }, extra: Record<string, unknown> = {}) {
  return target.client.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra }, target.sessionId)
}

async function press(target: Target, combo: string) {
  const parts = combo.split("+")
  const key = parts.at(-1) ?? "Enter"
  const modifiers = parts.slice(0, -1).reduce((mask, name) => mask | (MODIFIERS[name] ?? 0), 0)
  const known = KEYS[key]
  const single = key.length === 1
  const event = {
    modifiers,
    key: known ? key : single ? key : key,
    code: known?.code ?? (single ? `Key${key.toUpperCase()}` : key),
    windowsVirtualKeyCode: known?.keyCode ?? (single ? key.toUpperCase().charCodeAt(0) : 0),
    ...(known?.text !== undefined ? { text: known.text } : single && modifiers === 0 ? { text: key } : {}),
  }
  await target.client.send("Input.dispatchKeyEvent", { type: "keyDown", ...event }, target.sessionId)
  await target.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...event }, target.sessionId)
}

async function callOn(target: Target, backendNodeId: number, functionDeclaration: string, args: unknown[] = []) {
  const resolved = await target.client.send<{ object: { objectId: string } }>(
    "DOM.resolveNode",
    { backendNodeId },
    target.sessionId,
  )
  const result = await target.client.send<{ result: { value?: unknown } }>(
    "Runtime.callFunctionOn",
    {
      objectId: resolved.object.objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    },
    target.sessionId,
  )
  return result.result.value
}
