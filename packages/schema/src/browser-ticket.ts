export * as BrowserTicket from "./browser-ticket.js"

import { Schema } from "effect"
import { PositiveInt } from "./schema.js"

// Short-lived single-use ticket that opens the screencast WebSocket of one tab. Same shape as
// the PTY ticket so clients can share the connect flow.
export const ConnectToken = Schema.Struct({
  ticket: Schema.String,
  expires_in: PositiveInt,
}).annotate({ identifier: "BrowserTicket.ConnectToken" })
export interface ConnectToken extends Schema.Schema.Type<typeof ConnectToken> {}
