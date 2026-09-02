export * as InstallationEvent from "./installation-event.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { SelfUpdate } from "./self-update.js"

export const Updated = Event.ephemeral({
  type: "installation.updated",
  schema: {
    version: Schema.String,
  },
})

export const UpdateAvailable = Event.ephemeral({
  type: "installation.update-available",
  schema: {
    version: Schema.String,
  },
})

export const UpdateState = Event.ephemeral({
  type: "installation.update-state",
  schema: {
    status: SelfUpdate.Status,
  },
})

export const Definitions = Event.inventory(Updated, UpdateAvailable, UpdateState)
