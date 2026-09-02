import { Bus } from "@opencode-ai/core/bus"
import { CodeModeTool } from "@opencode-ai/core/codemode/tool"
import { Permission } from "@opencode-ai/core/permission"
import { WorkflowGatePlugin } from "@opencode-ai/core/plugin/workflow-gate"
import { WorkflowPlan } from "@opencode-ai/core/workflow/plan"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Agent } from "@opencode-ai/schema/agent"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Tool } from "@opencode-ai/schema/tool"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"

const SpawnInput = Schema.Struct({ task: Schema.String })
const SpawnOutput = Schema.Struct({ ok: Schema.Boolean })

const context = (): Tool.Context => ({
  sessionID: SessionID.make("ses_order"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_order"),
  id: Tool.CallID.make("call_order"),
  progress: () => Effect.void,
})

// DENY EVERYTHING. Any spawn that happens is a spawn the user never approved.
const harness = () =>
  Effect.gen(function* () {
    const spawns: string[] = []
    const asserted: string[] = []
    let hook: ((event: any) => Effect.Effect<void, any>) | undefined

    const permission = Layer.succeed(Permission.Service, {
      assert: (input: Permission.AssertInput) =>
        Effect.suspend(() => {
          asserted.push(input.action)
          return Effect.fail(
            new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
          )
        }),
    } as unknown as Permission.Interface)

    const bus = Layer.succeed(Bus.Service, { publish: () => Effect.void } as unknown as Bus.Interface)
    const host = {
      tool: {
        hook: (name: string, hooked: any) =>
          Effect.sync(() => {
            if (name === "execute.before") hook = hooked
            return { dispose: Effect.void }
          }),
      },
    } as unknown as PluginContext

    yield* WorkflowGatePlugin.Plugin.effect(host).pipe(Effect.provide(Layer.mergeAll(permission, bus)))

    const spawnTool = {
      name: "spawn",
      options: { namespace: "agent", pinned: true },
      description: "test spawn",
      input: SpawnInput,
      output: SpawnOutput,
      execute: (input: { task: string }) =>
        Effect.sync(() => {
          spawns.push(input.task)
          return { output: { ok: true }, content: "done " + input.task }
        }),
    } as unknown as Tool.Info

    const registrations = new Map<string, Tool.Info>([["agent_spawn", spawnTool]])
    // tool.ts:216-218 routes inner Code Mode tool calls through execute.before as well; the
    // original probe called the tool directly, which is why every bypass below reported
    // `asserted=[]` regardless of what the gate did.
    const codemodeTool = CodeModeTool.create(registrations, (name, tool, input, ctx) =>
      hook!({ tool: name, ...context(), input }).pipe(Effect.flatMap(() => (tool.execute as any)(input, ctx))) as any,
    )

    const pipeline = (code: string) =>
      Effect.gen(function* () {
        yield* hook!({ tool: "execute", ...context(), input: { code } })
        return yield* (codemodeTool.execute as any)({ code }, context())
      }) as Effect.Effect<any, unknown, never>

    return { spawns, asserted, pipeline }
  })

const BYPASSES: Array<{ readonly label: string; readonly code: string }> = [
  {
    label: "alias the spawn function once",
    code: `const s = tools.agent.spawn
const out = await Promise.all([s({task:"a"}),s({task:"b"}),s({task:"c"}),s({task:"d"}),s({task:"e"})])
return out.length`,
  },
  {
    label: "alias the namespace (zero literal spawn sites)",
    code: `const ns = tools.agent
const out = await Promise.all([ns.spawn({task:"a"}),ns.spawn({task:"b"}),ns.spawn({task:"c"}),ns.spawn({task:"d"})])
return out.length`,
  },
  {
    label: "computed member name",
    code: `const k = "sp" + "awn"
const out = await Promise.all([tools.agent[k]({task:"a"}),tools.agent[k]({task:"b"}),tools.agent[k]({task:"c"})])
return out.length`,
  },
  {
    label: "idiomatic helper function (one literal spawn site, 30 children)",
    code: `async function ask(t) { return await tools.agent.spawn({ task: t }) }
const topics = ["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z","0","1","2","3"]
const out = await Promise.all(topics.map((t) => ask(t)))
return out.length`,
  },
]

describe("BATTLE: workflow gate static-analysis bypass", () => {
  for (const item of BYPASSES) {
    test(item.label, async () => {
      const plan = WorkflowPlan.analyze(item.code)
      const h = await Effect.runPromise(Effect.scoped(harness()))
      const exit = await Effect.runPromiseExit(h.pipeline(item.code))
      console.log(
        `[${item.label}] plan.agents=${plan.agents} asserted=${JSON.stringify(h.asserted)} spawns=${JSON.stringify(h.spawns)} exit=${exit._tag}`,
      )
      // The static read still under-counts every one of these -- that is not fixable by regex.
      expect(plan.agents).toBeLessThan(WorkflowPlan.MULTI_AGENT_MINIMUM)
      // The gate no longer depends on it: the run's own spawns raise the question.
      expect(h.asserted).toEqual([WorkflowPlan.ACTION])
      // With every permission denied, only the single child that `subagent` gates on its own runs.
      expect(h.spawns).toHaveLength(1)
    })
  }
})
