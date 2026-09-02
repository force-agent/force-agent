import { afterEach, expect, test } from "bun:test"
import { BindPolicy } from "@opencode-ai/server/bind-policy"
import { Env } from "../src/env"
import { ServerProcess } from "../src/server-process"

// Two findings from the battle test, pinned as executable regressions.
//
// 1. A password made only of whitespace passed as "configured", so
//    `--hostname 0.0.0.0` was accepted and the server was reachable behind a
//    credential nobody could type wrong.
// 2. POWER_MODELS_URL was accepted by the shell and ignored by the process: the
//    binary still called the default catalog host, and nothing said so.

const script = `
  import { Effect } from "effect"
  const { Env } = await import(${JSON.stringify(new URL("../src/env.ts", import.meta.url).href)})
  const value = await Effect.runPromise(Env.configuredPassword)
  process.stdout.write(JSON.stringify(value === undefined ? null : value))
`

// Effect's default ConfigProvider snapshots the environment on first resolution,
// so each case needs its own process (see password-fallback.test.ts).
function resolve(vars: Record<string, string>) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(Env.passwordKeys as readonly string[]).includes(key)) env[key] = value
  }
  Object.assign(env, vars)
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: new URL("..", import.meta.url).pathname.slice(1),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return JSON.parse(result.stdout.toString()) as string | null
}

test("a whitespace-only password is not a configured credential", () => {
  expect(resolve({ POWER_PASSWORD: "   " })).toBeNull()
  expect(resolve({ POWER_PASSWORD: "\t\n " })).toBeNull()
  expect(resolve({ OPENCODE_SERVER_PASSWORD: " " })).toBeNull()
})

test("a real password survives untrimmed, so existing clients keep authenticating", () => {
  expect(resolve({ POWER_PASSWORD: "  hunter2-and-more  " })).toBe("  hunter2-and-more  ")
})

test("a whitespace-only password cannot unlock a reachable bind", () => {
  for (const secret of ["   ", "\t", "\n", ""]) {
    expect(BindPolicy.classify(secret)).toBe("ephemeral")
    expect(BindPolicy.check({ hostname: "0.0.0.0", credential: BindPolicy.classify(secret) })).toBeInstanceOf(
      BindPolicy.RefusedError,
    )
  }
})

const modelKeys = ["POWER_MODELS_URL", "OPENCODE_MODELS_URL", "POWER_MODELS_PATH", "OPENCODE_MODELS_PATH"]
const saved = new Map(modelKeys.map((key) => [key, process.env[key]] as const))

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("POWER_MODELS_URL is honored instead of the default catalog host", () => {
  for (const key of modelKeys) delete process.env[key]
  process.env.POWER_MODELS_URL = "http://127.0.0.1:9/sentinel"
  expect(ServerProcess.models().url).toBe("http://127.0.0.1:9/sentinel")
})

test("the upstream OPENCODE_MODELS_URL still works, and the branded name outranks it", () => {
  for (const key of modelKeys) delete process.env[key]
  process.env.OPENCODE_MODELS_URL = "http://legacy"
  expect(ServerProcess.models().url).toBe("http://legacy")
  process.env.POWER_MODELS_URL = "http://branded"
  expect(ServerProcess.models().url).toBe("http://branded")
})

test("POWER_MODELS_PATH is honored", () => {
  for (const key of modelKeys) delete process.env[key]
  process.env.POWER_MODELS_PATH = "/tmp/catalog.json"
  expect(ServerProcess.models().file).toBe("/tmp/catalog.json")
})
