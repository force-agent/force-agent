import { Browser } from "@opencode-ai/core/browser/session"
import { decode } from "@opencode-ai/core/browser/input"
import { attach as attachDesktop, type DesktopSocket } from "@opencode-ai/core/browser/provider/desktop"
import { locationKey } from "@opencode-ai/core/browser/provider/index"
import { BrowserTicket } from "@opencode-ai/core/browser/ticket"
import { Location } from "@opencode-ai/core/location"
import {
  BrowserActionError,
  BrowserControlError,
  BrowserTabNotFoundError,
  BrowserUnavailableError,
  ForbiddenError,
} from "@opencode-ai/protocol/errors"
import { BROWSER_STREAM_TICKET_QUERY, BROWSER_STREAM_TOKEN_HEADER } from "@opencode-ai/protocol/groups/browser"
import { PTY_CONNECT_TOKEN_HEADER_VALUE } from "@opencode-ai/protocol/groups/pty"
import { Effect, Option, Queue } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Socket } from "effect/unstable/socket"
import { Api } from "../api"
import { BindPolicy } from "../bind-policy"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { response } from "../location"

const ticketScope = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory as string, workspaceID: location.workspaceID }
})

// Wire format of one screencast frame: a JSON header line, then the JPEG bytes.
const encodeFrame = (header: Record<string, unknown>, data: Uint8Array) => {
  const head = new TextEncoder().encode(JSON.stringify(header) + "\n")
  const frame = new Uint8Array(head.length + data.length)
  frame.set(head, 0)
  frame.set(data, head.length)
  return frame
}

const mapError = (error: Browser.Error) => {
  if (error._tag === "Browser.UnavailableError") return new BrowserUnavailableError({ message: error.message })
  if (error._tag === "Browser.TabNotFoundError")
    return new BrowserTabNotFoundError({ tabID: error.tabID, message: `Tab not found: ${error.tabID}` })
  if (error._tag === "Browser.ControlError")
    return new BrowserControlError({
      state: error.state,
      hint: error.hint,
      message: `Browser is controlled by ${error.state}: ${error.hint}`,
    })
  return new BrowserActionError({ message: error.message })
}

const mapped = <A, R>(effect: Effect.Effect<A, Browser.Error, R>) => effect.pipe(Effect.mapError(mapError))

export const BrowserHandler = HttpApiBuilder.group(Api, "server.browser", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* BrowserTicket.Service
    const cors = yield* CorsConfig
    return handlers
      .handle(
        "browser.state",
        Effect.fn(function* () {
          const browser = yield* Browser.Service
          return yield* response(browser.state())
        }),
      )
      .handle(
        "browser.tab.open",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.open(ctx.payload)))
        }),
      )
      .handle(
        "browser.tab.close",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          yield* mapped(browser.close(ctx.params.tabID))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "browser.tab.activate",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.activate(ctx.params.tabID)))
        }),
      )
      .handle(
        "browser.tab.back",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.back(ctx.params.tabID)))
        }),
      )
      .handle(
        "browser.tab.reload",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.reload(ctx.params.tabID)))
        }),
      )
      .handle(
        "browser.tab.ticket",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Same gate as PTY tickets: the custom header forces a CORS preflight.
          if (
            request.headers[BROWSER_STREAM_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
          )
            return yield* new ForbiddenError({ message: "Invalid browser stream ticket request" })
          const browser = yield* Browser.Service
          const state = yield* browser.state()
          if (!state.tabs.some((tab) => tab.id === ctx.params.tabID))
            return yield* new BrowserTabNotFoundError({
              tabID: ctx.params.tabID,
              message: `Tab not found: ${ctx.params.tabID}`,
            })
          return yield* response(tickets.issue({ tabID: ctx.params.tabID, ...(yield* ticketScope) }))
        }),
      )
      .handleRaw(
        "browser.tab.stream",
        Effect.fn("BrowserHandler.stream")(function* (ctx) {
          const browser = yield* Browser.Service
          const state = yield* browser.state()
          if (!state.tabs.some((tab) => tab.id === ctx.params.tabID)) return HttpServerResponse.empty({ status: 404 })

          const url = new URL(ctx.request.url, "http://localhost")
          const ticket = url.searchParams.get(BROWSER_STREAM_TICKET_QUERY)
          if (ticket) {
            const valid = isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
              ? yield* tickets.consume({ ticket, tabID: ctx.params.tabID, ...(yield* ticketScope) })
              : false
            if (!valid) return HttpServerResponse.empty({ status: 403 })
          }

          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const write = yield* socket.writer
          // Frames flow through one queue drained by a single writer; the newest frame wins when
          // the client is slower than Chromium so latency never accumulates.
          const outbox = yield* Queue.unbounded<Uint8Array | Socket.CloseEvent>()
          const stop = yield* browser
            .stream(ctx.params.tabID, (frame) => {
              Queue.offerUnsafe(outbox, encodeFrame({ tab: frame.tabID, ...frame.metadata }, frame.data))
            })
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!stop) return HttpServerResponse.empty({ status: 404 })

          const drain = Effect.gen(function* () {
            while (true) {
              const item = yield* Queue.take(outbox)
              yield* write(item)
              if (item instanceof Socket.CloseEvent) return
            }
          })

          yield* Effect.race(
            drain,
            socket.runRaw((message) => {
              const text = typeof message === "string" ? message : new TextDecoder().decode(message)
              const input = decode(text)
              if (Option.isNone(input)) return
              return browser.input(ctx.params.tabID, input.value).pipe(Effect.catch(() => Effect.void))
            }),
          ).pipe(
            Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
            Effect.ensuring(Effect.sync(stop)),
            Effect.orDie,
          )
          return HttpServerResponse.empty()
        }),
      )
      .handleRaw(
        "browser.thumbnail",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          const thumbnail = yield* mapped(browser.thumbnail(ctx.params.tabID))
          return HttpServerResponse.uint8Array(thumbnail.data, {
            contentType: "image/jpeg",
            headers: { etag: `"${thumbnail.version}"`, "cache-control": "no-cache" },
          })
        }),
      )
      .handle(
        "browser.navigate",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.navigate(ctx.payload)))
        }),
      )
      .handle(
        "browser.control",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(browser.control(ctx.payload))
        }),
      )
      .handle(
        "browser.snapshot",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.snapshot(ctx.payload)))
        }),
      )
      .handle(
        "browser.read",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.read(ctx.payload)))
        }),
      )
      .handle(
        "browser.act",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.act(ctx.payload)))
        }),
      )
      .handle(
        "browser.screenshot",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.screenshot(ctx.payload)))
        }),
      )
      .handle(
        "browser.network",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.network(ctx.payload)))
        }),
      )
      .handle(
        "browser.fetch",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.fetch(ctx.payload)))
        }),
      )
      .handle(
        "browser.eval",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return yield* response(mapped(browser.evaluate(ctx.payload)))
        }),
      )
      .handleRaw(
        "browser.provider",
        Effect.fn("BrowserHandler.provider")(function* (ctx) {
          // Basic auth is enforced by the authorization middleware (`auth_token` query works for
          // WebSocket clients). The desktop runs on this machine, so only a loopback peer qualifies;
          // the socket's remote address decides, never the client-controlled `Host` header.
          const remote = Option.getOrUndefined(ctx.request.remoteAddress)
          if (remote === undefined || BindPolicy.scope(remote) !== "loopback")
            return HttpServerResponse.empty({ status: 403 })
          const location = yield* Location.Service
          const key = locationKey({ directory: location.directory, workspaceID: location.workspaceID })

          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const write = yield* socket.writer
          const outbox = yield* Queue.unbounded<string | Socket.CloseEvent>()
          const listeners = new Set<(message: string) => void>()
          const closers = new Set<() => void>()
          const wire: DesktopSocket = {
            send: (message) => Queue.offerUnsafe(outbox, message),
            onMessage: (listener) => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
            onClose: (listener) => {
              closers.add(listener)
              return () => closers.delete(listener)
            },
            close: () => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000, "desktop provider closed")),
          }
          // The upgrade only completes inside `runRaw`, and the desktop says hello the moment its
          // socket opens: `attach` must already be listening, so it is never awaited before the
          // socket runs. A desktop that stays silent is closed by `attach` itself, which ends `drain`.
          void attachDesktop(key, wire).catch(() => undefined)

          const drain = Effect.gen(function* () {
            while (true) {
              const item = yield* Queue.take(outbox)
              if (item instanceof Socket.CloseEvent) return
              yield* write(item)
            }
          })

          yield* Effect.race(
            drain,
            socket.runRaw((message) => {
              const text = typeof message === "string" ? message : new TextDecoder().decode(message)
              for (const listener of listeners) listener(text)
            }),
          ).pipe(
            Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
            Effect.ensuring(
              Effect.sync(() => {
                for (const listener of closers) listener()
              }),
            ),
            Effect.orDie,
          )
          return HttpServerResponse.empty()
        }),
      )
  }),
)
