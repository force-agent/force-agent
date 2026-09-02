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

/**
 * The gate asserted off a regex count of `tools.agent.spawn(` call sites, so any program that did
 * not spell the call literally — an alias, a computed member name, or the idiomatic
 * `topics.map(helper)` — counted as zero or one and slipped past `MULTI_AGENT_MINIMUM` before the
 * assertion was ever reached.
 *
 * These cases run the REAL Code Mode interpreter with the inner tool calls routed through
 * `tool.execute.before`, exactly as `packages/core/src/tool.ts` (lines 216-218) wires them, and
 * count the child sessions that actually started.
 */

const SpawnInput = Schema.Struct({ task: Schema.String })
const SpawnOutput = Schema.Struct({ ok: Schema.Boolean })

const context = (call: string): Tool.Context => ({
  sessionID: SessionID.make("ses_runtime"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_runtime"),
  id: Tool.CallID.make(call),
  progress: () => Effect.void,
})

const harness = (options: { readonly deny: boolean }) =>
  Effect.gen(function* () {
    const spawns: string[] = []
    const asserted: Array<Permission.AssertInput> = []
    let before: ((event: any) => Effect.Effect<void, any>) | undefined
    let after: ((event: any) => Effect.Effect<void, never>) | undefined

    const permission = Layer.succeed(Permission.Service, {
      assert: (input: Permission.AssertInput) =>
        Effect.suspend(() => {
          asserted.push(input)
          return options.deny
            ? Effect.fail(
                new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
              )
            : Effect.void
        }),
    } as unknown as Permission.Interface)

    const bus = Layer.succeed(Bus.Service, { publish: () => Effect.void } as unknown as Bus.Interface)

    const host = {
      tool: {
        hook: (name: string, hooked: any) =>
          Effect.sync(() => {
            if (name === "execute.before") before = hooked
            if (name === "execute.after") after = hooked
            return { dispose: Effect.void }
          }),
      },
    } as unknown as PluginContext

    yield* WorkflowGatePlugin.Plugin.effect(host).pipe(Effect.provide(Layer.mergeAll(permission, bus)))
    if (before === undefined || after === undefined) throw new Error("gate did not register its tool hooks")

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

    // Registry key is `effectiveName`: namespace + normalized name, the same string the real
    // AgentTool registration produces and the gate matches on.
    const registrations = new Map<string, Tool.Info>([["agent_spawn", spawnTool]])
    const hook = (name: string, input: unknown, ctx: Tool.Context) =>
      before!({
        tool: name,
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        messageID: ctx.messageID,
        id: ctx.id,
        input,
      })

    // Mirror of tool.ts:216-218: every inner Code Mode tool call goes through execute.before.
    const codemodeTool = CodeModeTool.create(registrations, (name, tool, input, ctx) =>
      hook(name, input, ctx).pipe(Effect.flatMap(() => (tool.execute as any)(input, ctx))) as any,
    ) as any

    // Mirror of tool.ts:239-247 for the Code Mode call itself, plus the after hook that retires it.
    const run = (code: string, call = "call_runtime") =>
      Effect.gen(function* () {
        const ctx = context(call)
        yield* hook("execute", { code }, ctx)
        return yield* codemodeTool.execute({ code }, ctx)
      }).pipe(
        Effect.ensuring(
          after!({ tool: "execute", ...context(call), input: {}, status: "completed", result: { content: [] } }),
        ),
      ) as Effect.Effect<any, unknown, never>

    return { spawns, asserted, run }
  })

const FANOUT: Array<{ readonly label: string; readonly code: string; readonly children: number }> = [
  {
    label: "alias the spawn function",
    children: 5,
    code: `const s = tools.agent.spawn
const out = await Promise.all([s({task:"a"}),s({task:"b"}),s({task:"c"}),s({task:"d"}),s({task:"e"})])
return out.length`,
  },
  {
    label: "alias the namespace",
    children: 4,
    code: `const ns = tools.agent
const out = await Promise.all([ns.spawn({task:"a"}),ns.spawn({task:"b"}),ns.spawn({task:"c"}),ns.spawn({task:"d"})])
return out.length`,
  },
  {
    label: "computed member name",
    children: 3,
    code: `const k = "sp" + "awn"
const out = await Promise.all([tools.agent[k]({task:"a"}),tools.agent[k]({task:"b"}),tools.agent[k]({task:"c"})])
return out.length`,
  },
  {
    label: "helper function over 30 topics",
    children: 30,
    code: `async function ask(t) { return await tools.agent.spawn({ task: t }) }
const topics = ["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z","0","1","2","3"]
const out = await Promise.all(topics.map((t) => ask(t)))
return out.length`,
  },
]

describe("workflow gate, asserted off real spawns", () => {
  for (const item of FANOUT) {
    test(`${item.label}: denied, so at most the one child \`subagent\` already gates`, async () => {
      const plan = WorkflowPlan.analyze(item.code)
      const h = await Effect.runPromise(Effect.scoped(harness({ deny: true })))
      await Effect.runPromiseExit(h.run(item.code))

      // The static read is exactly the thing that cannot be trusted here.
      expect(plan.agents).toBeLessThan(WorkflowPlan.MULTI_AGENT_MINIMUM)
      // ... and the gate still fires, once, with the script's digest.
      expect(h.asserted.map((request) => request.action)).toEqual([WorkflowPlan.ACTION])
      expect(h.asserted[0]!.resources).toEqual([WorkflowPlan.digest(item.code)])
      expect(h.spawns).toHaveLength(1)
    })

    test(`${item.label}: approved once, then every child runs`, async () => {
      const h = await Effect.runPromise(Effect.scoped(harness({ deny: false })))
      await Effect.runPromise(h.run(item.code))
      expect(h.asserted).toHaveLength(1)
      expect(h.spawns).toHaveLength(item.children)
    })
  }

  test("a program that spawns one child never raises the workflow prompt", async () => {
    const h = await Effect.runPromise(Effect.scoped(harness({ deny: true })))
    await Effect.runPromise(h.run(`return await tools.agent.spawn({ task: "only one" })`))
    expect(h.asserted).toEqual([])
    expect(h.spawns).toEqual(["only one"])
  })

  test("a literal fan-out is asked for before any child starts", async () => {
    const code = `await Promise.all([tools.agent.spawn({task:"a"}),tools.agent.spawn({task:"b"})])`
    expect(WorkflowPlan.analyze(code).agents).toBe(2)
    const h = await Effect.runPromise(Effect.scoped(harness({ deny: true })))
    await Effect.runPromiseExit(h.run(code))
    expect(h.asserted).toHaveLength(1)
    expect(h.spawns).toEqual([])
  })

  test("the approval is memoized per execution, not per process", async () => {
    const code = FANOUT[3]!.code
    const h = await Effect.runPromise(Effect.scoped(harness({ deny: false })))
    await Effect.runPromise(h.run(code, "call_one"))
    await Effect.runPromise(h.run(code, "call_two"))
    expect(h.asserted).toHaveLength(2)
    expect(h.spawns).toHaveLength(60)
  })
})
