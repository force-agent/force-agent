import { SelfUpdate } from "@opencode-ai/schema/self-update"
import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors.js"

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

export const SelfUpdateGroup = HttpApiGroup.make("server.update")
  .add(
    HttpApiEndpoint.get("update.get", "/api/update", {
      query: Schema.Struct({ refresh: BooleanFromString.pipe(Schema.optional) }),
      success: SelfUpdate.Status,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.update.get",
        summary: "Get self-update status",
        description:
          "Report the running version, the latest published version, whether this installation can update itself, and the phase of an update in progress. Pass `refresh=true` to ask the npm registry again instead of returning the cached answer.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("update.apply", "/api/update/apply", {
      payload: Schema.Struct({ version: Schema.optional(Schema.String) }),
      success: SelfUpdate.Status.pipe(HttpApiSchema.status(202)),
      error: [InvalidRequestError, ConflictError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.update.apply",
        summary: "Install the latest version and restart",
        description:
          "Start installing the latest version (or the given version when it is the latest) and restart the server once the install succeeds. Returns 202 with the accepted status; poll `GET /api/update` for the `restarting` or `error` phase. 400 when the installation cannot update itself or the version is not the latest, 409 when an update is already running, 503 when the latest version could not be determined.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "update", description: "Self-update of the running server." }))
