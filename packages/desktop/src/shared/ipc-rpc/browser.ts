import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

const Location = Schema.Struct({
  directory: Schema.String,
  workspaceID: Schema.optionalKey(Schema.String),
})

const Bounds = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
})

// `browser.bounds`, `browser.visible`, `browser.focus` from the plan. The first call for a
// location from a window also binds that window as the host of the location's native views.
export const BrowserSetBounds = Rpc.make("BrowserSetBounds", {
  payload: { location: Location, bounds: Bounds },
})
export const BrowserSetVisible = Rpc.make("BrowserSetVisible", {
  payload: { location: Location, visible: Schema.Boolean },
})
export const BrowserFocus = Rpc.make("BrowserFocus", {
  payload: { location: Location },
})
export const BrowserRpcs = RpcGroup.make(BrowserSetBounds, BrowserSetVisible, BrowserFocus)
