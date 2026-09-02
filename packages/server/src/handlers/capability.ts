import { Capability } from "@opencode-ai/core/capability"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const CapabilityHandler = HttpApiBuilder.group(Api, "server.capability", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "capability.list",
        Effect.fn(function* (ctx) {
          const service = yield* Capability.Service
          return yield* response(service.list({ agent: ctx.query.agent }))
        }),
      )
      .handle(
        "capability.refresh",
        Effect.fn(function* () {
          const service = yield* Capability.Service
          yield* service.refresh()
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
