import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Browser } from "@opencode-ai/core/browser/session"
import { resolveExecutable } from "@opencode-ai/core/browser/provider/launched"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tempGlobalLayer } from "../fixture/global"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const chromium = resolveExecutable()

const page = `<!doctype html><html><head><title>Fixture</title></head><body>
<main>
<h1>Login form</h1>
<form>
<label for="name">Name</label><input id="name" name="name" type="text">
<label for="pw">Password</label><input id="pw" name="pw" type="password">
<label for="color">Color</label>
<select id="color"><option value="r">Red</option><option value="b">Blue</option></select>
<button type="button" id="go" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('name').value+':'+document.getElementById('color').value">Go</button>
<a href="/second">Second page</a>
<p id="out">idle</p>
</form>
</main></body></html>`

const second = `<!doctype html><html><head><title>Second</title></head><body><main><h1>Second heading</h1><p>Arrived.</p></main></body></html>`

let server: Server<undefined> | undefined
let base = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const html = new URL(request.url).pathname === "/second" ? second : page
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server?.stop(true)
})

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp/labharness-browser-test") })),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Browser.node]), [
    [Location.node, locationLayer],
    [Global.node, tempGlobalLayer],
  ]),
)

const ref = (tree: string, pattern: RegExp) => {
  const line = tree.split("\n").find((item) => pattern.test(item))
  const match = line?.match(/\[ref=(e\d+)\]/)
  if (!match) throw new Error(`No ref for ${pattern} in:\n${tree}`)
  return match[1]
}

describe.skipIf(chromium === undefined)("Browser", () => {
  test("a Chromium binary is resolvable", () => {
    expect(chromium).toBeDefined()
  })

  it.live(
    "navigate returns a snapshot with refs, act drives the form, read returns markdown",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service

        const opened = yield* browser.navigate({ url: `${base}/` })
        expect(opened.title).toBe("Fixture")
        expect(opened.tree).toMatch(/textbox "Name" \[ref=e\d+\]/)
        expect(opened.tree).toMatch(/button "Go" \[ref=e\d+\]/)
        expect(opened.tree).toMatch(/link "Second page" \[ref=e\d+\]/)

        const full = yield* browser.snapshot({ mode: "full" })
        const name = ref(full.tree, /textbox "Name"/)
        yield* browser.act({ action: "type", ref: name, text: "hello" })

        const afterType = yield* browser.snapshot({ mode: "interactive" })
        expect(afterType.tree).toMatch(/textbox "Name" value="hello"/)
        yield* browser.act({ action: "select", ref: ref(afterType.tree, /combobox "Color"/), value: "Blue" })

        const beforeClick = yield* browser.snapshot({ mode: "full" })
        const clicked = yield* browser.act({ action: "click", ref: ref(beforeClick.tree, /button "Go"/) })
        expect(clicked.diff).toContain("clicked:hello:b")

        const read = yield* browser.read({})
        expect(read.markdown).toContain("Login form")
        expect(read.markdown).toContain("clicked:hello:b")
        expect(read.pages).toBe(1)

        const shot = yield* browser.screenshot({})
        expect(shot.mime).toBe("image/jpeg")
        expect(shot.base64.length).toBeGreaterThan(100)

        const state = yield* browser.state()
        expect(state.running).toBe(true)
        expect(state.control).toBe("idle")
        expect(state.tabs).toHaveLength(1)
      }),
    30_000,
  )

  it.live(
    "refuses to type into a password field",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        yield* browser.navigate({ url: `${base}/` })
        const snapshot = yield* browser.snapshot({ mode: "interactive" })
        const password = ref(snapshot.tree, /textbox "Password"/)
        const result = yield* browser.act({ action: "type", ref: password, text: "secret" }).pipe(Effect.flip)
        expect(result._tag).toBe("Browser.ActionError")
        expect(result._tag === "Browser.ActionError" && result.message).toMatch(/password/i)
      }),
    30_000,
  )

  it.live(
    "clicking a link navigates and the diff shows the new page",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        yield* browser.navigate({ url: `${base}/` })
        const snapshot = yield* browser.snapshot({})
        const result = yield* browser.act({ action: "click", ref: ref(snapshot.tree, /link "Second page"/) })
        expect(result.url).toBe(`${base}/second`)
        expect(result.diff).toContain('heading "Second heading')
        const stale = yield* browser.act({ action: "click", ref: "e999" }).pipe(Effect.flip)
        expect(stale._tag).toBe("Browser.ActionError")
      }),
    30_000,
  )

  it.live(
    "human control blocks agent actions until released; handoff completes on release",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        yield* browser.navigate({ url: `${base}/` })
        const taken = yield* browser.control({ owner: "human" })
        expect(taken.control).toBe("human")
        const blocked = yield* browser.snapshot({}).pipe(Effect.flip)
        expect(blocked._tag).toBe("Browser.ControlError")
        const released = yield* browser.control({ owner: "release" })
        expect(released.control).toBe("idle")

        const fiber = yield* browser.handoff({ reason: "log in", timeoutSec: 20 }).pipe(Effect.forkScoped)
        yield* Effect.sleep("300 millis")
        expect((yield* browser.state()).control).toBe("handoff-login")
        yield* browser.control({ owner: "release" })
        const result = yield* Fiber.join(fiber)
        expect(result.completed).toBe(true)
        expect((yield* browser.state()).control).toBe("idle")
      }),
    30_000,
  )

  it.live(
    "tabs open, activate and close",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const first = yield* browser.navigate({ url: `${base}/` })
        const tab = yield* browser.open({ url: `${base}/second` })
        expect(tab.id).not.toBe(first.tab)
        expect((yield* browser.state()).tabs).toHaveLength(2)
        const activated = yield* browser.activate(first.tab)
        expect(activated.active).toBe(true)
        yield* browser.close(tab.id)
        expect((yield* browser.state()).tabs.map((item) => item.id)).toEqual([first.tab])
        const missing = yield* browser.close(tab.id).pipe(Effect.flip)
        expect(missing._tag).toBe("Browser.TabNotFoundError")
      }),
    30_000,
  )
})
