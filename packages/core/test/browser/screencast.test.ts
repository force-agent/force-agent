import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Browser } from "@opencode-ai/core/browser/session"
import { resolveExecutable } from "@opencode-ai/core/browser/provider/launched"
import { OPTIONS, Screencasts, type Frame } from "@opencode-ai/core/browser/screencast"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tempGlobalLayer } from "../fixture/global"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { fakeCdp } from "./fake-cdp"

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const metadata = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 1280,
  deviceHeight: 800,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
  timestamp: 1,
}

describe("Screencasts (fake CDP)", () => {
  test("starts on the first subscriber and stops on the last", async () => {
    const cdp = fakeCdp()
    const casts = new Screencasts(cdp.client)
    const stopA = casts.subscribe("tab1", "s1", () => {})
    const stopB = casts.subscribe("tab1", "s1", () => {})
    await flush()
    expect(cdp.sent.filter((item) => item.method === "Page.startScreencast")).toEqual([
      { method: "Page.startScreencast", params: OPTIONS, sessionId: "s1" },
    ])
    expect(casts.active("tab1")).toBe(true)

    stopA()
    await flush()
    expect(cdp.sent.some((item) => item.method === "Page.stopScreencast")).toBe(false)
    stopA()
    stopB()
    await flush()
    expect(cdp.sent.filter((item) => item.method === "Page.stopScreencast")).toHaveLength(1)
    expect(casts.active("tab1")).toBe(false)
    expect(casts.any()).toBe(false)
  })

  test("acks every frame and delivers decoded bytes to subscribers of that tab", async () => {
    const cdp = fakeCdp()
    const casts = new Screencasts(cdp.client)
    const frames: Frame[] = []
    casts.subscribe("tab1", "s1", (frame) => frames.push(frame))
    await flush()

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    cdp.emit("Page.screencastFrame", { data: jpeg.toString("base64"), metadata, sessionId: 7 }, "s1")
    cdp.emit("Page.screencastFrame", { data: jpeg.toString("base64"), metadata, sessionId: 8 }, "other")
    await flush()

    const acks = cdp.sent.filter((item) => item.method === "Page.screencastFrameAck")
    expect(acks).toEqual([
      { method: "Page.screencastFrameAck", params: { sessionId: 7 }, sessionId: "s1" },
      { method: "Page.screencastFrameAck", params: { sessionId: 8 }, sessionId: "other" },
    ])
    expect(frames).toHaveLength(1)
    expect(frames[0].tabID).toBe("tab1")
    expect(Array.from(frames[0].data)).toEqual([0xff, 0xd8, 0xff, 0xd9])
    expect(frames[0].metadata.deviceWidth).toBe(1280)
  })
})

const chromium = resolveExecutable()

const page = `<!doctype html><html><head><title>Stream</title></head><body style="margin:0">
<input id="name" style="position:absolute;left:10px;top:10px;width:200px;height:30px">
<p id="out"></p>
<script>document.getElementById('name').addEventListener('input', (e) => { document.getElementById('out').textContent = 'typed:' + e.target.value })</script>
</body></html>`

let server: Server<undefined> | undefined
let base = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server?.stop(true)
})

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp/labharness-browser-stream-test") })),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Browser.node]), [
    [Location.node, locationLayer],
    [Global.node, tempGlobalLayer],
  ]),
)

describe.skipIf(chromium === undefined)("Browser stream (Chromium)", () => {
  it.live(
    "streams frames while subscribed and human input types into the page",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const opened = yield* browser.navigate({ url: `${base}/` })

        const frames: Frame[] = []
        const stop = yield* browser.stream(opened.tab, (frame) => frames.push(frame))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1500)))
        expect(frames.length).toBeGreaterThan(0)
        expect(frames[0].data[0]).toBe(0xff)
        expect(frames[0].metadata.deviceWidth).toBeGreaterThan(0)

        // Click into the input through the canvas coordinates and type: control flips to human.
        yield* browser.input(opened.tab, { type: "mouse", kind: "move", x: 50, y: 25 })
        yield* browser.input(opened.tab, { type: "mouse", kind: "down", x: 50, y: 25, button: "left" })
        yield* browser.input(opened.tab, { type: "mouse", kind: "up", x: 50, y: 25, button: "left" })
        yield* browser.input(opened.tab, { type: "key", kind: "down", key: "h", code: "KeyH" })
        yield* browser.input(opened.tab, { type: "key", kind: "up", key: "h", code: "KeyH" })
        yield* browser.input(opened.tab, { type: "paste", text: "ey" })
        expect((yield* browser.state()).control).toBe("human")

        const blocked = yield* browser.snapshot({}).pipe(Effect.flip)
        expect(blocked._tag).toBe("Browser.ControlError")
        yield* browser.control({ owner: "release" })
        const read = yield* browser.read({})
        expect(read.markdown).toContain("typed:hey")

        stop()
      }),
    30_000,
  )
})
