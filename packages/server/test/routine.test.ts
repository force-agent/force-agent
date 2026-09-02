import { expect } from "bun:test"
import { Routine } from "@opencode-ai/schema/routine"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
import { InProcess } from "../src/in-process"

const Created = Schema.Struct({ data: Schema.Struct({ id: Routine.ID }) })

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make(
    {
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    },
    { grant: InProcess.grant() },
  )
  return (method: string, path: string, body?: unknown) =>
    Effect.promise(() =>
      handler(
        new Request(`http://opencode.local${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
    )
})

it.live("answers 404 for an update or delete of a routine that does not exist", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const id = Routine.ID.create()
    const updated = yield* request("PUT", `/api/routine/${id}`, { name: "x" })
    expect(updated.status).toBe(404)
    expect(yield* Effect.promise(() => updated.json())).toMatchObject({ _tag: "RoutineNotFoundError", routineID: id })
    const removed = yield* request("DELETE", `/api/routine/${id}`)
    expect(removed.status).toBe(404)
    expect(yield* Effect.promise(() => removed.json())).toMatchObject({ _tag: "RoutineNotFoundError", routineID: id })
  }).pipe(Effect.scoped),
)

it.live("deletes an existing routine with 204 and then 404 on a second delete", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* request("POST", "/api/routine", {
      name: "Nightly",
      agent: "build",
      schedule: "0 2 * * *",
      timezone: "UTC",
      prompt: "tidy up",
    })
    expect(created.status).toBe(200)
    const { data } = Schema.decodeUnknownSync(Created)(yield* Effect.promise(() => created.json()))
    expect((yield* request("DELETE", `/api/routine/${data.id}`)).status).toBe(204)
    expect((yield* request("DELETE", `/api/routine/${data.id}`)).status).toBe(404)
  }).pipe(Effect.scoped),
)
