export * as RoutineEvent from "./routine-event.js"

import { Event } from "./event.js"
import { Routine } from "./routine.js"
import { optional } from "./schema.js"
import { SessionID } from "./session-id.js"

// Any create/update/remove, and every scheduler pass that touches `nextRunAt`.
export const Updated = Event.ephemeral({
  type: "routine.updated",
  schema: {
    routineID: Routine.ID,
  },
})

export const RunStarted = Event.ephemeral({
  type: "routine.run.started",
  schema: {
    routineID: Routine.ID,
    runID: Routine.RunID,
    sessionID: optional(SessionID),
  },
})

export const RunFinished = Event.ephemeral({
  type: "routine.run.finished",
  schema: {
    routineID: Routine.ID,
    runID: Routine.RunID,
    status: Routine.RunStatus,
  },
})

export const Definitions = Event.inventory(Updated, RunStarted, RunFinished)
