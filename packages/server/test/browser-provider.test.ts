import { expect } from "bun:test"
import { Effect } from "effect"
import { locationKey, select } from "@opencode-ai/core/browser/provider/index"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const until = (check: () => boolean, ms = 3_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error("condition not met in time")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })

// The desktop says hello the moment its socket opens, which is before the handler has awaited
// anything: the attach must already be listening (or the message queued for it) or the
// handshake times out and the desktop backs off forever.
it.live(
  "attaches a desktop whose hello arrives as soon as the socket opens",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("labharness-browser-provider-")))
      const server = yield* startServer(tmp.path)
      const key = locationKey({ directory: AbsolutePath.make(tmp.path), workspaceID: undefined })
      expect(select(key).kind).toBe("launched")

      const url = new URL("/api/browser/provider", server.base)
      url.protocol = "ws:"
      url.searchParams.set("location[directory]", tmp.path)
      url.searchParams.set("auth_token", btoa("opencode:secret"))
      const socket = new WebSocket(url)
      const closes: number[] = []
      socket.addEventListener("close", (event) => closes.push(event.code))
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => {
              socket.send(JSON.stringify({ type: "hello", profile: "test", userAgent: "Mozilla/5.0 Chrome/140.0", tabs: [] }))
              resolve()
            })
            socket.addEventListener("error", () => reject(new Error("provider socket did not connect")))
          }),
      )
      yield* until(() => select(key).kind === "desktop")
      expect(closes).toEqual([])

      socket.close(1000)
      yield* until(() => select(key).kind === "launched")
    }),
  15_000,
)
