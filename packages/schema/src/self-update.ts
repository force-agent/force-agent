export * as SelfUpdate from "./self-update.js"

import { Schema } from "effect"

export const Manager = Schema.Literals(["npm", "pnpm", "bun", "yarn", "unknown"]).annotate({
  identifier: "SelfUpdate.Manager",
})
export type Manager = typeof Manager.Type

export const Reason = Schema.Literals(["local", "no-manager", "unsupported-platform", "disabled"]).annotate({
  identifier: "SelfUpdate.Reason",
})
export type Reason = typeof Reason.Type

export const Idle = Schema.Struct({ type: Schema.Literal("idle") }).annotate({ identifier: "SelfUpdate.PhaseIdle" })
export const Checking = Schema.Struct({ type: Schema.Literal("checking") }).annotate({
  identifier: "SelfUpdate.PhaseChecking",
})
export const Installing = Schema.Struct({
  type: Schema.Literal("installing"),
  version: Schema.String,
}).annotate({ identifier: "SelfUpdate.PhaseInstalling" })
export const Restarting = Schema.Struct({
  type: Schema.Literal("restarting"),
  version: Schema.String,
  // 0 means the runtime has no OS process identity (e.g. workerd).
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SelfUpdate.PhaseRestarting" })
export const ErrorPhase = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}).annotate({ identifier: "SelfUpdate.PhaseError" })

export const Phase = Schema.Union([Idle, Checking, Installing, Restarting, ErrorPhase]).annotate({
  identifier: "SelfUpdate.Phase",
})
export type Phase = typeof Phase.Type

export const Status = Schema.Struct({
  current: Schema.String,
  latest: Schema.optional(Schema.String),
  available: Schema.Boolean,
  manager: Manager,
  canApply: Schema.Boolean,
  reason: Schema.optional(Reason),
  command: Schema.optional(Schema.String),
  checkedAt: Schema.optional(Schema.Finite),
  phase: Phase,
}).annotate({ identifier: "SelfUpdate.Status" })
export type Status = typeof Status.Type
