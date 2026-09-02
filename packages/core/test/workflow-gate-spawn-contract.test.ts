import { Agent as AgentService } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Permission } from "@opencode-ai/core/permission"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { WorkflowGatePlugin } from "@opencode-ai/core/plugin/workflow-gate"
import { AgentTool } from "@opencode-ai/core/tool/plugin/agent"
import { effectiveName } from "@opencode-ai/core/tool/runtime"
import { WorkflowPlan } from "@opencode-ai/core/workflow/plan"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import type { ToolDraft } from "@opencode-ai/plugin/effect/tool"
import { Agent } from "@opencode-ai/schema/agent"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Tool } from "@opencode-ai/schema/tool"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { host } from "./plugin/host"

/**
 * `workflow-gate.ts` matches the spawns of a running Code Mode program by registry key
 * (`SPAWN_TOOL`), and that key is produced somewhere else entirely: `effectiveName` applied to the
 * registration `tool/plugin/agent.ts` adds (`namespace` + tool name). Nothing linked the two —
 * renaming the namespace or the tool would change the key and the gate would stop seeing spawns
 * *silently*, falling back to a static script read the battle tests already showed is evadable.
 *
 * These cases derive the key from the REAL registration rather than restating "agent_spawn", so a
 * one-sided rename fails here instead of quietly disarming the gate. A rename applied to both
 * sides keeps passing, which is the point: the test pins the relationship, not the spelling.
 */

const stubs = Layer.mergeAll(
  Layer.succeed(PluginRuntime.Service, {} as unknown as PluginRuntime.Interface),
  Layer.succeed(AgentService.Service, {} as unknown as AgentService.Interface),
)

/**
 * Runs the real `AgentTool` plugin against a draft that records what it registers. Only the sink
 * is a stub: the registrations themselves — names, namespace, options — are the production ones,
 * and `effectiveName` is the same function `tool.ts` uses to key them in the registry.
 */
const registrationKeys = Effect.gen(function* () {
  const added: Tool.Info[] = []
  const draft: ToolDraft = {
    list: () => [],
    get: () => undefined,
    add: (tool) => {
      added.push(tool as Tool.Info)
    },
    update: () => {},
    remove: () => {},
  }
  const context = host({
    tool: {
      transform: (apply: (draft: ToolDraft) => void) =>
        Effect.sync(() => {
          apply(draft)
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
      hook: () => Effect.die("unused tool.hook"),
    } as unknown as PluginContext["tool"],
  })
  yield* AgentTool.Plugin.effect(context).pipe(Effect.provide(stubs))
  if (added.length === 0) throw new Error("AgentTool registered nothing: the capture draft is wired wrong")
  return added.map(effectiveName)
})

const event = (tool: string, input: unknown) => ({
  tool,
  sessionID: SessionID.make("ses_spawn_contract"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_spawn_contract"),
  id: Tool.CallID.make("call_spawn_contract"),
  input,
})

/** The real gate on a stub host, capturing what it asks for. */
const gate = Effect.gen(function* () {
  const asserted: Array<Permission.AssertInput> = []
  let before: ((event: unknown) => Effect.Effect<void, unknown>) | undefined

  const permission = Layer.succeed(Permission.Service, {
    assert: (input: Permission.AssertInput) =>
      Effect.sync(() => {
        asserted.push(input)
      }),
  } as unknown as Permission.Interface)
  const bus = Layer.succeed(Bus.Service, { publish: () => Effect.void } as unknown as Bus.Interface)

  const stub = {
    tool: {
      hook: (name: string, hooked: (event: unknown) => Effect.Effect<void, unknown>) =>
        Effect.sync(() => {
          if (name === "execute.before") before = hooked
          return { dispose: Effect.void }
        }),
    },
  } as unknown as PluginContext

  yield* WorkflowGatePlugin.Plugin.effect(stub).pipe(Effect.provide(Layer.mergeAll(permission, bus)))
  if (before === undefined) throw new Error("the gate never registered execute.before")
  return { asserted, run: before }
})

describe("workflow gate spawn key", () => {
  test("SPAWN_TOOL is the key the real agent spawn registration produces", async () => {
    const keys = await Effect.runPromise(Effect.scoped(registrationKeys))
    expect(keys).toContain(WorkflowGatePlugin.SPAWN_TOOL)
  })

  test("the gate counts spawns arriving under that derived key", async () => {
    const keys = await Effect.runPromise(Effect.scoped(registrationKeys))
    const spawnKey = keys.find((key) => key === WorkflowGatePlugin.SPAWN_TOOL) ?? "the-gate-sees-no-spawn-registration"
    const { asserted, run } = await Effect.runPromise(Effect.scoped(gate))

    // A script the static read cannot count, so only the observed spawns can raise the question.
    await Effect.runPromise(run(event("execute", { code: `await run(tasks)` })))
    expect(asserted).toHaveLength(0)

    for (let i = 0; i < WorkflowPlan.MULTI_AGENT_MINIMUM; i++)
      await Effect.runPromise(run(event(spawnKey, { task: `t${i}` })))

    expect(asserted).toHaveLength(1)
    expect(asserted[0]?.action).toBe(WorkflowPlan.ACTION)
  })
})
