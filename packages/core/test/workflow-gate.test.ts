import { Bus } from "@opencode-ai/core/bus"
import { Permission } from "@opencode-ai/core/permission"
import { WorkflowGatePlugin } from "@opencode-ai/core/plugin/workflow-gate"
import { WorkflowPlan } from "@opencode-ai/core/workflow/plan"
import type { Context } from "@opencode-ai/plugin/effect/plugin"
import { Agent } from "@opencode-ai/schema/agent"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Tool } from "@opencode-ai/schema/tool"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"

type Before = Context["tool"]["hook"] extends (name: infer _N, callback: (event: infer E) => infer R) => unknown
  ? { readonly event: E; readonly result: R }
  : never

const event = (code: string) => ({
  tool: "execute",
  sessionID: SessionID.make("ses_workflow_gate"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_workflow_gate"),
  id: Tool.CallID.make("call_workflow_gate"),
  input: { code },
})

/**
 * One child session starting inside that Code Mode call. Inner Code Mode tool calls reach
 * `execute.before` under the spawn registration's name and the enclosing call's context, which is
 * what ties a spawn to its run.
 */
const spawn = () => ({ ...event(""), tool: "agent_spawn", input: { task: "t" } })

/**
 * Drives the real plugin with a stub host: the captured `execute.before` callback is the exact
 * function the tool pipeline calls, so the hook name, the tool filter, the resources and the
 * advisory publishing are all exercised rather than restated.
 */
const gate = (options?: { readonly deny?: boolean }) =>
  Effect.gen(function* () {
    const asserted: Array<Permission.AssertInput> = []
    const published: Array<{ readonly type: string; readonly data: unknown }> = []
    let callback: ((event: Before["event"]) => Effect.Effect<void, Tool.Error>) | undefined
    let finished: ((event: unknown) => Effect.Effect<void, never>) | undefined

    const permission = Layer.succeed(Permission.Service, {
      assert: (input: Permission.AssertInput) =>
        Effect.suspend(() => {
          asserted.push(input)
          return options?.deny === true
            ? Effect.fail(
                new Permission.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                }),
              )
            : Effect.void
        }),
    } as unknown as Permission.Interface)

    const bus = Layer.succeed(Bus.Service, {
      publish: (definition: { readonly type: string }, data: unknown) =>
        Effect.sync(() => {
          published.push({ type: definition.type, data })
          return undefined
        }),
    } as unknown as Bus.Interface)

    const host = {
      tool: {
        hook: (name: string, hooked: (event: Before["event"]) => Effect.Effect<void, Tool.Error>) =>
          Effect.sync(() => {
            if (name === "execute.before") callback = hooked
            if (name === "execute.after") finished = hooked as unknown as typeof finished
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Context

    yield* WorkflowGatePlugin.Plugin.effect(host).pipe(Effect.provide(Layer.mergeAll(permission, bus)))
    if (callback === undefined || finished === undefined)
      throw new Error("the plugin never registered its execute.before and execute.after hooks")
    return { asserted, published, run: callback, done: finished }
  })

describe("WorkflowGatePlugin", () => {
  test("asks once for a fan-out, scoped to the script digest", async () => {
    const code = `await Promise.all([tools.agent.spawn({ task: "a" }), tools.agent.spawn({ task: "b" })])`
    const { asserted, run } = await Effect.runPromise(Effect.scoped(gate()))
    await Effect.runPromise(run(event(code)))

    expect(asserted).toHaveLength(1)
    const request = asserted[0]!
    expect(request.action).toBe(WorkflowPlan.ACTION)
    expect(request.resources).toEqual([WorkflowPlan.digest(code)])
    // Never `*`: an edited script produces a different digest and asks again.
    expect(request.save).toEqual([WorkflowPlan.digest(code)])
    expect(request.metadata).toMatchObject({
      agents: 2,
      tokens: 120_000,
      phases: [{ index: 1, kind: "parallel", agents: 2 }],
      script: code,
    })
  })

  test("stays out of the way of a single delegation and of non-Code-Mode tools", async () => {
    const { asserted, run } = await Effect.runPromise(Effect.scoped(gate()))
    await Effect.runPromise(run(event(`return tools.agent.spawn({ task: "only one" })`)))
    await Effect.runPromise(run({ ...event("irrelevant"), tool: "shell" }))
    expect(asserted).toEqual([])
  })

  test("publishes the advisory past the ceilings without blocking", async () => {
    const many = Array.from({ length: 30 }, (_, index) => index).join(",")
    const { asserted, published, run } = await Effect.runPromise(Effect.scoped(gate()))
    await Effect.runPromise(run(event(`await Promise.all([${many}].map((i) => tools.agent.spawn({ task: i })))`)))

    expect(asserted).toHaveLength(1)
    expect(published.map((item) => item.type)).toEqual(["tui.toast.show", "tui.toast.show"])
    expect(published[0]!.data).toMatchObject({ variant: "warning" })
    expect(asserted[0]!.metadata?.["advisories"]).toHaveLength(2)
  })

  test("turns a denied run into a tool failure the model can read", async () => {
    const { run } = await Effect.runPromise(Effect.scoped(gate({ deny: true })))
    const exit = await Effect.runPromiseExit(
      run(event(`await Promise.all([tools.agent.spawn({ task: "a" }), tools.agent.spawn({ task: "b" })])`)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    expect(JSON.stringify(exit.cause)).toContain("Multi-agent run denied")
  })

  test("leaves a spawn that belongs to no Code Mode run to the `subagent` action", async () => {
    const { asserted, run } = await Effect.runPromise(Effect.scoped(gate()))
    await Effect.runPromise(run(spawn()))
    await Effect.runPromise(run(spawn()))
    expect(asserted).toEqual([])
  })

  test("asks at the second real spawn of a run the static read could not see", async () => {
    // One literal call site, thirty children: the shape the regex cannot count.
    const code = `async function ask(t){ return await tools.agent.spawn({ task: t }) }\nawait Promise.all(topics.map(ask))`
    expect(WorkflowPlan.analyze(code).agents).toBeLessThan(WorkflowPlan.MULTI_AGENT_MINIMUM)

    const { asserted, run } = await Effect.runPromise(Effect.scoped(gate()))
    await Effect.runPromise(run(event(code)))
    expect(asserted).toEqual([])

    await Effect.runPromise(run(spawn()))
    expect(asserted).toEqual([])

    await Effect.runPromise(run(spawn()))
    expect(asserted).toHaveLength(1)
    expect(asserted[0]!.action).toBe(WorkflowPlan.ACTION)
    // The digest is over the script, so a remembered approval is unaffected by the bad estimate.
    expect(asserted[0]!.resources).toEqual([WorkflowPlan.digest(code)])
    expect(asserted[0]!.metadata).toMatchObject({ agents: 1, observed: 2 })
  })

  test("raises one request for thirty concurrent children", async () => {
    const code = `const s = tools.agent.spawn\nawait Promise.all(topics.map(s))`
    const { asserted, run } = await Effect.runPromise(Effect.scoped(gate()))
    await Effect.runPromise(run(event(code)))
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 30 }, () => run(spawn())),
        { concurrency: "unbounded" },
      ),
    )
    expect(asserted).toHaveLength(1)
  })

  test("retires the run when the Code Mode call ends", async () => {
    const code = `const s = tools.agent.spawn\nawait Promise.all(topics.map(s))`
    const { asserted, run, done } = await Effect.runPromise(Effect.scoped(gate()))
    await Effect.runPromise(run(event(code)))
    await Effect.runPromise(run(spawn()))
    await Effect.runPromise(run(spawn()))
    expect(asserted).toHaveLength(1)

    await Effect.runPromise(done({ ...event(code), status: "completed", result: { content: [] } }))
    // The next execution of the same script under a new call id asks on its own account.
    await Effect.runPromise(run(spawn()))
    await Effect.runPromise(run(spawn()))
    expect(asserted).toHaveLength(1)
  })
})
