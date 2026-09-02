export * as CapabilityEvent from "./capability-event.js"

import { Event } from "./event.js"

// Emitted whenever the detected capability set may have changed (MCP status/tools, credentials) so
// clients can refetch instead of polling.
export const Updated = Event.ephemeral({
  type: "capability.updated",
  schema: {},
})

export const Definitions = Event.inventory(Updated)
