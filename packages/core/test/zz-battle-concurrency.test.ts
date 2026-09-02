import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Money } from "@opencode-ai/schema/money"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { Bus } from "@opencode-ai/core/bus"
import { Config } from "@opencode-ai/core/config"
import { Location } from "@opencode-ai/core/location"
import { Model } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Agent } from "@opencode-ai/core/agent"
import { Job } from "@opencode-ai/core/job"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Permission } from "@opencode-ai/core/permission"
import { AgentTool } from "@opencode-ai/core/tool/plugin/agent"
import { SubagentTool } from "@opencode-ai/core/tool/plugin/subagent"
import { Tool } from "@opencode-ai/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity, waitForCodeModeTool } from "./lib/tool"

// Cap = 2 concurrent, but allow 3 spawns per execution so the cap (not the ledger) is what bites.
// AgentTool.Plugin reads these at init, and init happens inside the supervisor layer below, which is
// rebuilt per test — so applying them there (rather than once at import) keeps this file's budget
// from being clobbered by another test file that sets the same variables at import time.
const applyBudget = Effect.sync(() => {
  process.env["OPENCODE_AGENT_CONCURRENCY"] = "2"
  delete process.env["POWER_AGENT_CONCURRENCY"]
  process.env["OPENCODE_AGENT_SPAWN_LIMIT"] = "50"
  delete process.env["POWER_AGENT_SPAWN_LIMIT"]
})

const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

// Observability for the concurrency check: every child execution takes real wall time, so
// overlapping children are visible as a peak in `inflight`.
const probe = { inflight: 0, peak: 0, started: 0 }

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("AgentToolConcurrency.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        const session = yield* store.get(sessionID)
        if (session === undefined) return
        completed.add(sessionID)
        probe.inflight++
        probe.started++
        probe.peak = Math.max(probe.peak, probe.inflight)
        // Long enough that three unthrottled spawns would certainly overlap.
        yield* Effect.sleep("150 millis")
        probe.inflight--
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        // Echo the child's own title so the caller can prove each value came from its own child.
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: `answer-from:${session.title}`,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const pluginSupervisor = makeLocationNode({
  service: PluginSupervisor.Service,
  layer: Layer.effect(
    PluginSupervisor.Service,
    applyBudget.pipe(
      Effect.andThen(registerToolPlugin(SubagentTool.Plugin)),
      Effect.andThen(registerToolPlugin(AgentTool.Plugin)),
      Effect.as(PluginSupervisor.Service.of({ flush: Effect.void })),
    ),
  ),
  deps: [Agent.node, Config.node, Permission.node, PluginRuntime.node, Tool.node],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  PluginRuntime.providerNode,
  LocationServiceMap.node,
])

const it = testEffect(
  AppNodeBuilder.build(nodes, [
    [SessionExecution.node, executionNode],
    [Global.node, tempGlobalLayer],
    [PluginSupervisor.node, pluginSupervisor],
  ]),
)

const withAgents = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* PluginSupervisor.Service.use((supervisor) => supervisor.flush).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((draft) => {
        draft.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

const run = (registry: Tool.Interface, sessionID: Session.ID, id: string, code: string) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id, name: "execute", input: { code } },
  })

const programOutput = (settled: { readonly output?: any }) =>
  Schema.decodeUnknownSync(Schema.Struct({ output: Schema.String }))(settled.output).output

const withTempLocation = <A, E, R>(body: (location: Location.Ref) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))))

describe("BATTLE: concurrency cap", () => {
  it.live("background: true escapes the semaphore entirely", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        probe.inflight = 0
        probe.peak = 0
        probe.started = 0
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")

        const settled = yield* run(
          registry,
          parent.id,
          "call-agent-background",
          [
            'const names = ["a","b","c","d","e","f","g","h"]',
            'const handles = await Promise.all(names.map((n) => tools.agent.spawn({ agent: "reviewer", description: n, task: "t" + n, background: true })))',
            "const done = await Promise.all(handles.map((h) => tools.agent.wait({ sessionID: h.sessionID })))",
            "return JSON.stringify({ n: done.length })",
          ].join(String.fromCharCode(10)),
        )
        console.log("BACKGROUND probe: started=" + probe.started + " peak=" + probe.peak + " (cap=2)")
        console.log("BACKGROUND output=" + JSON.stringify(programOutput(settled)))
        const kids = (yield* sessions.list({ parentID: parent.id })).data
        console.log("BACKGROUND children=" + kids.length)
        // Regression assertions (added at final revalidation; this file previously only printed
        // the probes, so it passed whether or not background respected the semaphore).
        expect(probe.started).toBe(8)
        expect(probe.peak).toBeLessThanOrEqual(2)
        expect(programOutput(settled)).toBe(JSON.stringify({ n: 8 }))
        expect(kids.length).toBe(8)
      }),
    ),
  )

  it.live("baseline: blocking spawns respect the cap", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        probe.inflight = 0
        probe.peak = 0
        probe.started = 0
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")
        yield* run(
          registry,
          parent.id,
          "call-agent-blocking",
          [
            'const names = ["a","b","c","d","e","f","g","h"]',
            'await Promise.all(names.map((n) => tools.agent.spawn({ agent: "reviewer", description: n, task: "t" + n })))',
            "return 1",
          ].join(String.fromCharCode(10)),
        )
        console.log("BLOCKING probe: started=" + probe.started + " peak=" + probe.peak + " (cap=2)")
        expect(probe.started).toBe(8)
        expect(probe.peak).toBeLessThanOrEqual(2)
      }),
    ),
  )
})
