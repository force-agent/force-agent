import { Bus } from "@opencode-ai/core/bus"
import { CodeModeTool } from "@opencode-ai/core/codemode/tool"
import { Permission } from "@opencode-ai/core/permission"
import { WorkflowGatePlugin } from "@opencode-ai/core/plugin/workflow-gate"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Agent } from "@opencode-ai/schema/agent"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Tool } from "@opencode-ai/schema/tool"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"

/**
 * Verification harness for TESTE 5, check 4: the `workflow.run` assertion must land BEFORE the
 * first `tools.agent.spawn` runs. This replays the exact sequence of packages/core/src/tool.ts
 * lines 239-247 -- `beforeExecute(...)` then `codemodeTool.execute(...)` -- with the real gate
 * plugin on one side and the real CodeModeTool runtime on the other, and counts spawns.
 */

const SpawnInput = Schema.Struct({ task: Schema.String })
const SpawnOutput = Schema.Struct({ ok: Schema.Boolean })

const context = (): Tool.Context => ({
  sessionID: SessionID.make("ses_order"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_order"),
  id: Tool.CallID.make("call_order"),
  progress: () => Effect.void,
})

const harness = (options: { readonly deny: boolean }) =>
  Effect.gen(function* () {
    const spawns: string[] = []
    const asserted: string[] = []
    const trace: string[] = []
    let hook: ((event: any) => Effect.Effect<void, any>) | undefined

    const permission = Layer.succeed(Permission.Service, {
      assert: (input: Permission.AssertInput) =>
        Effect.suspend(() => {
          trace.push("assert:" + input.action)
          asserted.push(input.action)
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
            if (name === "execute.before") hook = hooked
            return { dispose: Effect.void }
          }),
      },
    } as unknown as PluginContext

    yield* WorkflowGatePlugin.Plugin.effect(host).pipe(Effect.provide(Layer.mergeAll(permission, bus)))
    if (hook === undefined) throw new Error("gate did not register execute.before")

    const spawnTool = {
      name: "spawn",
      options: { namespace: "agent", pinned: true },
      description: "test spawn",
      input: SpawnInput,
      output: SpawnOutput,
      execute: (input: { task: string }) =>
        Effect.sync(() => {
          trace.push("spawn:" + input.task)
          spawns.push(input.task)
          return { output: { ok: true }, content: "done " + input.task }
        }),
    } as unknown as Tool.Info

    const registrations = new Map<string, Tool.Info>([["agent_spawn", spawnTool]])
    // Mirror of tool.ts:216-218: inner Code Mode tool calls go through execute.before too, which
    // is the path the gate asserts on for a program whose spawns the static read cannot see.
    const codemodeTool = CodeModeTool.create(registrations, (name, tool, input, ctx) =>
      hook!({ tool: name, ...context(), input }).pipe(Effect.flatMap(() => (tool.execute as any)(input, ctx))) as any,
    )

    // Mirror of tool.ts:239-247.
    const pipeline = (code: string) =>
      Effect.gen(function* () {
        const event = { tool: "execute", ...context(), input: { code } }
        yield* hook!(event)
        return yield* (codemodeTool.execute as any)({ code }, context())
      }) as Effect.Effect<unknown, unknown, never>

    return { spawns, asserted, trace, pipeline }
  })

describe("gate ordering in the real pipeline", () => {
  test("a denied fan-out never reaches the first spawn", async () => {
    const h = await Effect.runPromise(Effect.scoped(harness({ deny: true })))
    const code = `await Promise.all([tools.agent.spawn({ task: "a" }), tools.agent.spawn({ task: "b" })])`
    const exit = await Effect.runPromiseExit(h.pipeline(code))
    console.log("DENY trace =", JSON.stringify(h.trace))
    console.log("DENY spawns =", JSON.stringify(h.spawns))
    expect(h.asserted).toEqual(["workflow.run"])
    expect(h.spawns).toEqual([])
    expect(exit._tag).toBe("Failure")
  })

  test("an approved fan-out asserts first, then spawns", async () => {
    const h = await Effect.runPromise(Effect.scoped(harness({ deny: false })))
    const code = `await Promise.all([tools.agent.spawn({ task: "a" }), tools.agent.spawn({ task: "b" })])`
    await Effect.runPromise(h.pipeline(code))
    console.log("ALLOW trace =", JSON.stringify(h.trace))
    expect(h.trace[0]).toBe("assert:workflow.run")
    expect(h.spawns.toSorted()).toEqual(["a", "b"])
  })
})
