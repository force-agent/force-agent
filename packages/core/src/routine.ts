export * as Routine from "./routine.js"

import { and, asc, desc, eq, inArray, lt, lte, max } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Predicate, Schema, Scope } from "effect"
import { Routine } from "@opencode-ai/schema/routine"
import { RoutineEvent } from "@opencode-ai/schema/routine-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import type { SessionID } from "@opencode-ai/schema/session-id"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import type { AbsolutePath } from "./schema.js"
import { Session } from "./session.js"
import { nextRun } from "./routine/scheduler.js"
import { RoutineRunTable, RoutineTable } from "./routine/sql.js"

export const ID = Routine.ID
export type ID = Routine.ID

export const RunID = Routine.RunID
export type RunID = Routine.RunID

export const Info = Routine.Info
export type Info = Routine.Info

export const Run = Routine.Run
export type Run = Routine.Run

export type RunStatus = Routine.RunStatus

export const Event = RoutineEvent

/** Scheduler pass frequency; cron resolution is one minute so 30s keeps drift under half a slot. */
const TICK = "30 seconds"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Routine.NotFoundError", {
  routineID: ID,
}) {}

export class InvalidScheduleError extends Schema.TaggedError<InvalidScheduleError>()("Routine.InvalidScheduleError", {
  schedule: Schema.String,
  timezone: Schema.String,
  message: Schema.String,
}) {}

export type CreateInput = {
  readonly projectID: Info["projectID"]
  readonly directory: AbsolutePath
  readonly agent: Info["agent"]
  readonly name: string
  readonly schedule: string
  readonly timezone: string
  readonly prompt?: string
  readonly commandID?: string
  readonly model?: Info["model"]
  readonly enabled?: boolean
}

export type UpdateInput = Partial<Pick<Info, "agent" | "name" | "schedule" | "timezone" | "enabled">> & {
  /** Absent keeps the stored value; `null` clears it. */
  readonly prompt?: string | null
  readonly commandID?: string | null
  readonly model?: Info["model"] | null
}

export interface Interface {
  /** Routines of one directory, or every routine when no directory is given. */
  readonly list: (input?: { readonly directory?: AbsolutePath }) => Effect.Effect<Info[]>
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidScheduleError>
  readonly update: (id: ID, updates: UpdateInput) => Effect.Effect<Info, NotFoundError | InvalidScheduleError>
  readonly remove: (id: ID) => Effect.Effect<void, NotFoundError>
  /** Manual "run now": starts a run outside the schedule; the next scheduled slot is untouched. */
  readonly run: (id: ID) => Effect.Effect<Run, NotFoundError>
  readonly runs: (id: ID, limit?: number) => Effect.Effect<Run[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Routine") {}

/**
 * The part of a run that needs the session graph, split out so the scheduler
 * and CRUD can be exercised without booting sessions. It is two steps because
 * the service records the session ID between them: an execution that fails at
 * once publishes its event before `prompt` returns, and the run can only be
 * settled from that event if its session is already on record.
 */
export interface RunnerInterface {
  readonly create: (routine: Info) => Effect.Effect<SessionID, unknown>
  readonly prompt: (routine: Info, sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Runner extends Context.Service<Runner, RunnerInterface>()("@opencode/Routine/Runner") {}

const runnerLayer = Layer.effect(
  Runner,
  Effect.gen(function* () {
    const session = yield* Session.Service
    return Runner.of({
      create: Effect.fn("Routine.Runner.create")(function* (routine) {
        const info = yield* session.create({
          agent: routine.agent,
          model: routine.model,
          title: routine.name,
          metadata: { source: "routine", routineID: routine.id },
          location: { directory: routine.directory },
        })
        return info.id
      }),
      prompt: Effect.fn("Routine.Runner.prompt")(function* (routine, sessionID) {
        if (routine.commandID) {
          yield* session.command({ sessionID, command: routine.commandID, text: routine.prompt ?? "" })
        } else {
          yield* session.prompt({ sessionID, text: routine.prompt ?? "" })
        }
      }),
    })
  }),
)

export const runnerNode = makeGlobalNode({ service: Runner, layer: runnerLayer, deps: [Session.node] })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const runner = yield* Runner
    const scope = yield* Scope.Scope

    const fromRow = (row: typeof RoutineTable.$inferSelect, lastRunStatus?: Routine.RunStatus): Info => ({
      id: row.id,
      projectID: row.project_id,
      directory: row.directory,
      agent: row.agent,
      name: row.name,
      schedule: row.schedule,
      timezone: row.timezone,
      prompt: row.prompt ?? undefined,
      commandID: row.command_id ?? undefined,
      model: row.model ?? undefined,
      enabled: row.enabled,
      lastRunAt: row.last_run_at ?? undefined,
      lastRunStatus,
      nextRunAt: row.next_run_at ?? undefined,
      time: { created: row.time_created, updated: row.time_updated },
    })

    const runFromRow = (row: typeof RoutineRunTable.$inferSelect): Run => ({
      id: row.id,
      routineID: row.routine_id,
      sessionID: row.session_id ?? undefined,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      error: row.error ?? undefined,
    })

    // SQLite keeps the row that produced MAX(): one query gives the latest status per routine.
    const latestStatus = Effect.fn("Routine.latestStatus")(function* (ids: ID[]) {
      if (ids.length === 0) return new Map<ID, Routine.RunStatus>()
      const rows = yield* db
        .select({
          routine_id: RoutineRunTable.routine_id,
          status: RoutineRunTable.status,
          at: max(RoutineRunTable.started_at),
        })
        .from(RoutineRunTable)
        .where(inArray(RoutineRunTable.routine_id, ids))
        .groupBy(RoutineRunTable.routine_id)
        .all()
        .pipe(Effect.orDie)
      return new Map(rows.map((row) => [row.routine_id, row.status] as const))
    })

    const infos = Effect.fn("Routine.infos")(function* (rows: (typeof RoutineTable.$inferSelect)[]) {
      const status = yield* latestStatus(rows.map((row) => row.id))
      return rows.map((row) => fromRow(row, status.get(row.id)))
    })

    const info = Effect.fn("Routine.info")(function* (id: ID) {
      const row = yield* getRow(id)
      if (!row) return undefined
      return (yield* infos([row]))[0]
    })

    const location = (routine: Info) => ({ location: { directory: routine.directory } })

    const publishUpdated = (routine: Info) => bus.publish(Event.Updated, { routineID: routine.id }, location(routine))

    const validate = (schedule: string, timezone: string) =>
      Effect.gen(function* () {
        if (!Routine.isSchedule(schedule))
          return yield* new InvalidScheduleError({ schedule, timezone, message: "Invalid cron expression" })
        if (!Routine.isTimezone(timezone))
          return yield* new InvalidScheduleError({ schedule, timezone, message: "Unknown time zone" })
      })

    const next = (routine: Pick<Info, "schedule" | "timezone" | "enabled">, from: number) =>
      routine.enabled ? (nextRun(routine.schedule, routine.timezone, new Date(from))?.getTime() ?? null) : null

    const getRow = (id: ID) => db.select().from(RoutineTable).where(eq(RoutineTable.id, id)).get().pipe(Effect.orDie)

    const runRow = (id: RunID) =>
      db.select().from(RoutineRunTable).where(eq(RoutineRunTable.id, id)).get().pipe(Effect.orDie)

    const finish = Effect.fn("Routine.finish")(function* (
      run: typeof RoutineRunTable.$inferSelect,
      status: Exclude<Routine.RunStatus, "running">,
      error?: string,
    ) {
      yield* db
        .update(RoutineRunTable)
        .set({ status, finished_at: Date.now(), error: error ?? null })
        .where(eq(RoutineRunTable.id, run.id))
        .run()
        .pipe(Effect.orDie)
      const routine = yield* getRow(run.routine_id)
      yield* bus.publish(
        Event.RunFinished,
        { routineID: run.routine_id, runID: run.id, status },
        routine ? location(fromRow(routine)) : undefined,
      )
    })

    // One in-flight run per routine: a slot that lands while the previous
    // session still works is skipped, not queued.
    const start = Effect.fn("Routine.start")(function* (routine: Info, now: number) {
      const active = yield* db
        .select()
        .from(RoutineRunTable)
        .where(and(eq(RoutineRunTable.routine_id, routine.id), eq(RoutineRunTable.status, "running")))
        .get()
        .pipe(Effect.orDie)
      if (active) return runFromRow(active)
      const id = RunID.create()
      yield* db
        .insert(RoutineRunTable)
        .values({ id, routine_id: routine.id, status: "running", started_at: now })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(RoutineTable)
        .set({ last_run_at: now })
        .where(eq(RoutineTable.id, routine.id))
        .run()
        .pipe(Effect.orDie)
      const fail = Effect.fn("Routine.start.fail")(function* (cause: Cause.Cause<unknown>) {
        const message = Cause.pretty(cause)
        yield* Effect.logError("routine run failed to start", { routineID: routine.id, message })
        const row = yield* runRow(id)
        // The session's execution events may already have settled this run; only an open one is closed here.
        if (row?.status === "running") yield* finish(row, "error", message)
        const final = yield* runRow(id)
        if (final) return runFromRow(final)
        const gone: Run = {
          id,
          routineID: routine.id,
          status: "error",
          startedAt: now,
          finishedAt: Date.now(),
          error: message,
        }
        return gone
      })
      const created = yield* runner.create(routine).pipe(Effect.exit)
      if (Exit.isFailure(created)) return yield* fail(created.cause)
      const sessionID = created.value
      // Recorded before the prompt is admitted: an execution that fails at once publishes
      // its event before `prompt` returns, and `settle` finds the run by session ID.
      yield* db
        .update(RoutineRunTable)
        .set({ session_id: sessionID })
        .where(eq(RoutineRunTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* bus.publish(Event.RunStarted, { routineID: routine.id, runID: id, sessionID }, location(routine))
      const prompted = yield* runner.prompt(routine, sessionID).pipe(Effect.exit)
      if (Exit.isFailure(prompted)) return yield* fail(prompted.cause)
      // Re-read: the execution may have settled while the prompt was being admitted.
      const row = yield* runRow(id)
      const run: Run = row
        ? runFromRow(row)
        : { id, routineID: routine.id, sessionID, status: "running", startedAt: now }
      return run
    })

    // A run ends when its session's execution settles.
    const settle = Effect.fn("Routine.settle")(function* (
      sessionID: SessionID,
      status: Exclude<Routine.RunStatus, "running" | "missed">,
      error?: string,
    ) {
      const run = yield* db
        .select()
        .from(RoutineRunTable)
        .where(and(eq(RoutineRunTable.session_id, sessionID), eq(RoutineRunTable.status, "running")))
        .get()
        .pipe(Effect.orDie)
      if (!run) return
      yield* finish(run, status, error)
    })

    // `listen` registers synchronously, so no execution event can slip past
    // between this layer coming up and a stream subscription starting.
    yield* bus.listen((event) => {
      if (event.type === SessionEvent.Execution.Succeeded.type) {
        const succeeded = event as typeof SessionEvent.Execution.Succeeded.Type
        return settle(succeeded.data.sessionID, "success")
      }
      if (event.type === SessionEvent.Execution.Failed.type) {
        const failed = event as typeof SessionEvent.Execution.Failed.Type
        return settle(failed.data.sessionID, "error", failed.data.error.message)
      }
      if (event.type === SessionEvent.Execution.Interrupted.type) {
        const interrupted = event as typeof SessionEvent.Execution.Interrupted.Type
        return settle(interrupted.data.sessionID, "cancelled", interrupted.data.reason)
      }
      return Effect.void
    })

    // Boot: runs left `running` by a previous process are over (the session was
    // interrupted at shutdown); overdue routines get ONE `missed` run each and
    // a fresh slot from now. There is deliberately no catch-up.
    const recover = Effect.fn("Routine.recover")(function* () {
      const now = Date.now()
      const stale = yield* db
        .select()
        .from(RoutineRunTable)
        .where(eq(RoutineRunTable.status, "running"))
        .all()
        .pipe(Effect.orDie)
      for (const run of stale) yield* finish(run, "cancelled", "server restarted")
      const overdue = yield* db
        .select()
        .from(RoutineTable)
        .where(and(eq(RoutineTable.enabled, true), lt(RoutineTable.next_run_at, now)))
        .all()
        .pipe(Effect.orDie)
      for (const row of overdue) {
        const routine = fromRow(row)
        yield* db
          .insert(RoutineRunTable)
          .values({
            id: RunID.create(),
            routine_id: row.id,
            status: "missed",
            started_at: row.next_run_at ?? now,
            finished_at: now,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(RoutineTable)
          .set({ next_run_at: next(routine, now) })
          .where(eq(RoutineTable.id, row.id))
          .run()
          .pipe(Effect.orDie)
        yield* publishUpdated(routine)
      }
    })

    const tick = Effect.fn("Routine.tick")(function* () {
      const now = Date.now()
      const due = yield* db
        .select()
        .from(RoutineTable)
        .where(and(eq(RoutineTable.enabled, true), lte(RoutineTable.next_run_at, now)))
        .all()
        .pipe(Effect.orDie)
      for (const row of due) {
        const routine = fromRow(row)
        // Advance the slot before starting so a crash mid-run cannot replay it.
        yield* db
          .update(RoutineTable)
          .set({ next_run_at: next(routine, now) })
          .where(eq(RoutineTable.id, row.id))
          .run()
          .pipe(Effect.orDie)
        yield* start(routine, now).pipe(
          Effect.catchCause((cause) => Effect.logError("routine tick failed", { routineID: routine.id, cause })),
        )
        yield* publishUpdated(routine)
      }
    })

    // Recovery completes before the service is handed out, so nothing created
    // through it can be mistaken for a leftover of the previous process.
    yield* recover().pipe(Effect.catchCause((cause) => Effect.logError("routine recovery failed", { cause })))
    yield* Effect.forever(
      Effect.sleep(TICK).pipe(
        Effect.andThen(tick()),
        Effect.catchCause((cause) => Effect.logError("routine tick failed", { cause })),
      ),
    ).pipe(Effect.forkIn(scope))

    return Service.of({
      list: Effect.fn("Routine.list")((input) =>
        db
          .select()
          .from(RoutineTable)
          .where(input?.directory ? eq(RoutineTable.directory, input.directory) : undefined)
          .orderBy(asc(RoutineTable.name), asc(RoutineTable.id))
          .all()
          .pipe(Effect.orDie, Effect.flatMap(infos)),
      ),
      get: Effect.fn("Routine.get")((id) => info(id)),
      create: Effect.fn("Routine.create")(function* (input) {
        yield* validate(input.schedule, input.timezone)
        const now = Date.now()
        const enabled = input.enabled ?? true
        const id = ID.create()
        yield* db
          .insert(RoutineTable)
          .values({
            id,
            project_id: input.projectID,
            directory: input.directory,
            agent: input.agent,
            name: input.name,
            schedule: input.schedule.trim(),
            timezone: input.timezone,
            prompt: input.prompt ?? null,
            command_id: input.commandID ?? null,
            model: input.model ?? null,
            enabled,
            next_run_at: next({ schedule: input.schedule, timezone: input.timezone, enabled }, now),
          })
          .run()
          .pipe(Effect.orDie)
        const routine = (yield* info(id))!
        yield* publishUpdated(routine)
        return routine
      }),
      update: Effect.fn("Routine.update")(function* (id, updates) {
        const row = yield* getRow(id)
        if (!row) return yield* new NotFoundError({ routineID: id })
        const schedule = updates.schedule?.trim() ?? row.schedule
        const timezone = updates.timezone ?? row.timezone
        const enabled = updates.enabled ?? row.enabled
        yield* validate(schedule, timezone)
        const reschedule =
          schedule !== row.schedule || timezone !== row.timezone || enabled !== row.enabled || row.next_run_at === null
        yield* db
          .update(RoutineTable)
          .set({
            agent: updates.agent ?? row.agent,
            name: updates.name ?? row.name,
            schedule,
            timezone,
            prompt: updates.prompt === undefined ? row.prompt : updates.prompt,
            command_id: updates.commandID === undefined ? row.command_id : updates.commandID,
            model: updates.model === undefined ? row.model : updates.model,
            enabled,
            next_run_at: reschedule ? next({ schedule, timezone, enabled }, Date.now()) : row.next_run_at,
          })
          .where(eq(RoutineTable.id, id))
          .run()
          .pipe(Effect.orDie)
        const routine = (yield* info(id))!
        yield* publishUpdated(routine)
        return routine
      }),
      remove: Effect.fn("Routine.remove")(function* (id) {
        const row = yield* getRow(id).pipe(
          Effect.filterOrFail(Predicate.isNotUndefined, () => new NotFoundError({ routineID: id })),
        )
        yield* db.delete(RoutineRunTable).where(eq(RoutineRunTable.routine_id, id)).run().pipe(Effect.orDie)
        yield* db.delete(RoutineTable).where(eq(RoutineTable.id, id)).run().pipe(Effect.orDie)
        yield* publishUpdated(fromRow(row))
      }),
      run: Effect.fn("Routine.run")(function* (id) {
        const row = yield* getRow(id)
        if (!row) return yield* new NotFoundError({ routineID: id })
        const routine = fromRow(row)
        const run = yield* start(routine, Date.now())
        yield* publishUpdated(routine)
        return run
      }),
      runs: Effect.fn("Routine.runs")((id, limit = 10) =>
        db
          .select()
          .from(RoutineRunTable)
          .where(eq(RoutineRunTable.routine_id, id))
          .orderBy(desc(RoutineRunTable.started_at), desc(RoutineRunTable.id))
          .limit(limit)
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map(runFromRow)),
          ),
      ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node, runnerNode] })
