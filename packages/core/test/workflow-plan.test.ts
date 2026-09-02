import { WorkflowPlan } from "@opencode-ai/core/workflow/plan"
import { describe, expect, test } from "bun:test"

describe("WorkflowPlan.analyze", () => {
  test("sees no run in a script that never spawns", () => {
    const plan = WorkflowPlan.analyze(`const files = await tools.glob({ pattern: "**/*.ts" })\nreturn files.length`)
    expect(plan.agents).toBe(0)
    expect(plan.phases).toEqual([])
  })

  test("groups spawns under one combinator into a single parallel phase", () => {
    const plan = WorkflowPlan.analyze(`
      const [a, b, c] = await Promise.all([
        tools.agent.spawn({ task: "one" }),
        tools.agent.spawn({ task: "two" }),
        tools.agent.spawn({ task: "three" }),
      ])
      return [a, b, c]
    `)
    expect(plan.phases).toEqual([{ index: 1, kind: "parallel", agents: 3 }])
    expect(plan.agents).toBe(3)
    expect(plan.tokens).toBe(3 * 60_000)
  })

  test("counts unbatched spawns as separate sequential phases", () => {
    const plan = WorkflowPlan.analyze(`
      const first = await tools.agent.spawn({ task: "survey" })
      const second = await tools.agent.spawn({ task: "implement: " + first.output })
      return second
    `)
    expect(plan.phases).toEqual([
      { index: 1, kind: "sequential", agents: 1 },
      { index: 2, kind: "sequential", agents: 1 },
    ])
  })

  test("takes the fan-out of a literal array receiver exactly", () => {
    const plan = WorkflowPlan.analyze(`
      return Promise.all(["api", "web", "cli", "docs"].map((area) => tools.agent.spawn({ task: area })))
    `)
    expect(plan.phases).toEqual([{ index: 1, kind: "parallel", agents: 4 }])
  })

  test("falls back to the configured fan-out when the iterable is only known at runtime", () => {
    const plan = WorkflowPlan.analyze(`
      const areas = await tools.glob({ pattern: "packages/*" })
      return Promise.all(areas.map((area) => tools.agent.spawn({ task: area })))
    `)
    expect(plan.phases).toEqual([{ index: 1, kind: "parallel", agents: 4 }])
  })

  test("treats a spawn inside a loop body as repeated rather than single", () => {
    const plan = WorkflowPlan.analyze(`
      for (const area of areas) {
        await tools.agent.spawn({ task: area })
      }
    `)
    expect(plan.agents).toBe(4)
  })

  test("does not read a loop's fan-out off an unrelated earlier expression", () => {
    const plan = WorkflowPlan.analyze(`
      const names = ["one"].map((item) => item)
      for (const name of names) {
        await tools.agent.spawn({ task: name })
      }
    `)
    expect(plan.agents).toBe(4)
  })

  test("reads bracket-notation calls the catalog also advertises", () => {
    const plan = WorkflowPlan.analyze(`
      await Promise.all([tools.agent["spawn"]({ task: "one" }), tools["agent"].spawn({ task: "two" })])
    `)
    expect(plan.agents).toBe(2)
  })

  test("ignores a spawn that only appears in a comment", () => {
    const plan = WorkflowPlan.analyze(`
      // tools.agent.spawn({ task: "not real" })
      /* tools.agent.spawn({ task: "also not real" }) */
      return tools.agent.spawn({ task: "real" })
    `)
    expect(plan.agents).toBe(1)
  })

  test("warns past the advisory ceilings without changing the plan", () => {
    const plan = WorkflowPlan.analyze(
      `
      return Promise.all(items.map((item) => tools.agent.spawn({ task: item })))
    `.replace("items", `[${Array.from({ length: 30 }, (_, index) => index).join(",")}]`),
    )
    expect(plan.agents).toBe(30)
    expect(plan.advisories).toHaveLength(2)
    expect(plan.advisories[0]).toContain("30 agents")
    expect(plan.advisories[1]).toContain("1,800,000 tokens")
  })

  test("digests the script stably, and differently for an edited one", () => {
    const script = `await Promise.all([tools.agent.spawn({ task: "a" }), tools.agent.spawn({ task: "b" })])`
    expect(WorkflowPlan.analyze(script).digest).toBe(WorkflowPlan.analyze(`\n${script}\n`).digest)
    expect(WorkflowPlan.analyze(script).digest).not.toBe(WorkflowPlan.analyze(script.replace(`"b"`, `"c"`)).digest)
    expect(WorkflowPlan.analyze(script).digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
