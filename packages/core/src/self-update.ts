export * as SelfUpdate from "./self-update.js"

import { InstallationEvent } from "@opencode-ai/schema/installation-event"
import { SelfUpdate } from "@opencode-ai/schema/self-update"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { httpClient } from "@opencode-ai/util/effect/app-node-platform"
import { differentRelease } from "@opencode-ai/util/release-version"
import { Context, Effect, Layer, Ref, Result, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { App } from "./app.js"
import { Bus } from "./bus.js"

export type Status = SelfUpdate.Status
export type Phase = SelfUpdate.Phase

/** What the host knows about how this binary was installed and whether it can replace it. */
export interface Detection {
  readonly manager: SelfUpdate.Manager
  readonly canApply: boolean
  readonly reason?: SelfUpdate.Reason
  /** Manual command shown when the update cannot be applied from the UI. */
  readonly command?: string
}

/**
 * Host-provided strategy that performs the install and the restart. Core only owns the
 * phase machine; without an applier every status reports `canApply: false, reason: "disabled"`
 * (the SDK and workerd profiles get that for free).
 */
export interface Applier {
  readonly detect: () => Effect.Effect<Detection>
  /** Errors may carry a `hint` (e.g. `sudo npm i -g …`) that is surfaced in the error phase. */
  readonly install: (version: string) => Effect.Effect<void, Error>
  readonly restart: (version: string) => Effect.Effect<void>
}

export interface Options {
  readonly applier?: Applier
  readonly packageName?: string
  readonly tag?: string
  readonly registry?: string
}

export class NotApplicable extends Schema.TaggedError<NotApplicable>()("SelfUpdate.NotApplicable", {
  message: Schema.String,
}) {}

export class Busy extends Schema.TaggedError<Busy>()("SelfUpdate.Busy", {
  message: Schema.String,
  phase: SelfUpdate.Phase,
}) {}

export class CheckFailed extends Schema.TaggedError<CheckFailed>()("SelfUpdate.CheckFailed", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Current status without touching the network. */
  readonly status: () => Effect.Effect<Status>
  /** Ask the npm registry for the latest version; failures land in the `error` phase, never in the error channel. */
  readonly check: () => Effect.Effect<Status>
  /** Start installing `version` (default: latest). Returns the accepted status while the install runs in the background. */
  readonly apply: (version?: string) => Effect.Effect<Status, NotApplicable | Busy | CheckFailed>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SelfUpdate") {}

export const Event = {
  UpdateAvailable: InstallationEvent.UpdateAvailable,
  UpdateState: InstallationEvent.UpdateState,
}

const disabled: Detection = { manager: "unknown", canApply: false, reason: "disabled" }
const RegistryBody = Schema.Struct({ version: Schema.String })

interface State {
  readonly latest?: string
  readonly checkedAt?: number
  readonly detection?: Detection
  readonly phase: Phase
}

export function layer(options: Options = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const app = yield* App.Metadata
      const bus = yield* Bus.Service
      const http = yield* HttpClient.HttpClient
      const scope = yield* Effect.scope
      const packageName = options.packageName ?? "force-agent"
      const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "")
      const url = `${registry}/${encodeURIComponent(packageName)}/${encodeURIComponent(options.tag ?? "latest")}`
      const state = yield* Ref.make<State>({ phase: { type: "idle" } })
      // One mutex for every transition: check, apply and the background install serialize here.
      const lock = Semaphore.makeUnsafe(1)

      const toStatus = (current: State): Status => {
        const detection = current.detection ?? disabled
        // Optional keys are omitted rather than set to undefined so the wire encoding never carries `null`.
        return {
          current: app.version,
          ...(current.latest !== undefined ? { latest: current.latest } : {}),
          available: current.latest !== undefined && differentRelease(app.version, current.latest),
          manager: detection.manager,
          canApply: detection.canApply,
          ...(detection.reason !== undefined ? { reason: detection.reason } : {}),
          ...(detection.command !== undefined ? { command: detection.command } : {}),
          ...(current.checkedAt !== undefined ? { checkedAt: current.checkedAt } : {}),
          phase: current.phase,
        }
      }

      const status = () => Ref.get(state).pipe(Effect.map(toStatus))

      const transition = Effect.fnUntraced(function* (update: (current: State) => State) {
        const next = yield* Ref.updateAndGet(state, update)
        const snapshot = toStatus(next)
        yield* bus.publish(Event.UpdateState, { status: snapshot })
        return snapshot
      })

      const detect = Effect.fnUntraced(function* () {
        const current = yield* Ref.get(state)
        if (current.detection) return current.detection
        const detection = options.applier ? yield* options.applier.detect() : disabled
        yield* Ref.update(state, (value) => ({ ...value, detection }))
        return detection
      })

      const fetchLatest = Effect.fn("SelfUpdate.fetchLatest")(function* () {
        return yield* HttpClientRequest.get(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("User-Agent", App.useragent(app)),
          HttpClient.filterStatusOk(http).execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RegistryBody)),
          Effect.map((body) => body.version.trim()),
          Effect.timeout("10 seconds"),
          Effect.mapError((cause) => new Error(`Update check failed: ${describe(cause)}`, { cause })),
        )
      })

      const check = Effect.fn("SelfUpdate.check")(function* () {
        yield* detect()
        return yield* lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            // An install in flight owns the phase; report it instead of clobbering it.
            if (current.phase.type === "installing" || current.phase.type === "restarting") return toStatus(current)
            yield* transition((value) => ({ ...value, phase: { type: "checking" } }))
            const result = yield* fetchLatest().pipe(Effect.result)
            if (Result.isFailure(result)) {
              return yield* transition((value) => ({
                ...value,
                phase: { type: "error", message: result.failure.message },
              }))
            }
            const latest = result.success
            const snapshot = yield* transition((value) => ({
              ...value,
              latest,
              checkedAt: Date.now(),
              phase: { type: "idle" },
            }))
            if (snapshot.available) yield* bus.publish(Event.UpdateAvailable, { version: latest })
            return snapshot
          }),
        )
      })

      const install = Effect.fnUntraced(function* (applier: Applier, version: string) {
        const result = yield* applier.install(version).pipe(Effect.result)
        if (Result.isFailure(result)) {
          yield* transition((value) => ({
            ...value,
            phase: { type: "error", message: result.failure.message, hint: hintOf(result.failure) },
          }))
          return
        }
        yield* transition((value) => ({
          ...value,
          phase: { type: "restarting", version, pid: process.pid ?? 0 },
        }))
        yield* applier.restart(version)
      })

      const apply = Effect.fn("SelfUpdate.apply")(function* (requested?: string) {
        const detection = yield* detect()
        if (!detection.canApply)
          return yield* new NotApplicable({
            message: detection.command
              ? `This installation cannot update itself. Run: ${detection.command}`
              : "This installation cannot update itself.",
          })
        if ((yield* Ref.get(state)).latest === undefined) yield* check()
        return yield* lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            if (current.phase.type === "installing" || current.phase.type === "restarting")
              return yield* new Busy({ message: "An update is already in progress.", phase: current.phase })
            if (current.latest === undefined)
              return yield* new CheckFailed({
                message: current.phase.type === "error" ? current.phase.message : "The latest version is unknown.",
              })
            const version = requested ?? current.latest
            if (version !== current.latest)
              return yield* new NotApplicable({
                message: `Only the latest version (${current.latest}) can be installed, not ${version}.`,
              })
            if (!differentRelease(app.version, version))
              return yield* new NotApplicable({ message: `Version ${version} is already installed.` })
            const snapshot = yield* transition((value) => ({ ...value, phase: { type: "installing", version } }))
            yield* install(options.applier!, version).pipe(Effect.forkIn(scope))
            return snapshot
          }),
        )
      })

      return Service.of({ status, check, apply })
    }),
  )
}

function hintOf(error: Error) {
  const hint = (error as { hint?: unknown }).hint
  return typeof hint === "string" ? hint : undefined
}

function describe(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [App.node, Bus.node, httpClient] })
}

export const node = configured()
