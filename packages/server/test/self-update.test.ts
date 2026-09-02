import { expect } from "bun:test"
import { SelfUpdate } from "@opencode-ai/core/self-update"
import { LayerNodePlatform } from "@opencode-ai/util/effect/app-node-platform"
import { Deferred, Effect, Layer, Ref, Schedule } from "effect"
import { HttpClient, HttpClientResponse, HttpServer } from "effect/unstable/http"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"
import { startServer } from "./fixture/server"

const headers = { authorization: `Basic ${btoa("opencode:secret")}` }

const registry = (status: number, body: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })))),
  )

const startWith = Effect.fnUntraced(function* (
  directory: string,
  applier: SelfUpdate.Applier,
  registryStatus = 200,
  registryBody = JSON.stringify({ version: "9.9.9" }),
) {
  const server = yield* ServerProcess.start<never, never>(
    {
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "1.0.0" },
      database: { path: ":memory:" },
      config: { directory },
      fs: { filewatcher: false },
    },
    undefined,
    undefined,
    [
      [SelfUpdate.node, SelfUpdate.configured({ applier })],
      [LayerNodePlatform.httpClient, registry(registryStatus, registryBody)],
    ],
  )
  return HttpServer.formatAddress(server.address)
})

const get = (base: string, refresh = false) =>
  Effect.promise(() => fetch(new URL(refresh ? "/api/update?refresh=true" : "/api/update", base), { headers }))

const apply = (base: string, body: object = {}) =>
  Effect.promise(() =>
    fetch(new URL("/api/update/apply", base), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

it.live("requires credentials and reports a disabled updater without an applier", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-self-update-")))
    const server = yield* startServer(tmp.path)

    const anonymous = yield* Effect.promise(() => fetch(new URL("/api/update", server.base)))
    expect(anonymous.status).toBe(401)

    const status = yield* Effect.promise(() =>
      fetch(new URL("/api/update", server.base), { headers: server.headers }).then((response) => response.json()),
    )
    expect(status).toMatchObject({
      current: "test-version",
      available: false,
      manager: "unknown",
      canApply: false,
      reason: "disabled",
      phase: { type: "idle" },
    })

    const rejected = yield* Effect.promise(() =>
      fetch(new URL("/api/update/apply", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(rejected.status).toBe(400)
  }),
)

it.live("accepts one apply with 202, refuses the second with 409, and reaches restarting", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-self-update-")))
    const gate = yield* Deferred.make<void>()
    const restarted = yield* Ref.make<string[]>([])
    const base = yield* startWith(tmp.path, {
      detect: () => Effect.succeed({ manager: "npm", canApply: true }),
      install: () => Deferred.await(gate),
      restart: (version) => Ref.update(restarted, (list) => [...list, version]),
    })

    const checked = yield* get(base, true)
    expect(checked.status).toBe(200)
    expect(yield* Effect.promise(() => checked.json())).toMatchObject({
      current: "1.0.0",
      latest: "9.9.9",
      available: true,
      canApply: true,
      manager: "npm",
    })

    const stale = yield* apply(base, { version: "1.0.0" })
    expect(stale.status).toBe(400)

    const accepted = yield* apply(base)
    expect(accepted.status).toBe(202)
    expect(yield* Effect.promise(() => accepted.json())).toMatchObject({
      phase: { type: "installing", version: "9.9.9" },
    })

    const busy = yield* apply(base)
    expect(busy.status).toBe(409)

    yield* Deferred.succeed(gate, undefined)
    const restarting = yield* get(base).pipe(
      Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<{ phase: { type: string } }>)),
      Effect.repeat({ until: (status) => status.phase.type === "restarting", schedule: Schedule.spaced("10 millis") }),
    )
    expect(restarting.phase).toMatchObject({ type: "restarting", version: "9.9.9", pid: process.pid })
    expect(yield* Ref.get(restarted)).toEqual(["9.9.9"])
  }),
)

it.live("answers 503 when the latest version cannot be determined", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-self-update-")))
    const base = yield* startWith(
      tmp.path,
      {
        detect: () => Effect.succeed({ manager: "npm", canApply: true }),
        install: () => Effect.void,
        restart: () => Effect.void,
      },
      500,
      "registry down",
    )
    const failed = yield* apply(base)
    expect(failed.status).toBe(503)
    const status = yield* get(base).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())))
    expect(status).toMatchObject({ available: false, phase: { type: "error" } })
  }),
)
