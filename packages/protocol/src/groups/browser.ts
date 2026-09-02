import { Browser } from "@opencode-ai/schema/browser"
import { BrowserTicket } from "@opencode-ai/schema/browser-ticket"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  BrowserActionError,
  BrowserControlError,
  BrowserTabNotFoundError,
  BrowserUnavailableError,
  ForbiddenError,
} from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { PTY_CONNECT_TICKET_QUERY, PTY_CONNECT_TOKEN_HEADER } from "./pty.js"

export const BROWSER_STREAM_TICKET_QUERY = PTY_CONNECT_TICKET_QUERY
export const BROWSER_STREAM_TOKEN_HEADER = PTY_CONNECT_TOKEN_HEADER

const STREAM_PATH = /^\/api\/browser\/tabs\/[^/]+\/stream$/

// Authorization middleware skips credential checks when this matches; the stream handler is then
// responsible for consuming and validating the ticket.
export function hasBrowserStreamTicketURL(url: URL) {
  return STREAM_PATH.test(url.pathname) && !!url.searchParams.get(BROWSER_STREAM_TICKET_QUERY)
}

const errors = [BrowserUnavailableError, BrowserTabNotFoundError, BrowserControlError, BrowserActionError]

export const BrowserGroup = HttpApiGroup.make("server.browser")
  .add(
    HttpApiEndpoint.get("browser.state", "/api/browser", {
      query: LocationQuery,
      success: Location.response(Browser.State),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.state",
          summary: "Get browser state",
          description: "Tabs, control owner and pending handoff of the shared browser for a location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.tab.open", "/api/browser/tabs", {
      query: LocationQuery,
      payload: Browser.OpenTabInput,
      success: Location.response(Browser.Tab),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.tab.open",
          summary: "Open browser tab",
          description: "Open a new tab, launching the browser on first use.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("browser.tab.close", "/api/browser/tabs/:tabID", {
      params: { tabID: Browser.TabID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.tab.close",
          summary: "Close browser tab",
          description: "Close one tab.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.tab.activate", "/api/browser/tabs/:tabID/activate", {
      params: { tabID: Browser.TabID },
      query: LocationQuery,
      success: Location.response(Browser.Tab),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.tab.activate",
          summary: "Activate browser tab",
          description: "Make one tab the active tab that tools act on by default.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.tab.back", "/api/browser/tabs/:tabID/back", {
      params: { tabID: Browser.TabID },
      query: LocationQuery,
      success: Location.response(Browser.Tab),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.tab.back",
          summary: "Go back",
          description: "Navigate one tab to the previous history entry, if any.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.tab.reload", "/api/browser/tabs/:tabID/reload", {
      params: { tabID: Browser.TabID },
      query: LocationQuery,
      success: Location.response(Browser.Tab),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.tab.reload",
          summary: "Reload",
          description: "Reload one tab.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.tab.ticket", "/api/browser/tabs/:tabID/ticket", {
      params: { tabID: Browser.TabID },
      query: LocationQuery,
      headers: Schema.Struct({ [BROWSER_STREAM_TOKEN_HEADER]: Schema.optional(Schema.String) }),
      success: Location.response(BrowserTicket.ConnectToken),
      error: [ForbiddenError, ...errors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.tab.ticket",
          summary: "Create browser stream ticket",
          description: "Create a short-lived single-use ticket for opening the screencast WebSocket of one tab.",
        }),
      ),
  )
  .add(
    // Query fields are decoded in the raw handler after the existence check, like `pty.connect`.
    HttpApiEndpoint.get("browser.tab.stream", "/api/browser/tabs/:tabID/stream", {
      params: { tabID: Browser.TabID },
      success: Schema.Boolean,
      error: [ForbiddenError, BrowserTabNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.browser.tab.stream",
        summary: "Stream browser tab",
        description:
          "WebSocket: binary frames carry one JSON header line followed by JPEG bytes; text frames from the client carry input events.",
        transform: (operation) => ({
          ...operation,
          "x-websocket": true,
          parameters: [
            ...(operation.parameters ?? []),
            ...["location[directory]", "location[workspace]", BROWSER_STREAM_TICKET_QUERY].map((name) => ({
              in: "query",
              name,
              schema: { type: "string" },
            })),
          ],
        }),
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("browser.thumbnail", "/api/browser/tabs/:tabID/thumbnail", {
      params: { tabID: Browser.TabID },
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.thumbnail",
          summary: "Get tab thumbnail",
          description: "Small JPEG of one tab. The ETag header carries the thumbnail version.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.navigate", "/api/browser/navigate", {
      query: LocationQuery,
      payload: Browser.NavigateInput,
      success: Location.response(Browser.Snapshot),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.navigate",
          summary: "Navigate",
          description: "Open a URL in a tab and return a short accessibility snapshot.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.control", "/api/browser/control", {
      query: LocationQuery,
      payload: Browser.ControlInput,
      success: Location.response(Browser.State),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.control",
          summary: "Set browser control",
          description: "Take control for the human, give it to the agent, or release it (also ends a handoff).",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.snapshot", "/api/browser/snapshot", {
      query: LocationQuery,
      payload: Browser.SnapshotInput,
      success: Location.response(Browser.Snapshot),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.snapshot",
          summary: "Snapshot",
          description: "Accessibility tree of a tab with element refs.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.read", "/api/browser/read", {
      query: LocationQuery,
      payload: Browser.ReadInput,
      success: Location.response(Browser.ReadResult),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.read",
          summary: "Read page",
          description: "Page content as paginated markdown.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.act", "/api/browser/act", {
      query: LocationQuery,
      payload: Browser.ActInput,
      success: Location.response(Browser.ActResult),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.act",
          summary: "Act on element",
          description: "Click, type, press, select, scroll, hover or upload by snapshot ref.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.screenshot", "/api/browser/screenshot", {
      query: LocationQuery,
      payload: Browser.ScreenshotInput,
      success: Location.response(Browser.ScreenshotResult),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.screenshot",
          summary: "Screenshot",
          description: "JPEG of the viewport, full page or one element, base64 encoded.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.network", "/api/browser/network", {
      query: LocationQuery,
      payload: Browser.NetworkInput,
      success: Location.response(Browser.NetworkResult),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.network",
          summary: "List captured requests",
          description:
            "Requests a tab has made, newest first, filtered by host, path, XHR-only and time; optionally one response body.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.fetch", "/api/browser/fetch", {
      query: LocationQuery,
      payload: Browser.FetchInput,
      success: Location.response(Browser.FetchResult),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.fetch",
          summary: "Fetch from the page",
          description: "Run fetch(url, init) inside a tab so its cookies and same-origin rules apply.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("browser.eval", "/api/browser/eval", {
      query: LocationQuery,
      payload: Browser.EvalInput,
      success: Location.response(Browser.EvalResult),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.eval",
          summary: "Evaluate script",
          description: "Evaluate JavaScript in a tab and return the awaited result as JSON.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("browser.provider", "/api/browser/provider", {
      success: Schema.Boolean,
      error: [ForbiddenError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.browser.provider",
        summary: "Desktop browser provider",
        description:
          "WebSocket for the desktop app (loopback only, Basic auth): the desktop relays CDP for its native browser views so this location's browser runs inside the app instead of a launched Chromium.",
        transform: (operation) => ({
          ...operation,
          "x-websocket": true,
          parameters: [
            ...(operation.parameters ?? []),
            ...["location[directory]", "location[workspace]"].map((name) => ({
              in: "query",
              name,
              schema: { type: "string" },
            })),
          ],
        }),
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "browser", description: "Shared agent browser routes." }))
