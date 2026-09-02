import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerResponse } from "effect/unstable/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

/**
 * power-agent overlay: the embedded web UI is not a route in the HttpApi — it is the
 * `transform` the CLI hands to {@link ServerProcess.start} (see
 * `packages/cli/src/services/web-ui.ts`), which catches `RouteNotFound` and answers with
 * `index.html`. That transform wraps the *inner* application, and `dispatch` credential-checks
 * every request before the inner application ever runs, so the SPA shell and its hashed assets
 * sit behind the same Basic credential as `/api`.
 *
 * This test pins that ordering. Moving the transform outside `dispatch` — wrapping the served
 * effect instead of the `application` ref — would hand the app shell to anonymous visitors
 * without failing any other test in the repo.
 */
const shell = "<html><body>app shell</body></html>"

it.live("serves the web UI shell only to an authenticated visitor", () =>
  Effect.gen(function* () {
    const server = yield* ServerProcess.start<never, never>(
      {
        hostname: "127.0.0.1",
        port: 0,
        password: "secret",
        app: { version: "test-version" },
        database: { path: ":memory:" },
      },
      undefined,
      (api) =>
        api.pipe(
          Effect.catchIf(
            (error) => error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound",
            () => Effect.succeed(HttpServerResponse.raw(shell, { contentType: "text/html" })),
          ),
        ),
    )
    const base = HttpServer.formatAddress(server.address)

    yield* Effect.forEach(["/", "/index.html", "/_assets/app.js", "/workspace/example"], (pathname) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(new URL(pathname, base)))
        expect(response.status).toBe(401)
        // Without this header a browser never offers the credential prompt that makes the
        // web UI reachable at all.
        expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
        expect(yield* Effect.promise(() => response.text())).not.toContain("app shell")
      }),
    )

    const authorized = yield* Effect.promise(() =>
      fetch(new URL("/workspace/example", base), {
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      }),
    )
    expect(authorized.status).toBe(200)
    expect(yield* Effect.promise(() => authorized.text())).toContain("app shell")

    // `web` prints this form for a client that cannot set headers; it must reach the shell.
    const token = yield* Effect.promise(() =>
      fetch(new URL(`/?auth_token=${encodeURIComponent(btoa("opencode:secret"))}`, base)),
    )
    expect(token.status).toBe(200)

    // A wrong password is refused, not merely unmatched against a route.
    const wrong = yield* Effect.promise(() =>
      fetch(new URL("/", base), { headers: { authorization: `Basic ${btoa("opencode:wrong")}` } }),
    )
    expect(wrong.status).toBe(401)
  }),
)
