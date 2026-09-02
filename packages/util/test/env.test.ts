import { afterEach, describe, expect, test } from "bun:test"
import { branded, env, names, recognized, truthy, unrecognized, warnUnrecognized } from "../src/env.js"

const keys = ["LABHARNESS_ENV_FIXTURE", "LABFY_ENV_FIXTURE", "POWER_ENV_FIXTURE", "OPENCODE_ENV_FIXTURE"]

afterEach(() => {
  for (const key of keys) delete process.env[key]
})

describe("env", () => {
  test("prefers the branded name", () => {
    process.env.LABHARNESS_ENV_FIXTURE = "branded"
    process.env.LABFY_ENV_FIXTURE = "previous"
    process.env.POWER_ENV_FIXTURE = "legacy"
    process.env.OPENCODE_ENV_FIXTURE = "upstream"
    expect(env("ENV_FIXTURE")).toBe("branded")
  })

  // The rebrand from LABFY_ to LABHARNESS_ must not strand a deployment that only
  // exports a previous spelling — losing one would boot a server with no auth.
  test("falls back to the previous brand", () => {
    process.env.LABFY_ENV_FIXTURE = "previous"
    process.env.POWER_ENV_FIXTURE = "legacy"
    process.env.OPENCODE_ENV_FIXTURE = "upstream"
    expect(env("ENV_FIXTURE")).toBe("previous")
  })

  test("falls back to the brand before that", () => {
    process.env.POWER_ENV_FIXTURE = "legacy"
    process.env.OPENCODE_ENV_FIXTURE = "upstream"
    expect(env("ENV_FIXTURE")).toBe("legacy")
  })

  test("falls back to the upstream name", () => {
    process.env.OPENCODE_ENV_FIXTURE = "upstream"
    expect(env("ENV_FIXTURE")).toBe("upstream")
  })

  test("is undefined when neither is set", () => {
    expect(env("ENV_FIXTURE")).toBeUndefined()
  })

  test("names lists every spelling, most specific first", () => {
    expect(names("ENV_FIXTURE")).toEqual([
      "FORCE_AGENT_ENV_FIXTURE",
      "LABHARNESS_ENV_FIXTURE",
      "LABFY_ENV_FIXTURE",
      "POWER_ENV_FIXTURE",
      "OPENCODE_ENV_FIXTURE",
    ])
  })

  test("truthy accepts 1 and true in any spelling", () => {
    expect(truthy("ENV_FIXTURE")).toBe(false)
    process.env.OPENCODE_ENV_FIXTURE = "TRUE"
    expect(truthy("ENV_FIXTURE")).toBe(true)
    process.env.POWER_ENV_FIXTURE = "0"
    expect(truthy("ENV_FIXTURE")).toBe(false)
    process.env.POWER_ENV_FIXTURE = "1"
    expect(truthy("ENV_FIXTURE")).toBe(true)
    process.env.LABFY_ENV_FIXTURE = "0"
    expect(truthy("ENV_FIXTURE")).toBe(false)
    process.env.LABFY_ENV_FIXTURE = "true"
    expect(truthy("ENV_FIXTURE")).toBe(true)
    process.env.LABHARNESS_ENV_FIXTURE = "0"
    expect(truthy("ENV_FIXTURE")).toBe(false)
    process.env.LABHARNESS_ENV_FIXTURE = "true"
    expect(truthy("ENV_FIXTURE")).toBe(true)
  })
})

// Battle-test finding: only a handful of the ~77 upstream variables are routed
// through this helper, and the gap failed silently — POWER_MODELS_URL was set,
// ignored, and the binary went on calling the default catalog host. The gap is
// still deliberate; being quiet about it is not.
const moduleURL = new URL("../src/env.ts", import.meta.url).href

describe("unrecognized LABHARNESS_*/LABFY_*/POWER_* variables", () => {
  test("branded is sorted and free of duplicates, so the contract stays readable", () => {
    expect([...branded]).toEqual([...new Set(branded)].sort())
  })

  test("every suffix in branded is recognized", () => {
    for (const name of branded) expect(recognized(name)).toBe(true)
  })

  test("names a branded variable this build never reads, under any branded prefix", () => {
    const source = {
      LABHARNESS_ZED_DB: "1",
      LABFY_ZED_UI: "1",
      POWER_ZED_UI: "1",
      OPENCODE_ZED_DB: "1",
      PATH: "/usr/bin",
    }
    expect(unrecognized(source)).toEqual(["LABFY_ZED_UI", "LABHARNESS_ZED_DB", "POWER_ZED_UI"])
  })

  test("says nothing about the variables that do have a branded fallback", () => {
    const source = {
      ...Object.fromEntries(branded.map((name) => [`LABHARNESS_${name}`, "x"])),
      ...Object.fromEntries(branded.map((name) => [`LABFY_${name}`, "x"])),
      ...Object.fromEntries(branded.map((name) => [`POWER_${name}`, "x"])),
    }
    expect(unrecognized(source)).toEqual([])
  })

  test("ignores anything that is not a branded prefix", () => {
    expect(
      unrecognized({
        POWERSHELL_TELEMETRY: "1",
        POWERLEVEL9K_MODE: "x",
        LABFYISH: "y",
        LABHARNESSISH: "z",
        OPENCODE_ZED_DB: "1",
      }),
    ).toEqual([])
  })

  test("the warning carries the exact name and the spelling that would work", () => {
    const lines: string[] = []
    const found = warnUnrecognized({
      source: { LABHARNESS_ZED_DB: "1", LABFY_ZED_UI: "y", POWER_TERMINAL: "x" },
      write: (line) => void lines.push(line),
    })
    expect(found).toEqual(["LABFY_ZED_UI", "LABHARNESS_ZED_DB", "POWER_TERMINAL"])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("LABHARNESS_ZED_DB")
    expect(lines[0]).toContain("OPENCODE_ZED_DB")
    expect(lines[0]).toContain("LABFY_ZED_UI")
    expect(lines[0]).toContain("OPENCODE_ZED_UI")
    expect(lines[0]).toContain("POWER_TERMINAL")
    expect(lines[0]).toContain("OPENCODE_TERMINAL")
  })

  test("the default sink is the process's own stderr", () => {
    const script = "const m = await import(" + JSON.stringify(moduleURL) + "); m.warnUnrecognized()"
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      env: { ...process.env, LABHARNESS_ZED_DB: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe("")
    expect(result.stderr.toString()).toContain("LABHARNESS_ZED_DB")
    expect(result.stderr.toString()).toContain("OPENCODE_ZED_DB")
  })

  test("stays quiet when there is nothing to say", () => {
    const lines: string[] = []
    expect(warnUnrecognized({ source: { PATH: "/usr/bin" }, write: (line) => void lines.push(line) })).toEqual([])
    expect(lines).toEqual([])
  })
})
