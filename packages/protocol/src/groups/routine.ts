import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { Routine } from "@opencode-ai/schema/routine"
import { optional } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, RoutineNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const CreatePayload = Schema.Struct({
  name: Schema.String,
  agent: Agent.ID,
  schedule: Routine.Schedule,
  timezone: Routine.Timezone,
  prompt: optional(Schema.String),
  commandID: optional(Schema.String),
  model: optional(Model.Ref),
  enabled: optional(Schema.Boolean),
}).annotate({ identifier: "Routine.CreatePayload" })

// Absent keeps the stored value; `null` clears it. Without the distinction a client
// switching from a project command to a prompt could never drop the old command.
const UpdatePayload = Schema.Struct({
  name: optional(Schema.String),
  agent: optional(Agent.ID),
  schedule: optional(Routine.Schedule),
  timezone: optional(Routine.Timezone),
  prompt: optional(Schema.NullOr(Schema.String)),
  commandID: optional(Schema.NullOr(Schema.String)),
  model: optional(Schema.NullOr(Model.Ref)),
  enabled: optional(Schema.Boolean),
}).annotate({ identifier: "Routine.UpdatePayload" })

export const RoutineGroup = HttpApiGroup.make("server.routine")
  .add(
    HttpApiEndpoint.get("routine.list", "/api/routine", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Routine.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.routine.list",
          summary: "List routines",
          description: "Retrieve the scheduled routines of the requested directory.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("routine.create", "/api/routine", {
      query: LocationQuery,
      payload: CreatePayload,
      success: Location.response(Routine.Info),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.routine.create",
          summary: "Create routine",
          description: "Schedule a prompt or project command for one agent in the requested directory.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("routine.update", "/api/routine/:id", {
      params: { id: Routine.ID },
      query: LocationQuery,
      payload: UpdatePayload,
      success: Location.response(Routine.Info),
      error: [RoutineNotFoundError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.routine.update",
          summary: "Update routine",
          description: "Change a routine; a new schedule, time zone or enabled flag recomputes the next run.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("routine.remove", "/api/routine/:id", {
      params: { id: Routine.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: RoutineNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.routine.remove",
          summary: "Delete routine",
          description: "Delete a routine and its run history.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("routine.run", "/api/routine/:id/run", {
      params: { id: Routine.ID },
      query: LocationQuery,
      success: Location.response(Routine.Run),
      error: RoutineNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.routine.run",
          summary: "Run routine now",
          description: "Start a routine immediately; returns the in-flight run if one is already running.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("routine.runs", "/api/routine/:id/runs", {
      params: { id: Routine.ID },
      query: Schema.Struct({
        ...LocationQuery.fields,
        limit: Schema.optional(
          Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(100),
          ),
        ),
      }),
      success: Location.response(Schema.Array(Routine.Run)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.routine.runs",
          summary: "List routine runs",
          description: "Most recent runs of a routine, newest first (default 10).",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "routine", description: "Scheduled routine routes." }))
