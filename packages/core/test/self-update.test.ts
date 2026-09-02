import { describe, expect } from "bun:test"
import { App } from "@opencode-ai/core/app"
import { Bus } from "@opencode-ai/core/bus"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SelfUpdate } from "@opencode-ai/core/self-update"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"
import { LayerNodePlatform } from "@opencode-ai/util/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { it } from "./lib/effect"

interface Registry {
  readonly status: number
  readonly body: string
  readonly hang?: boolean
}

const okRegistry = (version: string): Registry => ({ status: 200, body: JSON.stringify({ version }) })

const build = (registry: Ref.Ref<Registry>, options: SelfUpdate.Options = {}, current = "1.0.0") =>
  Layer.fresh(
    AppNodeBuilder.build(LayerNode.group([SelfUpdate.node, Bus.node]), [
      [SelfUpdate.node, SelfUpdate.configured(options)],
      [App.node, App.configured({ version: current })],
      [
        LayerNodePlatform.httpClient,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const state = yield* Ref.get(registry)
              if (state.hang) return yield* Effect.never
              return HttpClientResponse.fromWeb(request, new Response(state.body, { status: state.status }))
            }),
          ),
        ),
      ],
    ]),
  )

const untilPhase = (type: SelfUpdate.Status["phase"]["type"]) =>
  Effect.gen(function* () {
    const service = yield* SelfUpdate.Service
    return yield* service
      .status()
      .pipe(Effect.repeat({ until: (status) => status.phase.type === type, schedule: Schedule.spaced("5 millis") }))
  })

const applier = (input: {
  readonly install?: (version: string) => Effect.Effect<void, Error>
  readonly restarted: Ref.Ref<string[]>
}): SelfUpdate.Applier => ({
  detect: () => Effect.succeed({ manager: "npm", canApply: true, command: "npm install --global labharness@latest" }),
  install: input.install ?? (() => Effect.void),
  restart: (version) => Ref.update(input.restarted, (list) => [...list, version]),
})

describe("SelfUpdate", () => {
  it.live("reports a newer registry version and publishes update-available", () =>
    Effect.gen(function* () {
      const registry = yield* Ref.make(okRegistry("1.1.0"))
      yield* Effect.gen(function* () {
        const service = yield* SelfUpdate.Service
        const bus = yield* Bus.Service
        const events = yield* bus
          .subscribe(InstallationEvent.UpdateAvailable)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow
        const before = yield* service.status()
        expect(before).toMatchObject({ current: "1.0.0", available: false, canApply: false, reason: "disabled" })
        expect(before.latest).toBeUndefined()

        const status = yield* service.check()
        expect(status).toMatchObject({
          current: "1.0.0",
          latest: "1.1.0",
          available: true,
          manager: "unknown",
          canApply: false,
          reason: "disabled",
          phase: { type: "idle" },
        })
        expect(typeof status.checkedAt).toBe("number")
        const published = yield* Fiber.join(events)
        expect(published.map((event) => event.data.version)).toEqual(["1.1.0"])
      }).pipe(Effect.provide(build(registry)))
    }),
  )

  it.live("treats the same release as up to date", () =>
    Effect.gen(function* () {
      const registry = yield* Ref.make(okRegistry("1.0.0"))
      const status = yield* SelfUpdate.Service.use((service) => service.check()).pipe(Effect.provide(build(registry)))
      expect(status).toMatchObject({ latest: "1.0.0", available: false, phase: { type: "idle" } })
    }),
  )

  it.live("turns a registry 404 into an error phase without a latest version", () =>
    Effect.gen(function* () {
      const registry = yield* Ref.make<Registry>({ status: 404, body: "Not Found" })
      const status = yield* SelfUpdate.Service.use((service) => service.check()).pipe(Effect.provide(build(registry)))
      expect(status.latest).toBeUndefined()
      expect(status.available).toBe(false)
      expect(status.checkedAt).toBeUndefined()
      expect(status.phase.type).toBe("error")
      if (status.phase.type === "error") expect(status.phase.message).toContain("404")
    }),
  )

  it.effect("times out a hanging registry after 10 seconds", () =>
    Effect.gen(function* () {
      const registry = yield* Ref.make<Registry>({ status: 200, body: "", hang: true })
      yield* Effect.gen(function* () {
        const service = yield* SelfUpdate.Service
        const fiber = yield* service.check().pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect((yield* service.status()).phase).toEqual({ type: "checking" })
        yield* TestClock.adjust("11 seconds")
        const status = yield* Fiber.join(fiber)
        expect(status.phase.type).toBe("error")
        expect(status.latest).toBeUndefined()
      }).pipe(Effect.provide(build(registry)))
    }),
  )

  it.live("walks installing → restarting and refuses a second apply while busy", () =>
    Effect.gen(function* () {
      const registry = yield* Ref.make(okRegistry("1.1.0"))
      const gate = yield* Deferred.make<void>()
      const restarted = yield* Ref.make<string[]>([])
      yield* Effect.gen(function* () {
        const service = yield* SelfUpdate.Service
        const bus = yield* Bus.Service
        const states = yield* bus.subscribe(InstallationEvent.UpdateState).pipe(
          Stream.map((event) => event.data.status.phase.type),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* Effect.yieldNow

        const detected = yield* service.check()
        expect(detected).toMatchObject({ manager: "npm", canApply: true, available: true })

        const accepted = yield* service.apply()
        expect(accepted.phase).toEqual({ type: "installing", version: "1.1.0" })

        const again = yield* service.apply().pipe(Effect.exit)
        expect(Exit.isFailure(again)).toBe(true)
        if (Exit.isFailure(again)) expect(String(again.cause)).toContain("SelfUpdate.Busy")

        yield* Deferred.succeed(gate, undefined)
        const restarting = yield* untilPhase("restarting")
        expect(restarting.phase).toMatchObject({ type: "restarting", version: "1.1.0", pid: process.pid })
        expect(yield* Ref.get(restarted)).toEqual(["1.1.0"])
        expect([...(yield* Fiber.join(states))]).toEqual(["checking", "idle", "installing"])
      }).pipe(
        Effect.provide(
          build(registry, {
            applier: applier({ restarted, install: () => Deferred.await(gate) }),
          }),
        ),
      )
    }),
  )

  it.live("keeps the failed install in the error phase and never restarts", () =>
    Effect.gen(function* () {
      const registry = yield* Ref.make(okRegistry("1.1.0"))
      const restarted = yield* Ref.make<string[]>([])
      yield* Effect.gen(function* () {
        const service = yield* SelfUpdate.Service
        yield* service.check()
        yield* service.apply("1.1.0")
        const failed = yield* untilPhase("error")
        expect(failed.phase).toEqual({
          type: "error",
          message: "EACCES: permission denied",
          hint: "sudo npm i -g force-agent",
        })
        expect(yield* Ref.get(restarted)).toEqual([])
        // The failure is not sticky: a new apply may be attempted.
        const retry = yield* service.apply("1.1.0")
        expect(retry.phase.type).toBe("installing")
      }).pipe(
        Effect.provide(
          build(registry, {
            applier: applier({
              restarted,
              install: () =>
                Effect.fail(
                  Object.assign(new Error("EACCES: permission denied"), { hint: "sudo npm i -g force-agent" }),
                ),
            }),
          }),
        ),
      )
    }),
  )

  it.live("rejects apply when nothing can be applied or the version is not the latest", () =>
    Effect.gen(function* () {
      const registry = yield* Ref.make(okRegistry("1.1.0"))
      const disabled = yield* SelfUpdate.Service.use((service) => service.apply()).pipe(
        Effect.exit,
        Effect.provide(build(registry)),
      )
      expect(Exit.isFailure(disabled)).toBe(true)
      if (Exit.isFailure(disabled)) expect(String(disabled.cause)).toContain("SelfUpdate.NotApplicable")

      const restarted = yield* Ref.make<string[]>([])
      const stale = yield* SelfUpdate.Service.use((service) => service.apply("1.0.5")).pipe(
        Effect.exit,
        Effect.provide(build(registry, { applier: applier({ restarted }) })),
      )
      expect(Exit.isFailure(stale)).toBe(true)
      if (Exit.isFailure(stale)) expect(String(stale.cause)).toContain("SelfUpdate.NotApplicable")

      const unreachable = yield* Ref.make<Registry>({ status: 500, body: "boom" })
      const noLatest = yield* SelfUpdate.Service.use((service) => service.apply()).pipe(
        Effect.exit,
        Effect.provide(build(unreachable, { applier: applier({ restarted }) })),
      )
      expect(Exit.isFailure(noLatest)).toBe(true)
      if (Exit.isFailure(noLatest)) expect(String(noLatest.cause)).toContain("SelfUpdate.CheckFailed")
    }),
  )
})
