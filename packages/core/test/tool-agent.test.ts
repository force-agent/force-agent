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

// Read once when the plugin initializes, so the whole file shares this budget.
process.env["OPENCODE_AGENT_CONCURRENCY"] = "2"
process.env["OPENCODE_AGENT_SPAWN_LIMIT"] = "2"

const childText = "child final response"
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("AgentToolTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        if ((yield* store.get(sessionID)) === undefined) return
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: childText })
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
    // Order matters: AgentTool delegates to the registration SubagentTool adds.
    registerToolPlugin(SubagentTool.Plugin).pipe(
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
        draft.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
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

describe("AgentTool", () => {
  it.live("exposes agent.* in the Code Mode catalog while subagent stays a direct tool", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

        const snapshot = yield* waitForCodeModeTool(registry, "agent.spawn")
        const paths = snapshot.codeModeCatalog?.map((entry) => entry.path) ?? []
        expect(paths).toContain("agent.spawn")
        expect(paths).toContain("agent.wait")
        expect(paths).toContain("agent.list")
        expect(paths).toContain("agent.stop")
        const names = snapshot.definitions.map((tool) => tool.name)
        expect(names).toContain(SubagentTool.name)
        expect(names).toContain("execute")
        expect(names).not.toContain("agent_spawn")
      }),
    ),
  )

  it.live("spawns a child from Code Mode and lists, waits, and stops it", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")

        const spawned = yield* run(
          registry,
          parent.id,
          "call-agent-spawn",
          [
            'const child = await tools.agent.spawn({ agent: "reviewer", task: "review this" })',
            "const listed = await tools.agent.list({})",
            "return JSON.stringify({ child, listed })",
          ].join("\n"),
        )
        expect(spawned.status).toBe("completed")
        const result = JSON.parse(programOutput(spawned))
        expect(result.child.status).toBe("completed")
        expect(result.child.output).toContain(childText)
        expect(result.listed.children).toHaveLength(1)
        expect(result.listed.children[0].sessionID).toBe(result.child.sessionID)

        const child = yield* sessions.get(Session.ID.make(result.child.sessionID))
        expect(child).toMatchObject({ parentID: parent.id, agent: "reviewer", model: childModel })

        // wait replays the settled answer, and stop reports that nothing was running.
        const replayed = yield* run(
          registry,
          parent.id,
          "call-agent-wait",
          [
            `const done = await tools.agent.wait({ sessionID: ${JSON.stringify(child.id)} })`,
            `const halted = await tools.agent.stop({ sessionID: ${JSON.stringify(child.id)} })`,
            "return JSON.stringify({ done, halted })",
          ].join("\n"),
        )
        expect(replayed.status).toBe("completed")
        const replay = JSON.parse(programOutput(replayed))
        expect(replay.done).toMatchObject({ sessionID: child.id, status: "completed" })
        expect(replay.done.output).toContain(childText)
        expect(replay.halted).toEqual({ sessionID: child.id, stopped: false })
      }),
    ),
  )

  it.live("returns a handle for a background spawn that agent.wait resolves", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
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
            'const handle = await tools.agent.spawn({ agent: "reviewer", task: "background", background: true })',
            "const done = await tools.agent.wait({ sessionID: handle.sessionID })",
            "return JSON.stringify({ handle, done })",
          ].join("\n"),
        )
        expect(settled.status).toBe("completed")
        const result = JSON.parse(programOutput(settled))
        expect(result.handle.status).toBe("running")
        expect(result.done.sessionID).toBe(result.handle.sessionID)
        expect(result.done.status).toBe("completed")
        expect(result.done.output).toContain(childText)
      }),
    ),
  )

  it.live("inherits the parent model unless the spawn overrides it", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")

        const settled = yield* run(
          registry,
          parent.id,
          "call-agent-model",
          [
            'const inherited = await tools.agent.spawn({ agent: "fallback", task: "inherit" })',
            'const overridden = await tools.agent.spawn({ agent: "fallback", task: "override", model: "test/override#fast" })',
            "return JSON.stringify([inherited.sessionID, overridden.sessionID])",
          ].join("\n"),
        )
        const [inherited, overridden] = JSON.parse(programOutput(settled)) as [string, string]
        expect(yield* sessions.get(Session.ID.make(inherited))).toMatchObject({ model: parentModel })
        expect(yield* sessions.get(Session.ID.make(overridden))).toMatchObject({
          model: { providerID: "test", id: "override", variant: "fast" },
        })
      }),
    ),
  )

  it.live("rejects a child that belongs to another session and caps spawns per execution", () =>
    withTempLocation((location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        const stranger = yield* sessions.create({ location, model: parentModel })
        yield* withAgents(parent.location)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* waitForCodeModeTool(registry, "agent.spawn")

        const foreign = yield* run(
          registry,
          parent.id,
          "call-agent-foreign",
          `return await tools.agent.wait({ sessionID: ${JSON.stringify(stranger.id)} })`,
        )
        expect(programOutput(foreign)).toContain("is not a child of the current session")

        // OPENCODE_AGENT_SPAWN_LIMIT is 2 for this file; the third spawn in one program is refused.
        const capped = yield* run(
          registry,
          parent.id,
          "call-agent-cap",
          [
            'const task = { agent: "reviewer", task: "audit" }',
            "await tools.agent.spawn(task)",
            "await tools.agent.spawn(task)",
            "await tools.agent.spawn(task)",
            'return "unreachable"',
          ].join("\n"),
        )
        expect(programOutput(capped)).toContain("Subagent spawn limit reached for this execution (2)")
        expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(2)

        // A separate execution gets its own budget.
        const fresh = yield* run(
          registry,
          parent.id,
          "call-agent-fresh",
          'return (await tools.agent.spawn({ agent: "reviewer", task: "audit" })).status',
        )
        expect(programOutput(fresh)).toBe("completed")
      }),
    ),
  )
})
