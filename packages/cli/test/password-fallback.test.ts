import { expect, test } from "bun:test"
import { Env } from "../src/env"

// The rebrand keeps the previous LABFY_*, the POWER_* brand before it and the
// upstream OPENCODE_* spellings alive. Losing any fallback
// would silently drop a deployed password and boot the server with a random one,
// so the resolution order is pinned here, not just the list of key names.
//
// Each case runs in a fresh process: Effect's default ConfigProvider snapshots
// the environment once, so mutating process.env between assertions in one
// process would keep returning the first value resolved.

const script = `
  import { Effect, Redacted } from "effect"
  const { Env } = await import(${JSON.stringify(new URL("../src/env.ts", import.meta.url).href)})
  const value = await Effect.runPromise(Env.password)
  process.stdout.write(JSON.stringify(value === undefined ? null : Redacted.value(value)))
`

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

test("resolves from the upstream OPENCODE_SERVER_PASSWORD alone", () => {
  expect(resolve({ OPENCODE_SERVER_PASSWORD: "legacy-server" })).toBe("legacy-server")
})

test("resolves from the upstream OPENCODE_PASSWORD alone", () => {
  expect(resolve({ OPENCODE_PASSWORD: "legacy-plain" })).toBe("legacy-plain")
})

test("resolves from the branded LABHARNESS_SERVER_PASSWORD alone", () => {
  expect(resolve({ LABHARNESS_SERVER_PASSWORD: "harness-server" })).toBe("harness-server")
})

test("resolves from the branded LABHARNESS_PASSWORD alone", () => {
  expect(resolve({ LABHARNESS_PASSWORD: "harness-plain" })).toBe("harness-plain")
})

test("resolves from the previous LABFY_SERVER_PASSWORD alone", () => {
  expect(resolve({ LABFY_SERVER_PASSWORD: "labfy-server" })).toBe("labfy-server")
})

test("resolves from the previous LABFY_PASSWORD alone", () => {
  expect(resolve({ LABFY_PASSWORD: "labfy-plain" })).toBe("labfy-plain")
})

test("resolves from the previous POWER_SERVER_PASSWORD alone", () => {
  expect(resolve({ POWER_SERVER_PASSWORD: "branded-server" })).toBe("branded-server")
})

test("resolves from the previous POWER_PASSWORD alone", () => {
  expect(resolve({ POWER_PASSWORD: "branded-plain" })).toBe("branded-plain")
})

test("the newer spellings outrank the older ones", () => {
  expect(resolve({ POWER_SERVER_PASSWORD: "branded-server", OPENCODE_PASSWORD: "legacy-plain" })).toBe("branded-server")
  expect(resolve({ POWER_PASSWORD: "branded-plain", POWER_SERVER_PASSWORD: "branded-server" })).toBe("branded-plain")
  expect(resolve({ LABFY_SERVER_PASSWORD: "labfy-server", POWER_PASSWORD: "branded-plain" })).toBe("labfy-server")
  expect(resolve({ LABFY_PASSWORD: "labfy-plain", LABFY_SERVER_PASSWORD: "labfy-server" })).toBe("labfy-plain")
  expect(resolve({ LABHARNESS_SERVER_PASSWORD: "harness-server", LABFY_PASSWORD: "labfy-plain" })).toBe(
    "harness-server",
  )
  expect(resolve({ LABHARNESS_PASSWORD: "harness-plain", LABHARNESS_SERVER_PASSWORD: "harness-server" })).toBe(
    "harness-plain",
  )
})

test("is null when no spelling is set, so the caller falls back to a random secret", () => {
  expect(resolve({})).toBeNull()
})
