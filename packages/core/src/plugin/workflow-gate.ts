export * as WorkflowGatePlugin from "./workflow-gate.js"

import { ToolFailure } from "@opencode-ai/ai"
import { define } from "@opencode-ai/plugin/effect/plugin"
import type { ToolHooks } from "@opencode-ai/plugin/effect/tool"
import { TuiEvent } from "@opencode-ai/schema/tui-event"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import { Permission } from "../permission.js"
import { WorkflowPlan } from "../workflow/plan.js"

/**
 * force-agent overlay: one approval for a whole multi-agent run.
 *
 * `agent.spawn` asserts the `subagent` action per child, which is the right grain for a single
 * delegation and the wrong one for a Code Mode program that fans out: the user answers the same
 * question thirty times, each time seeing one task instead of the shape of the run.
 *
 * This gate asks once per Code Mode execution, under a dedicated `workflow.run` action, carrying
 * the phases, the agent count, the projected tokens and the script itself.
 *
 * WHERE THE ASSERTION FIRES. Two paths, and the second is the one that makes the gate sound:
 *
 *  1. Pre-flight, when the static read in `workflow/plan.ts` already shows a fan-out. This only
 *     moves the question EARLIER — before any child exists — for the ordinary case.
 *  2. At the run's own spawns, counted as `tool.execute.before` sees them. Every child session a
 *     Code Mode program starts goes through the one `agent_spawn` registration, whatever the
 *     program calls it, so this path does not care how the source text spells the call. An alias
 *     (`const s = tools.agent.spawn`), a computed member name, or a helper function called from
 *     `.map()` all reach it.
 *
 * Static analysis of JavaScript by regex cannot be made sound, so it is not what decides whether
 * to ask: it decides how much detail the prompt can show and how early it can appear. Path 2 is
 * mandatory and runs off real calls. The threshold is the same on both paths — a run that spawns
 * exactly one child is a plain delegation the `subagent` action already gates.
 *
 * ONE PROMPT PER EXECUTION. The assertion is memoized per Code Mode tool call (`Effect.cached`),
 * so thirty concurrent children raise one request and share its answer, including a denial.
 *
 * "Don't ask again" is scoped to the script's digest, never to `*`: `save` carries the same
 * `sha256:` resource that `resources` does, so a remembered approval covers a re-run of exactly
 * this script and a single edited character asks again. The digest is taken over the script text,
 * not over the estimated agent count, so it stays stable when the estimate and the real fan-out
 * disagree.
 */

/** The Code Mode tool's name, from `codemode/tool.ts`. */
const CODEMODE_TOOL = "execute"

/**
 * Registry key of the spawn tool: `effectiveName` of the registration in `tool/plugin/agent.ts`
 * (namespace `agent`, tool `spawn`). Inner Code Mode calls reach `tool.execute.before` under this
 * key, carrying the enclosing Code Mode call's context.
 *
 * Exported for the contract test in `test/workflow-gate-spawn-contract.test.ts`, which derives the
 * key from the real registration instead of restating it: a rename on either side must break a
 * test rather than silently blind the gate.
 */
export const SPAWN_TOOL = "agent_spawn"

const ADVISORY_DURATION = 15_000

type Event = ToolHooks["execute.before"]

const script = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const code = (input as { readonly code?: unknown }).code
  return typeof code === "string" && code !== "" ? code : undefined
}

/** Child sessions this execution has actually asked for, counted as the hook sees them. */
interface Observed {
  spawns: number
}

interface Run {
  readonly plan: WorkflowPlan.Plan
  readonly observed: Observed
  /** The single assertion for this execution, memoized so every child shares one answer. */
  readonly gate: Effect.Effect<void, ToolFailure>
}

export const Plugin = define({
  id: "force.workflow.gate",
  effect: Effect.fn("WorkflowGatePlugin")(function* (ctx) {
    const permission = yield* Permission.Service
    const bus = yield* Bus.Service

    /**
     * Live Code Mode executions, keyed by the tool call that owns them. Inner tool calls reuse the
     * enclosing Code Mode call's context, so a spawn with no entry here came from a direct tool
     * call rather than from a program, and belongs to `subagent` alone.
     */
    const runs = new Map<string, Run>()
    const key = (event: Pick<Event, "sessionID" | "id">) => `${event.sessionID}:${event.id}`

    const assertion = (plan: WorkflowPlan.Plan, observed: Observed, event: Event) =>
      Effect.gen(function* () {
        // Advisory only: published before the ask so the ceiling is visible while deciding, and
        // never able to fail the run.
        yield* Effect.forEach(
          plan.advisories,
          (message) =>
            bus.publish(TuiEvent.ToastShow, {
              title: "Workflow advisory",
              message,
              variant: "warning",
              duration: ADVISORY_DURATION,
            }),
          { discard: true },
        )

        const projected = `${plan.phases.length} phase${plan.phases.length === 1 ? "" : "s"}, ${plan.agents} agents, ~${plan.tokens.toLocaleString("en-US")} projected tokens`
        yield* permission
          .assert({
            action: WorkflowPlan.ACTION,
            resources: [plan.digest],
            save: [plan.digest],
            sessionID: event.sessionID,
            agent: event.agent,
            metadata: {
              summary:
                observed.spawns > 0
                  ? `${projected} (${observed.spawns} already requested by the running program)`
                  : projected,
              phases: plan.phases,
              agents: plan.agents,
              tokens: plan.tokens,
              // What the program has actually asked for by the time the question is raised. Zero
              // on the pre-flight path; non-zero when the static read under-counted the run.
              observed: observed.spawns,
              advisories: plan.advisories,
              script: plan.script,
            },
            source: { type: "tool", messageID: event.messageID, id: event.id },
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ToolFailure({
                  message: `Multi-agent run denied (${plan.agents} agents across ${plan.phases.length} phases).`,
                  error,
                }),
            ),
          )
      })

    const started = (event: Event) =>
      Effect.gen(function* () {
        const code = script(event.input)
        if (code === undefined) return
        const plan = WorkflowPlan.analyze(code)
        const observed: Observed = { spawns: 0 }
        const gate = yield* Effect.cached(assertion(plan, observed, event))
        const id = key(event)
        runs.set(id, { plan, observed, gate })
        // A static read that already shows a fan-out lets the question land before the first
        // child. It never suppresses the question: an under-count only defers it to `spawned`.
        if (plan.agents < WorkflowPlan.MULTI_AGENT_MINIMUM) return
        yield* gate.pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              // The Code Mode tool never runs, so `execute.after` never arrives to clean up.
              runs.delete(id)
            }),
          ),
        )
      })

    const spawned = (event: Event) =>
      Effect.gen(function* () {
        const run = runs.get(key(event))
        if (run === undefined) return
        // Synchronous read-and-increment: no fiber can interleave between these two lines, so a
        // `Promise.all` over thirty children lets exactly one through before the gate.
        run.observed.spawns += 1
        if (run.observed.spawns < WorkflowPlan.MULTI_AGENT_MINIMUM) return
        yield* run.gate
      })

    yield* ctx.tool.hook("execute.before", (event) => {
      if (event.tool === CODEMODE_TOOL) return started(event)
      if (event.tool === SPAWN_TOOL) return spawned(event)
      return Effect.void
    })

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.sync(() => {
        if (event.tool !== CODEMODE_TOOL) return
        runs.delete(key(event))
      }),
    )
  }),
})
