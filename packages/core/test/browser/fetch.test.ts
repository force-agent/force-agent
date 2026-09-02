import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Browser } from "@opencode-ai/core/browser/session"
import { EVAL_LIMIT, pageEval } from "@opencode-ai/core/browser/fetch"
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
import { fakeCdp } from "./fake-cdp"

const chromium = resolveExecutable()

// A login page whose form posts with fetch, then reads `/api/me` the way a SPA would; both are
// the XHRs `browser_network` should see, and `/api/me` only answers with the cookie `/login` set.
const page = `<!doctype html><html><head><title>Login</title></head><body>
<main>
<h1>Sign in</h1>
<label for="name">Name</label><input id="name" name="name" type="text">
<button type="button" id="login">Login</button>
<p id="out">signed out</p>
<script>
document.getElementById("login").onclick = async () => {
  const name = document.getElementById("name").value
  await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: name }) })
  const me = await (await fetch("/api/me")).json()
  document.getElementById("out").textContent = "me:" + me.user
}
</script>
</main></body></html>`

let server: Server<undefined> | undefined
let base = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/login" && request.method === "POST") {
        const body = (await request.json()) as { user: string }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "set-cookie": `session=${body.user}; Path=/` },
        })
      }
      if (url.pathname === "/api/me") {
        const cookie = request.headers.get("cookie") ?? ""
        const user = cookie.match(/session=([^;]+)/)?.[1]
        if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
        return new Response(JSON.stringify({ user, echo: request.headers.get("x-probe") }), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server?.stop(true)
})

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp/labharness-browser-fetch-test") })),
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

describe.skipIf(chromium === undefined)("Browser page as endpoint", () => {
  it.live(
    "network captures the login XHRs and fetch replays /api/me with the page's cookie",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        yield* browser.navigate({ url: `${base}/` })
        const snapshot = yield* browser.snapshot({ mode: "interactive" })
        yield* browser.act({ action: "type", ref: ref(snapshot.tree, /textbox "Name"/), text: "alice" })
        const again = yield* browser.snapshot({ mode: "interactive" })
        yield* browser.act({ action: "click", ref: ref(again.tree, /button "Login"/) })

        // The click's fetches finish after `act` returns; wait for /api/me to land in the log.
        let me = yield* browser.network({ path: "/api/me", xhr: true })
        for (let attempt = 0; attempt < 50 && !me.entries.some((entry) => entry.status !== undefined); attempt++) {
          yield* Effect.sleep("100 millis")
          me = yield* browser.network({ path: "/api/me", xhr: true })
        }
        expect(me.entries).toHaveLength(1)
        expect(me.entries[0]).toMatchObject({ method: "GET", status: 200, type: "fetch", url: `${base}/api/me` })

        // Chromium also asks for /favicon.ico on its own; the page's requests are the rest.
        const all = (yield* browser.network({})).entries.filter((entry) => !entry.url.endsWith("/favicon.ico"))
        expect(all.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
          `GET ${base}/api/me`,
          `POST ${base}/login`,
          `GET ${base}/`,
        ])
        expect(all[2].type).toBe("document")
        const onlyXhr = yield* browser.network({ xhr: true })
        expect(onlyXhr.entries.map((entry) => entry.type)).toEqual(["fetch", "fetch"])

        const withBody = yield* browser.network({ body: me.entries[0].id })
        expect(withBody.body).toMatchObject({ id: me.entries[0].id, base64: false, truncated: false })
        expect(JSON.parse(withBody.body!.body)).toEqual({ user: "alice", echo: null })

        // Replay from inside the page: the session cookie rides along and custom headers apply.
        const replay = yield* browser.fetch({ url: "/api/me", headers: { "x-probe": "yes" } })
        expect(replay.status).toBe(200)
        expect(replay.url).toBe(`${base}/api/me`)
        expect(replay.headers["content-type"]).toBe("application/json")
        expect(JSON.parse(replay.body)).toEqual({ user: "alice", echo: "yes" })
        expect(replay.error).toBeUndefined()

        // Network failures come back as a readable error, not a thrown protocol error.
        const failed = yield* browser.fetch({ url: "http://127.0.0.1:9/unreachable", timeoutMs: 5_000 })
        expect(failed.status).toBe(0)
        expect(failed.error).toMatch(/fetch|Failed|Timed out/)
      }),
    40_000,
  )

  it.live(
    "eval returns JSON, accepts statement bodies, truncates huge results and reports exceptions",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        yield* browser.navigate({ url: `${base}/` })

        const title = yield* browser.evaluate({ expression: "document.title" })
        expect(JSON.parse(title.json)).toBe("Login")
        expect(title.truncated).toBe(false)

        const object = yield* browser.evaluate({ expression: "({ n: 1 + 1, items: [...document.querySelectorAll('button')].map(b => b.id) })" })
        expect(JSON.parse(object.json)).toEqual({ n: 2, items: ["login"] })

        const block = yield* browser.evaluate({ expression: "const a = await Promise.resolve(21); return a * 2" })
        expect(JSON.parse(block.json)).toBe(42)

        const nothing = yield* browser.evaluate({ expression: "undefined" })
        expect(nothing.json).toBe("null")

        const huge = yield* browser.evaluate({ expression: `"x".repeat(${EVAL_LIMIT * 2})` })
        expect(huge.truncated).toBe(true)
        expect(huge.json).toHaveLength(EVAL_LIMIT)

        const thrown = yield* browser.evaluate({ expression: "throw new Error('boom')" }).pipe(Effect.flip)
        expect(thrown._tag).toBe("Browser.ActionError")
        expect(thrown._tag === "Browser.ActionError" && thrown.message).toContain("boom")

        const syntax = yield* browser.evaluate({ expression: "this is not js" }).pipe(Effect.flip)
        expect(syntax._tag).toBe("Browser.ActionError")

        // A promise that never settles is cut by the page-side timeout, not left hanging.
        const hung = yield* browser.evaluate({ expression: "await new Promise(() => {})", timeoutMs: 1_000 }).pipe(Effect.flip)
        expect(hung._tag === "Browser.ActionError" && hung.message).toContain("Timed out after 1000 ms")
      }),
    40_000,
  )
})

// The scripts only use Function/Promise/JSON/setTimeout, so this fake runs them in Bun itself.
// `evaluations` counts the runs of the user's expression, not the parse probe that precedes it.
function evalCdp() {
  const cdp = fakeCdp(async (method, params) => {
    if (method !== "Runtime.evaluate") return undefined
    try {
      return { result: { value: await (0, eval)(String(params.expression)) } }
    } catch (error) {
      return { exceptionDetails: { exception: { description: String(error) } } }
    }
  })
  return {
    ...cdp,
    evaluations: () => cdp.sent.filter((item) => item.method === "Runtime.evaluate" && item.params.awaitPromise === true).length,
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __evalRuns: number | undefined
}

describe("pageEval (fake CDP)", () => {
  test("an expression executes once and is not compiled by running it", async () => {
    const cdp = evalCdp()
    globalThis.__evalRuns = 0
    const result = await pageEval(cdp.client, "s1", { expression: "globalThis.__evalRuns = globalThis.__evalRuns + 1" })
    expect(JSON.parse(result.json)).toBe(1)
    expect(globalThis.__evalRuns).toBe(1)
    expect(cdp.evaluations()).toBe(1)
    expect(cdp.sent.map((item) => item.method)).toEqual(["Runtime.evaluate", "Runtime.evaluate"])
  })

  test("a statement body that throws a SyntaxError at runtime runs exactly once", async () => {
    const cdp = evalCdp()
    globalThis.__evalRuns = 0
    await expect(
      pageEval(cdp.client, "s1", {
        expression: 'globalThis.__evalRuns = globalThis.__evalRuns + 1; throw new SyntaxError("x")',
      }),
    ).rejects.toThrow(/SyntaxError: x/)
    expect(globalThis.__evalRuns).toBe(1)
    expect(cdp.evaluations()).toBe(1)
  })

  test("a statement body with return is compiled as a block and evaluated once", async () => {
    const cdp = evalCdp()
    const result = await pageEval(cdp.client, "s1", { expression: "const a = await Promise.resolve(21); return a * 2" })
    expect(JSON.parse(result.json)).toBe(42)
    expect(cdp.evaluations()).toBe(1)
  })

  test("a promise that never settles fails with the page-side timeout", async () => {
    const cdp = evalCdp()
    await expect(pageEval(cdp.client, "s1", { expression: "await new Promise(() => {})", timeoutMs: 50 })).rejects.toThrow(
      "Timed out after 50 ms",
    )
    const sent = cdp.sent.find((item) => item.params.awaitPromise === true)
    expect(sent?.params.timeout).toBe(2_050)
  })
})
