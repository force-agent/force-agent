export * as Capability from "./capability.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"
import { IntegrationID } from "./integration-id.js"
import { Mcp } from "./mcp.js"

export interface McpChannel extends Schema.Schema.Type<typeof McpChannel> {}
export const McpChannel = Schema.Struct({
  server: Schema.String,
  status: Mcp.Status,
  tools: NonNegativeInt,
}).annotate({ identifier: "Capability.McpChannel" })

export const ApiMethod = Schema.Literals(["key", "env", "oauth"]).annotate({ identifier: "Capability.ApiMethod" })
export type ApiMethod = typeof ApiMethod.Type

export interface ApiChannel extends Schema.Schema.Type<typeof ApiChannel> {}
export const ApiChannel = Schema.Struct({
  integrationID: optional(IntegrationID),
  method: ApiMethod,
  connected: Schema.Boolean,
  hosts: Schema.Array(Schema.String),
}).annotate({ identifier: "Capability.ApiChannel" })

export interface CliChannel extends Schema.Schema.Type<typeof CliChannel> {}
export const CliChannel = Schema.Struct({
  binary: Schema.String,
  path: optional(Schema.String),
  found: Schema.Boolean,
}).annotate({ identifier: "Capability.CliChannel" })

export interface Channels extends Schema.Schema.Type<typeof Channels> {}
export const Channels = Schema.Struct({
  mcp: optional(Schema.Array(McpChannel)),
  api: optional(ApiChannel),
  cli: optional(CliChannel),
}).annotate({ identifier: "Capability.Channels" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: optional(Schema.String),
  channels: Channels,
  // Listed in the agent's `capabilities` frontmatter field.
  pinned: Schema.Boolean,
  // At least one channel survives the agent's permission ruleset.
  allowed: Schema.Boolean,
}).annotate({ identifier: "Capability.Info" })
