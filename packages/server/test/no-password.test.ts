import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { ServerFetch } from "../src/fetch"
import { createRoutes } from "../src/routes"

// power-agent overlay regression guard: upstream fell back to an unauthenticated
// route graph when no password was threaded through. Forgetting the password is
// now a defect at layer-build time, so no listener can ever be served by a graph
// that skips Basic auth.
const refusal = /Refusing to build server routes without a password/

function defect(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? String(exit.cause) : ""
}

describe("a route graph without a password", () => {
  test("createRoutes dies instead of building an open server", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(createRoutes({}).pipe(Layer.provide(HttpServer.layerServices)))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(defect(exit)).toMatch(refusal)
  })

  test("ServerFetch.make dies without either a password or an in-process grant", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(ServerFetch.make({})))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(defect(exit)).toMatch(refusal)
  })
})
