export * as Agent from "./agent.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"
import { Model } from "./model.js"
import { Permission } from "./permission.js"
import { Provider } from "./provider.js"
import { PositiveInt, statics } from "./schema.js"

const Updated = ephemeral({ type: "agent.updated", schema: {} })

export const ID = Schema.String.pipe(Schema.brand("Agent.ID"))
export type ID = typeof ID.Type

export const Name = Schema.String.pipe(Schema.brand("Agent.Name"))
export type Name = typeof Name.Type

export const Color = Schema.String.annotate({ identifier: "Agent.Color" })
export type Color = typeof Color.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Name,
  model: Model.Ref.pipe(optional),
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permissions: Permission.Ruleset,
  // Product ids pinned for this agent (`"posthog"` or `"posthog=mcp:<server>"` to fix the MCP server).
  capabilities: Schema.Array(Schema.String).pipe(optional),
})
  .annotate({ identifier: "Agent.Info" })
  .pipe(
    statics(() => ({
      default: (id: ID) =>
        ({
          id,
          name: Name.make(id),
          request: { settings: {}, headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            // power-agent overlay: the blanket allow above is what kept the multi-agent gate in
            // core's `plugin/workflow-gate.ts` from ever asking out of the box. `Permission.evaluate`
            // falls back to `ask` only when NOTHING matches, and `*` matches everything, so
            // `workflow.run` resolved to `allow` on the default agent. Rules are last-match-wins, so
            // the dedicated action is carved back out here, on the default path every agent is
            // seeded from. A user rule for it still wins: config permissions are appended after these.
            { action: "workflow.run", resource: "*", effect: "ask" },
            // Driving the shared browser asks per host and remembers the answer; looking at a
            // page (`browser.read`) stays covered by the blanket allow.
            { action: "browser", resource: "*", effect: "ask" },
            // Script in the page and non-GET requests from it ask separately: a host approved
            // for navigation is not thereby approved for arbitrary JS or writes.
            { action: "browser.eval", resource: "*", effect: "ask" },
            { action: "browser.fetch", resource: "*", effect: "ask" },
            { action: "external_directory", resource: "*", effect: "ask" },
            { action: "read", resource: "*.env", effect: "ask" },
            { action: "read", resource: "*.env.*", effect: "ask" },
            { action: "read", resource: "*.env.example", effect: "allow" },
          ],
        }) satisfies Info,
    })),
  )

export const Event = {
  Updated,
  Definitions: inventory(Updated),
}
