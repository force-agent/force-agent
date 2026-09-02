import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { Routine } from "@opencode-ai/core/routine"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Agent } from "@opencode-ai/schema/agent"
import type { Event } from "@opencode-ai/schema/event"
import { Model } from "@opencode-ai/schema/model"
import { Project } from "@opencode-ai/schema/project"
import { Provider } from "@opencode-ai/schema/provider"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionID } from "@opencode-ai/schema/session-id"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_routine_test")
const started = new Array<Routine.Info>()
let failure: string | undefined
/** What the stub does when the prompt is admitted; lets a test settle the execution before `prompt` returns. */
let prompted: ((sessionID: SessionID) => Effect.Effect<void>) | undefined
const runner = Layer.succeed(
  Routine.Runner,
  Routine.Runner.of({
    create: (routine) =>
      Effect.suspend(() => {
        started.push(routine)
        return failure ? Effect.fail(new Error(failure)) : Effect.succeed(sessionID)
      }),
    prompt: (_, sessionID) => Effect.suspend(() => prompted?.(sessionID) ?? Effect.void),
  }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([Routine.node, Bus.node, Database.node]), [[Routine.runnerNode, runner]]),
)

const directory = AbsolutePath.make("/tmp/routine-test")
const base = {
  projectID: Project.ID.global,
  directory,
  agent: Agent.ID.make("build"),
  name: "Daily summary",
  schedule: "0 9 * * *",
  timezone: "America/Sao_Paulo",
  prompt: "Summarise new leads",
}

describe("Routine service", () => {
  it.effect("creates, lists by directory, updates and removes", () =>
    Effect.gen(function* () {
      const routines = yield* Routine.Service
      const created = yield* routines.create(base)
      expect(created.enabled).toBe(true)
      expect(created.nextRunAt).toBeGreaterThan(Date.now())
      expect(yield* routines.list({ directory })).toEqual([created])
      expect(yield* routines.list({ directory: AbsolutePath.make("/tmp/elsewhere") })).toEqual([])

      const updated = yield* routines.update(created.id, { name: "Renamed", enabled: false })
      expect(updated.name).toBe("Renamed")
      expect(updated.nextRunAt).toBeUndefined()

      const enabled = yield* routines.update(created.id, { enabled: true, schedule: "*/15 * * * *" })
      expect(enabled.schedule).toBe("*/15 * * * *")
      expect(enabled.nextRunAt).toBeGreaterThan(Date.now())
      expect(enabled.nextRunAt! - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000)

      yield* routines.remove(created.id)
      expect(yield* routines.get(created.id)).toBeUndefined()
      expect(yield* routines.list({ directory })).toEqual([])
      const missing = yield* routines.remove(created.id).pipe(Effect.flip)
      expect(missing._tag).toBe("Routine.NotFoundError")
    }),
  )

  it.effect("keeps command, model and prompt when omitted and clears them on null", () =>
    Effect.gen(function* () {
      const routines = yield* Routine.Service
      const model = { id: Model.ID.make("sonnet"), providerID: Provider.ID.make("anthropic") }
      const created = yield* routines.create({ ...base, commandID: "review", model })
      expect(created).toMatchObject({ prompt: base.prompt, commandID: "review", model })

      const kept = yield* routines.update(created.id, { name: "Same task" })
      expect(kept).toMatchObject({ prompt: base.prompt, commandID: "review", model })

      const cleared = yield* routines.update(created.id, { commandID: null, model: null, prompt: null })
      expect(cleared.commandID).toBeUndefined()
      expect(cleared.model).toBeUndefined()
      expect(cleared.prompt).toBeUndefined()
    }),
  )

  it.effect("rejects an invalid cron or time zone on write", () =>
    Effect.gen(function* () {
      const routines = yield* Routine.Service
      const cron = yield* routines.create({ ...base, schedule: "99 * * * *" }).pipe(Effect.flip)
      expect(cron._tag).toBe("Routine.InvalidScheduleError")
      const zone = yield* routines.create({ ...base, timezone: "Not/AZone" }).pipe(Effect.flip)
      expect(zone._tag).toBe("Routine.InvalidScheduleError")
      const created = yield* routines.create(base)
      const update = yield* routines.update(created.id, { schedule: "0 0 0 * * *" }).pipe(Effect.flip)
      expect(update._tag).toBe("Routine.InvalidScheduleError")
      const missing = yield* routines.update(Routine.ID.create(), { name: "x" }).pipe(Effect.flip)
      expect(missing._tag).toBe("Routine.NotFoundError")
    }),
  )

  it.effect("run now starts one session, dedupes while running, and settles on session execution events", () =>
    Effect.gen(function* () {
      const routines = yield* Routine.Service
      const bus = yield* Bus.Service
      const events = new Array<Event.Payload>()
      yield* bus.listen((event) => Effect.sync(() => events.push(event)))
      const created = yield* routines.create(base)
      started.length = 0

      const run = yield* routines.run(created.id)
      expect(run.status).toBe("running")
      expect(run.sessionID).toBe(sessionID)
      expect(started.map((routine) => routine.id)).toEqual([created.id])
      expect((yield* routines.get(created.id))?.lastRunAt).toBe(run.startedAt)

      // A second "run now" while the first is in flight returns the same run.
      const again = yield* routines.run(created.id)
      expect(again.id).toBe(run.id)
      expect(started.length).toBe(1)

      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
      const runs = yield* routines.runs(created.id)
      expect(runs.map((item) => [item.id, item.status])).toEqual([[run.id, "success"]])
      expect(runs[0]?.finishedAt).toBeGreaterThanOrEqual(run.startedAt)

      const types = events.map((event) => event.type)
      expect(types).toContain("routine.run.started")
      expect(types).toContain("routine.run.finished")
      expect(events.find((event) => event.type === "routine.run.finished")?.data).toMatchObject({
        routineID: created.id,
        runID: run.id,
        status: "success",
      })
    }),
  )

  it.effect("records an error run when the session cannot be started", () =>
    Effect.gen(function* () {
      const routines = yield* Routine.Service
      const bus = yield* Bus.Service
      const events = new Array<Event.Payload>()
      yield* bus.listen((event) => Effect.sync(() => events.push(event)))
      const created = yield* routines.create({ ...base, name: "Broken" })
      failure = "no such agent"
      const run = yield* routines.run(created.id).pipe(Effect.ensuring(Effect.sync(() => (failure = undefined))))
      expect(run.status).toBe("error")
      expect(run.error).toContain("no such agent")
      const runs = yield* routines.runs(created.id, 5)
      expect(runs.map((item) => item.status)).toEqual(["error"])
      expect(events.find((event) => event.type === "routine.run.finished")?.data).toMatchObject({
        runID: run.id,
        status: "error",
      })
      // The routine is free again: a later "run now" starts a fresh run.
      const next = yield* routines.run(created.id)
      expect(next.id).not.toBe(run.id)
      expect(next.status).toBe("running")
    }),
  )

  it.effect("settles a run whose execution fails before the prompt call returns", () =>
    Effect.gen(function* () {
      const routines = yield* Routine.Service
      const bus = yield* Bus.Service
      const created = yield* routines.create({ ...base, name: "Fails at once" })
      // The session dies as soon as the prompt is admitted, i.e. before the runner hands back.
      prompted = (sessionID) =>
        bus.publish(SessionEvent.Execution.Failed, {
          sessionID,
          error: { type: "ProviderError", message: "model unavailable" },
        })
      const run = yield* routines.run(created.id).pipe(Effect.ensuring(Effect.sync(() => (prompted = undefined))))
      expect(run.status).toBe("error")
      expect(run.sessionID).toBe(sessionID)
      expect(run.error).toBe("model unavailable")
      const runs = yield* routines.runs(created.id, 5)
      expect(runs.map((item) => [item.status, item.sessionID])).toEqual([["error", sessionID]])
      // Not stuck: the next "run now" starts a fresh run instead of returning the dead one.
      const next = yield* routines.run(created.id)
      expect(next.id).not.toBe(run.id)
      expect(next.status).toBe("running")
    }),
  )
})
