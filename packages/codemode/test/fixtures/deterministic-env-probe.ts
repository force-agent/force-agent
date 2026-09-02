/**
 * power-agent overlay: probe run in a child process by `test/zz-battle-determinism.test.ts`.
 *
 * The deterministic flag is read once, at module load, from the environment, so the operator's
 * real switch (`POWER_CODEMODE_DETERMINISTIC=1`) can only be exercised by a fresh process. This
 * file executes one CodeMode program per argument and prints `{ ok, value | error }` as JSON.
 */
import { Effect } from "effect"
import { CodeMode } from "../../src/index.js"
import { isDeterministic } from "../../src/stdlib/date.js"

const programs = process.argv.slice(2)
const results: Array<{ ok: boolean; value?: unknown; error?: string }> = []

for (const code of programs) {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools: {} }))
  results.push(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error.message })
}

process.stdout.write(JSON.stringify({ deterministic: isDeterministic(), results }))
