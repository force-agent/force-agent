export * as Browser from "./browser.js"

import { Schema } from "effect"
import { NonNegativeInt, optional, PositiveInt } from "./schema.js"

// Tab ids are the CDP target ids of the provider that owns them. They are opaque to clients.
export const TabID = Schema.String.annotate({ identifier: "Browser.TabID" })
export type TabID = typeof TabID.Type

export const Provider = Schema.Literals(["launched", "desktop"]).annotate({ identifier: "Browser.Provider" })
export type Provider = typeof Provider.Type

// Who is driving the shared browser right now. Tools acquire `agent` while they act and hand
// control back to `idle`; a human takes `human` from the panel; `handoff-login` is the agent
// waiting for the human to finish something it must not do itself (login, CAPTCHA).
export const Control = Schema.Literals(["idle", "agent", "human", "handoff-login"]).annotate({
  identifier: "Browser.Control",
})
export type Control = typeof Control.Type

export const Tab = Schema.Struct({
  id: TabID,
  url: Schema.String,
  title: Schema.String,
  active: Schema.Boolean,
  thumbnailVersion: NonNegativeInt,
}).annotate({ identifier: "Browser.Tab" })
export interface Tab extends Schema.Schema.Type<typeof Tab> {}

export const Handoff = Schema.Struct({
  tab: TabID,
  reason: Schema.String,
  until: optional(Schema.String),
  since: Schema.Finite,
}).annotate({ identifier: "Browser.Handoff" })
export interface Handoff extends Schema.Schema.Type<typeof Handoff> {}

export const State = Schema.Struct({
  running: Schema.Boolean,
  provider: optional(Provider),
  profile: Schema.String,
  control: Control,
  tabs: Schema.Array(Tab),
  activeTab: optional(TabID),
  handoff: optional(Handoff),
}).annotate({ identifier: "Browser.State" })
export interface State extends Schema.Schema.Type<typeof State> {}

export const SnapshotMode = Schema.Literals(["full", "diff", "interactive"]).annotate({
  identifier: "Browser.SnapshotMode",
})
export type SnapshotMode = typeof SnapshotMode.Type

// One line of the compact accessibility tree: `role "name" [ref=e12]`. Refs are stable for the
// snapshot version that produced them and resolve to backend DOM nodes on the server.
export const SnapshotNode = Schema.Struct({
  ref: optional(Schema.String),
  role: Schema.String,
  name: Schema.String,
  depth: NonNegativeInt,
  value: optional(Schema.String),
}).annotate({ identifier: "Browser.SnapshotNode" })
export interface SnapshotNode extends Schema.Schema.Type<typeof SnapshotNode> {}

export const Snapshot = Schema.Struct({
  tab: TabID,
  url: Schema.String,
  title: Schema.String,
  version: PositiveInt,
  mode: SnapshotMode,
  tree: Schema.String,
  nodes: NonNegativeInt,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Browser.Snapshot" })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

const Headers = Schema.Record(Schema.String, Schema.String)

// One captured request of a tab. `id` is the CDP requestId and keys `NetworkInput.body`; `type`
// is the lower-cased CDP resource type (document, xhr, fetch, script, …). `status` and
// `responseHeaders` are missing while the response is pending or after `error`. `captured` says
// who held the browser when the request was made; the body of a `human` entry is never returned.
export const NetworkCaptured = Schema.Literals(["agent", "human"]).annotate({ identifier: "Browser.NetworkCaptured" })
export type NetworkCaptured = typeof NetworkCaptured.Type

export const NetworkEntry = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  url: Schema.String,
  status: optional(NonNegativeInt),
  type: Schema.String,
  mimeType: optional(Schema.String),
  requestHeaders: Headers,
  responseHeaders: optional(Headers),
  timestamp: Schema.Finite,
  fromCache: Schema.Boolean,
  captured: NetworkCaptured,
  error: optional(Schema.String),
}).annotate({ identifier: "Browser.NetworkEntry" })
export interface NetworkEntry extends Schema.Schema.Type<typeof NetworkEntry> {}

export const NetworkBody = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  base64: Schema.Boolean,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Browser.NetworkBody" })
export interface NetworkBody extends Schema.Schema.Type<typeof NetworkBody> {}

export const NetworkInput = Schema.Struct({
  tab: optional(TabID),
  host: optional(Schema.String),
  path: optional(Schema.String),
  xhr: optional(Schema.Boolean),
  since: optional(Schema.Finite),
  limit: optional(PositiveInt),
  body: optional(Schema.String),
}).annotate({ identifier: "Browser.NetworkInput" })
export interface NetworkInput extends Schema.Schema.Type<typeof NetworkInput> {}

export const NetworkResult = Schema.Struct({
  tab: TabID,
  url: Schema.String,
  entries: Schema.Array(NetworkEntry),
  total: NonNegativeInt,
  body: optional(NetworkBody),
}).annotate({ identifier: "Browser.NetworkResult" })
export interface NetworkResult extends Schema.Schema.Type<typeof NetworkResult> {}

export const FetchInput = Schema.Struct({
  tab: optional(TabID),
  url: Schema.String,
  method: optional(Schema.String),
  headers: optional(Headers),
  body: optional(Schema.String),
  timeoutMs: optional(PositiveInt),
}).annotate({ identifier: "Browser.FetchInput" })
export interface FetchInput extends Schema.Schema.Type<typeof FetchInput> {}

// `status` is 0 and `error` set when the page could not complete the request (network failure,
// CSP, timeout). `url` is the final URL after redirects.
export const FetchResult = Schema.Struct({
  tab: TabID,
  url: Schema.String,
  status: NonNegativeInt,
  statusText: Schema.String,
  headers: Headers,
  body: Schema.String,
  truncated: Schema.Boolean,
  error: optional(Schema.String),
}).annotate({ identifier: "Browser.FetchResult" })
export interface FetchResult extends Schema.Schema.Type<typeof FetchResult> {}

export const EvalInput = Schema.Struct({
  tab: optional(TabID),
  expression: Schema.String,
  timeoutMs: optional(PositiveInt),
}).annotate({ identifier: "Browser.EvalInput" })
export interface EvalInput extends Schema.Schema.Type<typeof EvalInput> {}

// `json` is the JSON serialization of the awaited value, produced inside the page so the size
// cap applies before the value crosses CDP.
export const EvalResult = Schema.Struct({
  tab: TabID,
  url: Schema.String,
  json: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Browser.EvalResult" })
export interface EvalResult extends Schema.Schema.Type<typeof EvalResult> {}

export const Wait = Schema.Literals(["load", "networkidle"]).annotate({ identifier: "Browser.Wait" })
export type Wait = typeof Wait.Type

export const NavigateInput = Schema.Struct({
  url: Schema.String,
  tab: optional(TabID),
  wait: optional(Wait),
}).annotate({ identifier: "Browser.NavigateInput" })
export interface NavigateInput extends Schema.Schema.Type<typeof NavigateInput> {}

export const SnapshotInput = Schema.Struct({
  tab: optional(TabID),
  mode: optional(SnapshotMode),
  maxNodes: optional(PositiveInt),
}).annotate({ identifier: "Browser.SnapshotInput" })
export interface SnapshotInput extends Schema.Schema.Type<typeof SnapshotInput> {}

export const Action = Schema.Literals(["click", "type", "press", "select", "scroll", "hover", "upload"]).annotate({
  identifier: "Browser.Action",
})
export type Action = typeof Action.Type

export const ActInput = Schema.Struct({
  tab: optional(TabID),
  action: Action,
  ref: optional(Schema.String),
  text: optional(Schema.String),
  key: optional(Schema.String),
  value: optional(Schema.String),
  files: optional(Schema.Array(Schema.String)),
  deltaY: optional(Schema.Finite),
}).annotate({ identifier: "Browser.ActInput" })
export interface ActInput extends Schema.Schema.Type<typeof ActInput> {}

export const ActResult = Schema.Struct({
  tab: TabID,
  url: Schema.String,
  title: Schema.String,
  version: PositiveInt,
  diff: Schema.String,
}).annotate({ identifier: "Browser.ActResult" })
export interface ActResult extends Schema.Schema.Type<typeof ActResult> {}

export const ReadInput = Schema.Struct({
  tab: optional(TabID),
  selector: optional(Schema.String),
  page: optional(PositiveInt),
}).annotate({ identifier: "Browser.ReadInput" })
export interface ReadInput extends Schema.Schema.Type<typeof ReadInput> {}

export const ReadResult = Schema.Struct({
  tab: TabID,
  url: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
  page: PositiveInt,
  pages: PositiveInt,
}).annotate({ identifier: "Browser.ReadResult" })
export interface ReadResult extends Schema.Schema.Type<typeof ReadResult> {}

export const ScreenshotInput = Schema.Struct({
  tab: optional(TabID),
  ref: optional(Schema.String),
  fullPage: optional(Schema.Boolean),
}).annotate({ identifier: "Browser.ScreenshotInput" })
export interface ScreenshotInput extends Schema.Schema.Type<typeof ScreenshotInput> {}

export const ScreenshotResult = Schema.Struct({
  tab: TabID,
  url: Schema.String,
  mime: Schema.String,
  base64: Schema.String,
}).annotate({ identifier: "Browser.ScreenshotResult" })
export interface ScreenshotResult extends Schema.Schema.Type<typeof ScreenshotResult> {}

export const TabsOp = Schema.Literals(["list", "open", "close", "activate"]).annotate({ identifier: "Browser.TabsOp" })
export type TabsOp = typeof TabsOp.Type

export const OpenTabInput = Schema.Struct({
  url: optional(Schema.String),
}).annotate({ identifier: "Browser.OpenTabInput" })
export interface OpenTabInput extends Schema.Schema.Type<typeof OpenTabInput> {}

export const ControlOwner = Schema.Literals(["human", "agent", "release"]).annotate({
  identifier: "Browser.ControlOwner",
})
export type ControlOwner = typeof ControlOwner.Type

export const ControlInput = Schema.Struct({
  owner: ControlOwner,
}).annotate({ identifier: "Browser.ControlInput" })
export interface ControlInput extends Schema.Schema.Type<typeof ControlInput> {}

export const HandoffInput = Schema.Struct({
  tab: optional(TabID),
  reason: Schema.String,
  until: optional(Schema.String),
  timeoutSec: optional(PositiveInt),
}).annotate({ identifier: "Browser.HandoffInput" })
export interface HandoffInput extends Schema.Schema.Type<typeof HandoffInput> {}

export const HandoffResult = Schema.Struct({
  completed: Schema.Boolean,
  tab: TabID,
  url: Schema.String,
}).annotate({ identifier: "Browser.HandoffResult" })
export interface HandoffResult extends Schema.Schema.Type<typeof HandoffResult> {}

// Human input from the panel, sent as JSON text frames over the stream WebSocket. Coordinates are
// CSS pixels of the page viewport; the client has already undone the frame's pageScaleFactor.
export const MouseButton = Schema.Literals(["none", "left", "middle", "right"]).annotate({
  identifier: "Browser.MouseButton",
})
export type MouseButton = typeof MouseButton.Type

export const MouseInput = Schema.Struct({
  type: Schema.Literal("mouse"),
  kind: Schema.Literals(["move", "down", "up"]),
  x: Schema.Finite,
  y: Schema.Finite,
  button: optional(MouseButton),
  clickCount: optional(NonNegativeInt),
  modifiers: optional(NonNegativeInt),
})

export const WheelInput = Schema.Struct({
  type: Schema.Literal("wheel"),
  x: Schema.Finite,
  y: Schema.Finite,
  deltaX: Schema.Finite,
  deltaY: Schema.Finite,
  modifiers: optional(NonNegativeInt),
})

export const KeyInput = Schema.Struct({
  type: Schema.Literal("key"),
  kind: Schema.Literals(["down", "up", "char"]),
  key: Schema.String,
  code: Schema.String,
  text: optional(Schema.String),
  modifiers: optional(NonNegativeInt),
})

export const PasteInput = Schema.Struct({
  type: Schema.Literal("paste"),
  text: Schema.String,
})

export const ResizeInput = Schema.Struct({
  type: Schema.Literal("resize"),
  width: PositiveInt,
  height: PositiveInt,
})

export const StreamInput = Schema.Union([MouseInput, WheelInput, KeyInput, PasteInput, ResizeInput]).annotate({
  identifier: "Browser.StreamInput",
})
export type StreamInput = typeof StreamInput.Type

// Header of one screencast frame: a JSON line followed by the JPEG bytes in the same binary
// WebSocket message. `deviceWidth`/`deviceHeight` are the viewport in CSS px the image maps to.
export const FrameHeader = Schema.Struct({
  tab: TabID,
  offsetTop: Schema.Finite,
  pageScaleFactor: Schema.Finite,
  deviceWidth: Schema.Finite,
  deviceHeight: Schema.Finite,
  scrollOffsetX: Schema.Finite,
  scrollOffsetY: Schema.Finite,
  timestamp: optional(Schema.Finite),
}).annotate({ identifier: "Browser.FrameHeader" })
export interface FrameHeader extends Schema.Schema.Type<typeof FrameHeader> {}
