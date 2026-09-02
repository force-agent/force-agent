import { Capability } from "@opencode-ai/schema/capability"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  agent: Schema.optional(Schema.String),
})

export const CapabilityGroup = HttpApiGroup.make("server.capability")
  .add(
    HttpApiEndpoint.get("capability.list", "/api/capability", {
      query: ListQuery,
      success: Location.response(Schema.Array(Capability.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.capability.list",
          summary: "List capabilities",
          description:
            "Products detected on this machine (MCP servers, API credentials, CLI binaries), optionally filtered and pinned for one agent.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("capability.refresh", "/api/capability/refresh", {
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.capability.refresh",
          summary: "Refresh capabilities",
          description: "Drop the detection cache (including binary lookups) and emit capability.updated.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "capability", description: "Capability detection routes." }))
