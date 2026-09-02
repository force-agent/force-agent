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
// applyBudget also deletes the spellings a test did not ask for, which is what lets a test prove
// the POWER_ spelling alone is honored.
const budgetNames = [
  "LABHARNESS_AGENT_CONCURRENCY",
  "POWER_AGENT_CONCURRENCY",
  "OPENCODE_AGENT_CONCURRENCY",
  "LABHARNESS_AGENT_SPAWN_LIMIT",
  "LABFY_AGENT_SPAWN_LIMIT",
  "OPENCODE_AGENT_SPAWN_LIMIT",
] as const
const defaultBudget = { OPENCODE_AGENT_CONCURRENCY: "2", OPENCODE_AGENT_SPAWN_LIMIT: "3" }
let budget: Record<string, string> = defaultBudget
const setBudget = (next: Record<string, string>) => {
  budget = next
}
const applyBudget = Effect.sync(() => {
  for (const name of budgetNames) {
    const value = budget[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
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

describe("AgentTool concurrency", () => {
  it.live("agent.spawn resolves out of the live registry with a callable signature", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        setBudget(defaultBudget)
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        const snapshot = yield* waitForCodeModeTool(registry, "agent.spawn")
        const entry = snapshot.codeModeCatalog?.find((tool) => tool.path === "agent.spawn")
        expect(entry).toBeDefined()
        console.log("CATALOG ENTRY agent.spawn ->\n" + JSON.stringify(entry, null, 2))
        console.log(
          "CATALOG PATHS (agent.*) -> " +
            JSON.stringify(snapshot.codeModeCatalog?.map((t) => t.path).filter((p) => p.startsWith("agent."))),
        )
      }),
    ),
  )

  it.live("Promise.all fans out real concurrent children and returns each answer as a program value", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        setBudget(defaultBudget)
        probe.inflight = 0
        probe.peak = 0
        probe.started = 0
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")

        const started = Date.now()
        const settled = yield* run(
          registry,
          parent.id,
          "call-agent-parallel",
          [
            "const results = await Promise.all([",
            '  tools.agent.spawn({ agent: "reviewer", description: "alpha", task: "task alpha" }),',
            '  tools.agent.spawn({ agent: "reviewer", description: "bravo", task: "task bravo" }),',
            '  tools.agent.spawn({ agent: "reviewer", description: "charlie", task: "task charlie" }),',
            "])",
            "return JSON.stringify(results.map((r) => ({ id: r.sessionID, status: r.status, out: r.output })))",
          ].join("\n"),
        )
        const elapsed = Date.now() - started
        expect(settled.status).toBe("completed")

        const results = JSON.parse(programOutput(settled)) as Array<{ id: string; status: string; out: string }>
        expect(results).toHaveLength(3)
        // Each entry is a distinct child, and each value is that child's OWN answer.
        expect(new Set(results.map((r) => r.id)).size).toBe(3)
        expect(results.map((r) => r.status)).toEqual(["completed", "completed", "completed"])
        expect(results[0]!.out).toContain("answer-from:alpha")
        expect(results[1]!.out).toContain("answer-from:bravo")
        expect(results[2]!.out).toContain("answer-from:charlie")

        // Check 5: with the cap at 2, three simultaneous spawns never run three at a time...
        console.log(`concurrency probe: started=${probe.started} peak=${probe.peak} elapsed=${elapsed}ms`)
        expect(probe.started).toBe(3)
        expect(probe.peak).toBe(2)
        // ...but they are genuinely concurrent, not serialized: 3 x 150ms serial = 450ms+,
        // whereas 2-at-a-time is ~300ms.
        expect(elapsed).toBeLessThan(440)

        // Check 4: every child hangs off the parent via the parentID filter.
        const children = (yield* sessions.list({ parentID: parent.id })).data
        expect(children).toHaveLength(3)
        expect(children.every((c) => c.parentID === parent.id)).toBe(true)
        expect(new Set(children.map((c) => c.id as string))).toEqual(new Set(results.map((r) => r.id)))
        // ...and the roots-only filter (parentID: null) excludes every one of them.
        const roots = (yield* sessions.list({ parentID: null })).data.map((s) => s.id)
        expect(roots).toContain(parent.id)
        for (const child of children) expect(roots).not.toContain(child.id)
        // Sanity: an unfiltered list does see them, so the filter above is doing real work.
        const all = (yield* sessions.list({})).data.map((s) => s.id)
        for (const child of children) expect(all).toContain(child.id)
      }),
    ),
  )

  it.live("blowing the per-execution ceiling fails loudly instead of hanging", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        setBudget(defaultBudget)
        probe.inflight = 0
        probe.peak = 0
        probe.started = 0
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")

        // SPAWN_LIMIT is 3 in this file: the 4th spawn of one execution must be refused.
        const settled = yield* run(
          registry,
          parent.id,
          "call-agent-overflow",
          [
            'const t = { agent: "reviewer", task: "audit" }',
            "for (let i = 0; i < 8; i++) await tools.agent.spawn(t)",
            'return "unreachable"',
          ].join("\n"),
        )
        const text = programOutput(settled)
        expect(text).not.toContain("unreachable")
        expect(text).toContain("Subagent spawn limit reached for this execution (3)")
        // The guard refuses, it does not leak extra children.
        expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(3)
      }),
    ),
  )
  // Regression: `background: true` used to skip `permits.withPermit` outright, so the cap only
  // governed blocking spawns and a fan-out of background children ran unbounded (measured peak 8
  // against a cap of 2). The permit now covers the child's execution - taken before the child is
  // started, released by a watcher fiber once its job settles - so the peak holds in both modes.
  it.live("background spawns respect the concurrency cap while still returning handles", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        setBudget({ OPENCODE_AGENT_CONCURRENCY: "2", OPENCODE_AGENT_SPAWN_LIMIT: "50" })
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
          "call-agent-background-cap",
          [
            'const names = ["a", "b", "c", "d", "e", "f"]',
            "const handles = await Promise.all(",
            '  names.map((n) => tools.agent.spawn({ agent: "reviewer", description: n, task: "t" + n, background: true })),',
            ")",
            "const done = await Promise.all(handles.map((h) => tools.agent.wait({ sessionID: h.sessionID })))",
            'const running = handles.filter((h) => h.status === "running").length',
            "return JSON.stringify({ running, ids: handles.map((h) => h.sessionID), outputs: done.map((d) => d.output) })",
          ].join("\n"),
        )
        expect(settled.status).toBe("completed")
        const result = JSON.parse(programOutput(settled)) as {
          running: number
          ids: string[]
          outputs: string[]
        }
        console.log(`background probe: started=${probe.started} peak=${probe.peak} (cap=2)`)

        // Every spawn still handed back a handle instead of the child's answer.
        expect(result.running).toBe(6)
        expect(new Set(result.ids).size).toBe(6)
        // The cap holds: six background children never ran more than two at a time.
        expect(probe.started).toBe(6)
        expect(probe.peak).toBe(2)
        // ...and throttling cost no answer: agent.wait collected all six.
        expect(result.outputs).toHaveLength(6)
        for (const name of ["a", "b", "c", "d", "e", "f"])
          expect(result.outputs.some((out) => out.includes(`answer-from:${name}`))).toBe(true)
        expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(6)
      }),
    ),
  )

  // Regression: the budget was read straight off `process.env["OPENCODE_..."]`, so an operator who
  // followed the overlay's documented POWER_ convention was silently handed the defaults.
  it.live("POWER_AGENT_CONCURRENCY alone caps the fan-out", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        // POWER_ only: with the OPENCODE_ spelling absent, the old code fell back to the default 8
        // and all three children overlapped.
        setBudget({ POWER_AGENT_CONCURRENCY: "1", LABHARNESS_AGENT_SPAWN_LIMIT: "50" })
        probe.inflight = 0
        probe.peak = 0
        probe.started = 0
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")
        expect(process.env["OPENCODE_AGENT_CONCURRENCY"]).toBeUndefined()

        yield* run(
          registry,
          parent.id,
          "call-agent-power-concurrency",
          [
            'const names = ["a", "b", "c"]',
            'await Promise.all(names.map((n) => tools.agent.spawn({ agent: "reviewer", description: n, task: "t" + n })))',
            "return 1",
          ].join("\n"),
        )
        console.log(`POWER_ concurrency probe: started=${probe.started} peak=${probe.peak} (cap=1)`)
        expect(probe.started).toBe(3)
        expect(probe.peak).toBe(1)
      }),
    ),
  )

  it.live("LABHARNESS_AGENT_SPAWN_LIMIT alone caps the per-execution ledger", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        setBudget({ POWER_AGENT_CONCURRENCY: "2", LABHARNESS_AGENT_SPAWN_LIMIT: "2" })
        probe.inflight = 0
        probe.peak = 0
        probe.started = 0
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")
        expect(process.env["OPENCODE_AGENT_SPAWN_LIMIT"]).toBeUndefined()

        const settled = yield* run(
          registry,
          parent.id,
          "call-agent-power-limit",
          [
            'const t = { agent: "reviewer", task: "audit" }',
            "for (let i = 0; i < 5; i++) await tools.agent.spawn(t)",
            'return "unreachable"',
          ].join("\n"),
        )
        const text = programOutput(settled)
        expect(text).not.toContain("unreachable")
        expect(text).toContain("Subagent spawn limit reached for this execution (2)")
        expect(text).toContain("LABHARNESS_AGENT_SPAWN_LIMIT")
        expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(2)
      }),
    ),
  )
})
