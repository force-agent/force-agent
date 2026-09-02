export * as ServerProcess from "./server-process"

import { NodeServices } from "@effect/platform-node"
import { Service, type DiscoverOptions } from "@opencode-ai/client/effect/service"
import { BindPolicy } from "@opencode-ai/server/bind-policy"
import { ServerAuth } from "@opencode-ai/server/auth"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { env, truthy as brandedTruthy } from "@opencode-ai/util/env"
import { OPENCODE_CHANNEL, OPENCODE_VERSION } from "./version"
import { AppProcess } from "@opencode-ai/util/process"
import { randomBytes, randomUUID } from "node:crypto"
import { Deferred, Effect, Option, Schedule, Schema } from "effect"
import { PersistentPty } from "@opencode-ai/schema/persistent-pty"
import { HttpServer } from "effect/unstable/http"
import { Env } from "./env"
import { RestartHandoff } from "./services/restart-handoff"
import { SelfUpdateApplier } from "./services/self-update-applier"
import { ServiceConfig } from "./services/service-config"
import { ServiceRegistration } from "./services/service-registration"
import { Updater } from "./services/updater"
import { WebAccess } from "./services/web-access"
import { WebUi } from "./services/web-ui"

export type Mode = "default" | "service" | "stdio"

/**
 * The models.dev catalog source, read through the branded env helper.
 *
 * force-agent overlay: these three were read straight off `process.env.OPENCODE_*`,
 * so `LABHARNESS_MODELS_URL` was accepted by the shell and then ignored — the binary
 * went on calling the default catalog host with no way for the operator to
 * notice. Exported so a test can assert the resolution without booting a server.
 */
export function models() {
  return {
    url: env("MODELS_URL"),
    file: env("MODELS_PATH"),
    fetch: !brandedTruthy("DISABLE_MODELS_FETCH"),
  }
}

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  /**
   * force-agent overlay: what to print once the socket is up. `server` is the upstream listen
   * line, aimed at an operator wiring up a client. `web` prints the browser access block —
   * URLs plus the credential the embedded UI will demand — because a bare URL is not usable
   * against an authenticated web UI. Defaults to `server`.
   */
  readonly announce?: "server" | "web"
  /** Print the password even when stdout is not a terminal (`--show-credentials`). */
  readonly showCredentials?: boolean
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const run = Effect.fnUntraced(function* (options: Options) {
  return yield* processEffect(options).pipe(
    Effect.provide(Updater.layer),
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), [
        [Global.node, Global.layerWith(env("CONFIG_DIR") ? { config: env("CONFIG_DIR")! } : {})],
      ]),
    ),
    Effect.provide(NodeServices.layer),
  )
})

const processEffect = Effect.fnUntraced(function* (options: Options) {
  const inherited = process.env.OPENCODE_PTY_HANDOFF
  delete process.env.OPENCODE_PTY_HANDOFF
  const handoff =
    inherited === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
          Effect.mapError(() => new Error("Invalid PTY restart handoff")),
        )
  const global = yield* Global.Service
  if (options.mode === "service") yield* Effect.sync(() => process.chdir(global.home))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const foreground = options.mode === "default"
      const serviceOptions = options.mode === "service" ? yield* ServiceConfig.options() : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      const incumbent =
        serviceOptions !== undefined && port !== undefined
          ? yield* Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })
          : undefined
      if (incumbent !== undefined) return
      const { start } = yield* Effect.promise(() => import("@opencode-ai/server/process"))
      const environmentPassword = yield* Env.configuredPassword
      // Keep the lease credential out of the environment inherited by tools.
      if (options.mode === "stdio") {
        for (const key of Env.passwordKeys) delete process.env[key]
      }
      // A secret that is empty or only whitespace is not a secret: it is dropped
      // here so it can neither become the server password nor pass the bind
      // check as an operator-configured credential.
      const configured = options.mode === "service" ? config.password : environmentPassword
      const supplied = ServerAuth.usable(configured) ? configured : undefined
      // force-agent overlay: `web` restarted by the shim after a self-update takes the
      // password of the process it replaces (see RestartHandoff), so the browser's cached
      // Basic credential keeps working. Only when the operator did not pin one.
      const web = options.mode === "default" && options.announce === "web"
      const restarted = web && supplied === undefined ? yield* RestartHandoff.consume() : undefined
      const password = supplied ?? restarted?.password ?? randomBytes(32).toString("base64url")
      // The authoritative bind check: hostname and credential are both settled
      // here, after flags and service config. A reachable interface without an
      // operator-configured password is refused, not warned about.
      yield* BindPolicy.assert({ hostname, credential: BindPolicy.classify(supplied) })
      const instanceID = randomUUID()
      const transform = yield* WebUi.handler()
      // `web` runs with a lifecycle too: that is what makes the server resume the turns
      // whose execution claim survived the previous process (restart continuity), and it
      // hands the bound port plus the shutdown latch to the self-update applier.
      const listening = yield* Deferred.make<SelfUpdateApplier.Listening>()
      const overrides = web
        ? [
            (yield* Effect.promise(() => import("@opencode-ai/server/self-update"))).SelfUpdateApplier.override(
              yield* SelfUpdateApplier.make({ password, hostname, configured: supplied !== undefined, listening }),
            ),
          ]
        : []
      const server = yield* start(
        {
          app: {
            name: process.env.OPENCODE_CLIENT ?? "cli",
            version: OPENCODE_VERSION,
            channel: OPENCODE_CHANNEL,
          },
          hostname,
          port: port ?? restarted?.port,
          password,
          pty: { handoff },
          simulation: brandedTruthy("SIMULATE"),
          database: {
            path:
              env("DB") ??
              (["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
              brandedTruthy("DISABLE_CHANNEL_DB")
                ? "opencode.db"
                : `opencode-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`),
          },
          models: models(),
          config: {
            directory: env("CONFIG_DIR"),
            project: !truthy(
              process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
            ),
            file: env("CONFIG"),
            content: env("CONFIG_CONTENT"),
          },
          windows: {
            gitbash: process.env.OPENCODE_GIT_BASH_PATH,
          },
          fs: {
            filewatcher: !truthy(process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER),
            fff:
              process.env.OPENCODE_DISABLE_FFF === undefined
                ? process.platform !== "win32"
                : !truthy(process.env.OPENCODE_DISABLE_FFF),
          },
        },
        serviceOptions === undefined
          ? web
            ? {
                onListen: (address, shutdown) =>
                  Deferred.succeed(listening, {
                    port: Number(new URL(HttpServer.formatAddress(address)).port),
                    shutdown,
                  }).pipe(Effect.as(Effect.void)),
              }
            : undefined
          : {
              onListen: (address, shutdown) =>
                Effect.gen(function* () {
                  if (!config.password) yield* ServiceConfig.password(password)
                  return yield* ServiceRegistration.register({
                    address,
                    password,
                    id: instanceID,
                    file: serviceOptions.file,
                    shutdown,
                  })
                }),
            },
        transform,
        overrides,
      ).pipe(
        Effect.catch((error) => {
          if (serviceOptions === undefined || port === undefined || !addressInUse(error)) return Effect.fail(error)
          return recognizeIncumbent(serviceOptions, hostname, port).pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.void
                : Effect.fail(
                    new Error(
                      `Managed service port ${port} on ${hostname} is already in use by another process. ` +
                        "Configure another port with `opencode service set port <port>` and start the service again.",
                      { cause: error },
                    ),
                  ),
            ),
          )
        }),
      )
      if (server === undefined) return
      const url = HttpServer.formatAddress(server.address)
      // A non-terminal stdout is a log or the journal: the credential stays out of it unless asked for.
      const reveal = process.stdout.isTTY || options.showCredentials === true
      if (options.mode === "stdio") console.log(JSON.stringify({ url }))
      else if (options.announce === "web")
        process.stdout.write(
          WebAccess.render({
            address: url,
            hostname,
            username: "opencode",
            password,
            configured: supplied !== undefined,
            reveal,
            restarted: restarted !== undefined,
          }),
        )
      else {
        console.log(`server listening on ${url}`)
        if (foreground && !environmentPassword)
          console.log(`server password ${reveal ? password : WebAccess.hidden({ configured: false }, "serve")}`)
      }
      const updater = yield* Updater.Service
      yield* updater.check().pipe(Effect.schedule(Schedule.spaced("10 minutes")), Effect.forkScoped)
      // `web` waits on the shutdown latch (opened by the self-update restart) instead of
      // forever, so the process can return and exit with the shim's restart code.
      return yield* options.mode === "service" || web
        ? server.shutdown
        : options.mode === "stdio"
          ? waitForStdinClose()
          : Effect.never
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

const recognizeIncumbent = Effect.fnUntraced(function* (options: DiscoverOptions, hostname: string, port: number) {
  const found = yield* Service.incumbent({ ...options, url: serviceURL(hostname, port) }).pipe(
    Effect.filterOrFail((value) => value !== undefined),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeoutOption("15 seconds"),
  )
  return Option.isSome(found)
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}
