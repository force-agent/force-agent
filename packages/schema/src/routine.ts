export * as Routine from "./routine.js"

import { Cron, DateTime, Option, Result, Schema } from "effect"
import { Agent } from "./agent.js"
import { ascending } from "./identifier.js"
import { Model } from "./model.js"
import { ProjectID } from "./project-id.js"
import { AbsolutePath, optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const ID = Schema.String.pipe(
  Schema.brand("Routine.ID"),
  statics((schema) => ({ create: () => schema.make("rtn_" + ascending()) })),
)
export type ID = typeof ID.Type

export const RunID = Schema.String.pipe(
  Schema.brand("Routine.RunID"),
  statics((schema) => ({ create: () => schema.make("rrun_" + ascending()) })),
)
export type RunID = typeof RunID.Type

/**
 * Five-field cron (minute hour day-of-month month day-of-week); seconds are not
 * accepted. The schema only checks the shape (the client codegen cannot carry a
 * closure); `isSchedule` is the strict check the core applies on write.
 */
export const isSchedule = (value: string) => {
  const trimmed = value.trim()
  return trimmed.split(/\s+/).length === 5 && Result.isSuccess(Cron.parse(trimmed))
}
export const Schedule = Schema.String.check(Schema.isPattern(/^\s*\S+(?:\s+\S+){4}\s*$/)).annotate({
  identifier: "Routine.Schedule",
})
export type Schedule = typeof Schedule.Type

/** IANA zone name, e.g. `America/Sao_Paulo`; `isTimezone` is the strict check. */
export const isTimezone = (value: string) => Option.isSome(DateTime.zoneMakeNamed(value))
export const Timezone = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/),
).annotate({
  identifier: "Routine.Timezone",
})
export type Timezone = typeof Timezone.Type

export const SchedulePreset = Schema.Literals(["hourly", "daily", "weekly", "custom"]).annotate({
  identifier: "Routine.SchedulePreset",
})
export type SchedulePreset = typeof SchedulePreset.Type

export const RunStatus = Schema.Literals(["running", "success", "error", "missed", "cancelled"]).annotate({
  identifier: "Routine.RunStatus",
})
export type RunStatus = typeof RunStatus.Type

/** A scheduled prompt (or project command) run by one agent in one directory. Timestamps are epoch millis. */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  directory: AbsolutePath,
  agent: Agent.ID,
  name: Schema.String,
  schedule: Schedule,
  timezone: Timezone,
  prompt: optional(Schema.String),
  commandID: optional(Schema.String),
  model: optional(Model.Ref),
  enabled: Schema.Boolean,
  lastRunAt: optional(Schema.Finite),
  /** Status of the most recent run, so a list can show it without a second request. */
  lastRunStatus: optional(RunStatus),
  nextRunAt: optional(Schema.Finite),
  time: Schema.Struct({
    created: Schema.Finite,
    updated: Schema.Finite,
  }),
}).annotate({ identifier: "Routine.Info" })

export interface Run extends Schema.Schema.Type<typeof Run> {}
export const Run = Schema.Struct({
  id: RunID,
  routineID: ID,
  sessionID: optional(SessionID),
  status: RunStatus,
  startedAt: Schema.Finite,
  finishedAt: optional(Schema.Finite),
  error: optional(Schema.String),
}).annotate({ identifier: "Routine.Run" })
