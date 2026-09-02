import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

/**
 * power-agent overlay: regression test for the battle-test finding that deterministic mode used to
 * deliver zero determinism.
 *
 * `Date.now()` was refused, but `+new Date()`, `new Date().getTime()` and `Date()` all still read
 * the host clock, so two runs of the same program returned different answers and a replay diverged
 * from the run the user approved. The interesting part of the finding was that it reproduced with
 * the *operator's* switch — the `POWER_CODEMODE_DETERMINISTIC=1` environment variable, which
 * `stdlib/date.ts` reads once at module load — not with the in-process `setDeterministic` used by
 * `date-deterministic.test.ts`. Only a fresh process exercises that path, so this file spawns one.
 */

const probe = fileURLToPath(new URL("./fixtures/deterministic-env-probe.ts", import.meta.url))

type ProbeResult = { ok: boolean; value?: unknown; error?: string }

const runUnderEnvFlag = async (
  programs: Array<string>,
): Promise<{ deterministic: boolean; results: Array<ProbeResult> }> => {
  const child = Bun.spawn([process.execPath, "run", probe, ...programs], {
    env: { ...process.env, POWER_CODEMODE_DETERMINISTIC: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`probe exited ${exitCode}: ${stderr}`)
  return JSON.parse(stdout)
}

describe("BATTLE: deterministic mode no longer leaks the host clock", () => {
  test("the environment variable alone turns the flag on, and closes every clock read", async () => {
    const { deterministic, results } = await runUnderEnvFlag([
      "return Date.now()",
      "return +new Date()",
      "return new Date().getTime()",
      "return new Date().toISOString()",
      "return String(Date())",
      "return Math.random()",
      // The pure escape hatch the refusal message points at must survive the same process.
      `return [Date.parse("2020-01-01T00:00:00.000Z"), Date.UTC(2020, 0, 1), new Date(1234567890).getTime()]`,
    ])

    expect(deterministic).toBe(true)

    const refusals = results.slice(0, 6)
    for (const result of refusals) {
      expect(result.ok).toBe(false)
      expect(result.error).toContain("is not available in deterministic mode")
    }

    expect(results[6]).toEqual({ ok: true, value: [1577836800000, 1577836800000, 1234567890] })
  })

  test("two runs of the same program cannot disagree, because neither produces a value", async () => {
    const { results } = await runUnderEnvFlag(["return new Date().toISOString()", "return new Date().toISOString()"])
    expect(results[0]?.ok).toBe(false)
    expect(results[1]?.ok).toBe(false)
    expect(results[0]?.error).toEqual(results[1]?.error as string)
  })
})
