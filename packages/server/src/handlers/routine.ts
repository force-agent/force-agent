import { Location } from "@opencode-ai/core/location"
import { Routine } from "@opencode-ai/core/routine"
import { InvalidRequestError, RoutineNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const invalidSchedule = (error: Routine.InvalidScheduleError) =>
  Effect.fail(new InvalidRequestError({ message: error.message, field: "schedule" }))

const missingRoutine = (error: Routine.NotFoundError) =>
  Effect.fail(
    new RoutineNotFoundError({ routineID: error.routineID, message: `Routine not found: ${error.routineID}` }),
  )

export const RoutineHandler = HttpApiBuilder.group(Api, "server.routine", (handlers) =>
  Effect.gen(function* () {
    // Global service: resolved once at layer build, like the worktree handler.
    // Only the middleware-provided Location is read per request.
    const service = yield* Routine.Service
    return handlers
      .handle(
        "routine.list",
        Effect.fn(function* () {
          const location = yield* Location.Service
          return yield* response(service.list({ directory: location.directory }))
        }),
      )
      .handle(
        "routine.create",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          return yield* response(
            service
              .create({
                projectID: location.project.id,
                directory: location.directory,
                agent: ctx.payload.agent,
                name: ctx.payload.name,
                schedule: ctx.payload.schedule,
                timezone: ctx.payload.timezone,
                prompt: ctx.payload.prompt,
                commandID: ctx.payload.commandID,
                model: ctx.payload.model,
                enabled: ctx.payload.enabled,
              })
              .pipe(Effect.catchTag("Routine.InvalidScheduleError", invalidSchedule)),
          )
        }),
      )
      .handle(
        "routine.update",
        Effect.fn(function* (ctx) {
          return yield* response(
            service
              .update(ctx.params.id, ctx.payload)
              .pipe(
                Effect.catchTag("Routine.NotFoundError", missingRoutine),
                Effect.catchTag("Routine.InvalidScheduleError", invalidSchedule),
              ),
          )
        }),
      )
      .handle(
        "routine.remove",
        Effect.fn(function* (ctx) {
          yield* service.remove(ctx.params.id).pipe(Effect.catchTag("Routine.NotFoundError", missingRoutine))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "routine.run",
        Effect.fn(function* (ctx) {
          return yield* response(
            service.run(ctx.params.id).pipe(Effect.catchTag("Routine.NotFoundError", missingRoutine)),
          )
        }),
      )
      .handle(
        "routine.runs",
        Effect.fn(function* (ctx) {
          return yield* response(service.runs(ctx.params.id, ctx.query.limit))
        }),
      )
  }),
)
