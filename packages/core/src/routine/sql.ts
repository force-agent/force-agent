import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Model } from "@opencode-ai/schema/model"
import type { Project } from "@opencode-ai/schema/project"
import type { AbsolutePath } from "../schema.js"
import { Timestamps } from "../database/schema.sql.js"
import type { Routine } from "../routine.js"

export const RoutineTable = sqliteTable(
  "routine",
  {
    id: text().$type<Routine.ID>().primaryKey(),
    project_id: text().$type<Project.ID>().notNull(),
    directory: text().$type<AbsolutePath>().notNull(),
    agent: text().$type<Routine.Info["agent"]>().notNull(),
    name: text().notNull(),
    schedule: text().notNull(),
    timezone: text().notNull(),
    prompt: text(),
    command_id: text(),
    model: text({ mode: "json" }).$type<Model.Ref>(),
    enabled: integer({ mode: "boolean" }).notNull(),
    last_run_at: integer(),
    next_run_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("routine_directory_idx").on(table.directory),
    index("routine_due_idx").on(table.enabled, table.next_run_at),
  ],
)

export const RoutineRunTable = sqliteTable(
  "routine_run",
  {
    id: text().$type<Routine.RunID>().primaryKey(),
    routine_id: text()
      .$type<Routine.ID>()
      .notNull()
      .references(() => RoutineTable.id, { onDelete: "cascade" }),
    session_id: text().$type<Routine.Run["sessionID"]>(),
    status: text().$type<Routine.RunStatus>().notNull(),
    started_at: integer().notNull(),
    finished_at: integer(),
    error: text(),
  },
  (table) => [
    index("routine_run_routine_idx").on(table.routine_id, table.started_at),
    index("routine_run_session_idx").on(table.session_id),
  ],
)
