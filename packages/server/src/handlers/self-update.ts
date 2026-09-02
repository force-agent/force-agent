import { SelfUpdate } from "@opencode-ai/core/self-update"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const SelfUpdateHandler = HttpApiBuilder.group(Api, "server.update", (handlers) =>
  Effect.gen(function* () {
    const update = yield* SelfUpdate.Service

    return handlers
      .handle("update.get", (ctx) => (ctx.query.refresh ? update.check() : update.status()))
      .handle("update.apply", (ctx) =>
        update.apply(ctx.payload.version).pipe(
          Effect.catchTags({
            "SelfUpdate.NotApplicable": (error) => new InvalidRequestError({ message: error.message }),
            "SelfUpdate.Busy": (error) => new ConflictError({ message: error.message, resource: "update" }),
            "SelfUpdate.CheckFailed": (error) =>
              new ServiceUnavailableError({ message: error.message, service: "npm-registry" }),
          }),
        ),
      )
  }),
)
