export * as BrowserEvent from "./browser-event.js"

import { Schema } from "effect"
import { Browser } from "./browser.js"
import { Event } from "./event.js"

export const StateChanged = Event.ephemeral({
  type: "browser.state",
  schema: {
    state: Browser.State,
  },
})

export const TabChanged = Event.ephemeral({
  type: "browser.tab.changed",
  schema: {
    tab: Browser.Tab,
    op: Schema.Literals(["opened", "closed", "activated"]),
  },
})

export const TabUrl = Event.ephemeral({
  type: "browser.tab.url",
  schema: {
    tab: Browser.TabID,
    url: Schema.String,
    title: Schema.String,
  },
})

// A new thumbnail version is ready; clients re-fetch `/api/browser/tabs/:tabID/thumbnail?v=`.
export const Thumbnail = Event.ephemeral({
  type: "browser.thumbnail",
  schema: {
    tab: Browser.TabID,
    version: Schema.Finite,
  },
})

export const HandoffRequested = Event.ephemeral({
  type: "browser.handoff.requested",
  schema: {
    handoff: Browser.Handoff,
  },
})

export const Definitions = Event.inventory(StateChanged, TabChanged, TabUrl, Thumbnail, HandoffRequested)
