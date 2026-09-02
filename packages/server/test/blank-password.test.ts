import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"
import { createRoutes } from "../src/routes"

// power-agent overlay regression guard. The CLI already refuses a blank
// POWER_PASSWORD, but `createRoutes`/`ServerProcess.start` were still deciding
// by truthiness, so an embedder calling them directly with a password of "   "
// got a server "protected" by a space — the exact hole ServerAuth.usable()
// exists to close. Both entry points now ask usable() instead.
const refusal = /Refusing to build server routes without a password/
const missing = /Missing server password/

function cause(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? String(exit.cause) : ""
}

const blank = ["", "   ", "\t", "\n"]

describe("a blank server password", () => {
  for (const password of blank) {
    const label = JSON.stringify(password)

    test(`createRoutes(${label}) dies instead of building an open server`, async () => {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(Layer.build(createRoutes({ password }).pipe(Layer.provide(HttpServer.layerServices)))),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(cause(exit)).toMatch(refusal)
    })

    test(`ServerProcess.start(${label}) never reaches a listener`, async () => {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          ServerProcess.start<never, never>({
            hostname: "127.0.0.1",
            port: 0,
            password,
            database: { path: ":memory:" },
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(cause(exit)).toMatch(missing)
    })
  }
})

// A secret that survives usable() is used byte-for-byte: padding is part of the
// credential, not noise to be stripped, or every client already holding the
// exported value would stop authenticating.
it.live("a real password still authenticates, untrimmed", () =>
  Effect.gen(function* () {
    const password = " secret "
    const server = yield* ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password,
      app: { version: "test-version" },
      database: { path: ":memory:" },
    })
    const health = new URL("/api/health", HttpServer.formatAddress(server.address))
    const get = (headers: Record<string, string>) => Effect.promise(() => fetch(health, { headers }))

    const authorized = yield* get({ authorization: `Basic ${btoa(`opencode:${password}`)}` })
    expect(authorized.status).toBe(200)
    expect(yield* Effect.promise(() => authorized.json())).toMatchObject({ version: "test-version" })

    const trimmed = yield* get({ authorization: `Basic ${btoa(`opencode:${password.trim()}`)}` })
    expect(trimmed.status).toBe(401)

    const anonymous = yield* get({})
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
  }),
)
