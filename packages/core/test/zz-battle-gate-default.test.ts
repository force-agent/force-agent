import { Permission } from "@opencode-ai/core/permission"
import { WorkflowPlan } from "@opencode-ai/core/workflow/plan"
import { Agent } from "@opencode-ai/schema/agent"
import { describe, expect, test } from "bun:test"

/**
 * BATTLE probe: what the workflow gate's assertion actually evaluates to under the
 * out-of-the-box agent ruleset (packages/schema/src/agent.ts, `Agent.Info.default`).
 *
 * It used to evaluate to `allow`: the ruleset opens with a blanket `{ "*": "*" -> allow }` and
 * `Permission.evaluate` only falls back to `ask` when NOTHING matches, so the gate could not ask on
 * a default install. The default now carves `workflow.run` back out. `subagent`, the per-child
 * action, is deliberately left allowed -- one delegation is not what this gate is for.
 */
describe("BATTLE: workflow.run under the default agent ruleset", () => {
  const rules = Agent.Info.default(Agent.ID.make("build")).permissions
  const digest = WorkflowPlan.digest("await Promise.all([tools.agent.spawn({task:'a'}),tools.agent.spawn({task:'b'})])")

  test("the blanket allow is still there, and is still first", () => {
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" })
  })

  test("workflow.run on a fresh digest asks", () => {
    expect(Permission.evaluate(WorkflowPlan.ACTION, digest, rules).effect).toBe("ask")
  })

  test("a remembered approval for that digest still allows it", () => {
    const saved: Permission.Ruleset = [{ action: WorkflowPlan.ACTION, resource: digest, effect: "allow" }]
    expect(Permission.evaluate(WorkflowPlan.ACTION, digest, rules, saved).effect).toBe("allow")
    // Scoped to the script: a different one asks again.
    expect(Permission.evaluate(WorkflowPlan.ACTION, WorkflowPlan.digest("other"), rules, saved).effect).toBe("ask")
  })

  test("subagent, the per-child fallback, is untouched", () => {
    expect(Permission.evaluate("subagent", "*", rules).effect).toBe("allow")
  })
})
