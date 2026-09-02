import { describe, expect, test } from "bun:test"
import { branded } from "../src/env.js"
import { check, dynamic, maskComments, run, scan, scanFile, type SourceFile } from "../script/lint-env.js"

// power-agent overlay: `Env.branded` is hand-maintained and has already drifted once —
// AGENT_CONCURRENCY became a live call site while the list still omitted it, so the CLI told the
// operator that a variable which works was not read. `script/lint-env.ts` is the check that catches
// that drift; these tests are the check on the check.

const file = (text: string, path = "packages/demo/src/demo.ts"): SourceFile => ({ path, text })

const suffixes = (input: SourceFile) =>
  scanFile(input)
    .sites.map((site) => site.suffix)
    .sort()

describe("scanning for reads", () => {
  test("a plain helper call", () => {
    expect(
      suffixes(file(`import { env } from "@opencode-ai/util/env"\nexport const value = env("LOG_LEVEL")\n`)),
    ).toEqual(["LOG_LEVEL"])
  })

  test("a renamed import — packages/cli spells it `env as branded`", () => {
    expect(
      suffixes(
        file(`import { env as branded } from "@opencode-ai/util/env"\nconst x = branded("PRINT_LOGS") === "1"\n`),
      ),
    ).toEqual(["PRINT_LOGS"])
  })

  test("the namespace form — packages/server spells it `Env.truthy`", () => {
    expect(suffixes(file(`import { Env } from "@opencode-ai/util/env"\nconst on = Env.truthy("DEV_CORS")\n`))).toEqual([
      "DEV_CORS",
    ])
  })

  test("`names` counts too", () => {
    expect(suffixes(file(`import { names } from "@opencode-ai/util/env"\nconst both = names("DB")\n`))).toEqual(["DB"])
  })

  test("a call through a local wrapper that forwards its first parameter", () => {
    const source = `import { env } from "@opencode-ai/util/env"

const positive = (name: string, fallback: number) => {
  const raw = env(name)
  if (raw === undefined) return fallback
  return Number.parseInt(raw, 10)
}

const fanout = positive("WORKFLOW_FANOUT", 4)
const tokens = positive("WORKFLOW_AGENT_TOKENS", 100)
`
    expect(suffixes(file(source))).toEqual(["WORKFLOW_AGENT_TOKENS", "WORKFLOW_FANOUT"])
  })

  test("the wrapper's own forwarding call is the definition, not a site", () => {
    const source = `import { env } from "@opencode-ai/util/env"

const positive = (name: string, fallback: number) => {
  const raw = env(name)
  return raw ?? fallback
}
`
    const result = scanFile(file(source))
    expect(result.sites).toEqual([])
    expect(result.blind).toEqual([])
  })

  test("an argument that resolves to a module-level constant", () => {
    const source = `import { Env } from "@opencode-ai/util/env"
export const escapeVariable = "ALLOW_UNAUTHENTICATED_LOOPBACK"
const escape = Env.truthy(escapeVariable)
`
    expect(suffixes(file(source))).toEqual(["ALLOW_UNAUTHENTICATED_LOOPBACK"])
  })

  test("a direct process.env read of the branded spelling, in every notation", () => {
    const source = `const key = "CODEMODE_DETERMINISTIC"
const a = process.env?.["POWER_CODEMODE_DETERMINISTIC"]
const b = process.env.POWER_SIMULATE
const c = process.env[\`POWER_\${key}\`]
`
    expect(suffixes(file(source))).toEqual(["CODEMODE_DETERMINISTIC", "CODEMODE_DETERMINISTIC", "SIMULATE"])
  })

  test("the OPENCODE_ fallback of a direct read is not a branded site", () => {
    // The upstream reads ~77 OPENCODE_* variables straight off process.env. Counting those would
    // demand 77 entries in `branded` and make the list meaningless.
    const source = `const raw = process.env["OPENCODE_NOT_BRANDED"] ?? process.env.OPENCODE_ALSO_NOT\n`
    expect(scanFile(file(source))).toEqual({ sites: [], blind: [] })
  })

  test("comments are not code", () => {
    const source = `import { env } from "@opencode-ai/util/env"
// env("GHOST_LINE_COMMENT") is only prose
/* env("GHOST_BLOCK_COMMENT") and process.env.POWER_GHOST_BLOCK too */
const real = env("DB")
`
    expect(suffixes(file(source))).toEqual(["DB"])
  })

  test("a helper import in another package's own env module is not the helper", () => {
    // packages/cli has its own src/env.ts; `import { Env } from "../env"` must not read as ours.
    const source = `import { Env } from "../env"\nconst keys = Env.passwordKeys\nconst v = Env.env("NOT_OURS")\n`
    expect(scanFile(file(source, "packages/cli/src/services/standalone.ts"))).toEqual({ sites: [], blind: [] })
  })

  test("util's own relative import does count", () => {
    const source = `import { env } from "../env.js"\nconst level = env("LOG_LEVEL")\n`
    expect(suffixes(file(source, "packages/util/src/observability/logging.ts"))).toEqual(["LOG_LEVEL"])
  })
})

describe("reads the scanner cannot resolve are reported, never dropped", () => {
  test("a computed argument", () => {
    const source = `import { env } from "@opencode-ai/util/env"\nexport const read = (key: string) => env(key)\n`
    // `read` forwards, so it registers as a wrapper and its own call is the definition...
    expect(scanFile(file(source)).blind).toEqual([])
    // ...but a call with an unresolvable argument at the use site is blind.
    const caller = `import { env } from "@opencode-ai/util/env"\nconst v = env(process.argv[2]!)\n`
    const blind = scanFile(file(caller)).blind
    expect(blind).toHaveLength(1)
    expect(blind[0].reason).toContain("does not resolve to a module-level constant")
  })

  test("a template whose identifier is not a module-level constant", () => {
    const source = "function f(key: string) { return process.env[`POWER_${key}`] }\n"
    const blind = scanFile(file(source)).blind
    expect(blind).toHaveLength(1)
    expect(blind[0].reason).toContain("POWER_${key}")
  })

  test("a file that reaches the helper through an import shape the lint cannot parse", () => {
    const source = `const { env } = await import("@opencode-ai/util/env")\nconst v = env("MYSTERY")\n`
    const blind = scanFile(file(source)).blind
    expect(blind).toHaveLength(1)
    expect(blind[0].reason).toContain("invisible to the lint")
  })
})

const noEvidence = new Map<string, string>()

describe("the contract check fails in both directions", () => {
  const site = {
    suffix: "AGENT_CONCURRENCY",
    path: "packages/core/src/tool/plugin/agent.ts",
    line: 111,
    via: 'positiveEnv("AGENT_CONCURRENCY")',
  }

  test("a read that is missing from the list", () => {
    // The exact regression this lint exists for.
    const problems = check({
      scan: { sites: [site], blind: [] },
      list: ["DB"],
      dynamic: [],
      evidence: noEvidence,
    })
    expect(problems).toHaveLength(2) // the missing read, and DB now having no read
    expect(problems[0]).toContain("FORCE_AGENT_AGENT_CONCURRENCY is read by this build but missing from Env.branded")
    expect(problems[0]).toContain("packages/core/src/tool/plugin/agent.ts:111")
  })

  test("a listed name with no read left", () => {
    const problems = check({ scan: { sites: [], blind: [] }, list: ["ZOMBIE"], dynamic: [], evidence: noEvidence })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("FORCE_AGENT_ZOMBIE is in Env.branded but nothing reads it")
  })

  test("silence when the list matches the code", () => {
    expect(
      check({ scan: { sites: [site], blind: [] }, list: ["AGENT_CONCURRENCY"], dynamic: [], evidence: noEvidence }),
    ).toEqual([])
  })

  test("an allowlisted dynamic read stands in for a scan hit", () => {
    const entry = {
      suffix: "PASSWORD",
      path: "packages/cli/src/env.ts",
      evidence: `"POWER_PASSWORD",`,
      why: "Config chain",
    }
    const evidence = new Map([[entry.path, `export const passwordKeys = [\n  "POWER_PASSWORD",\n] as const\n`]])
    expect(check({ scan: { sites: [], blind: [] }, list: ["PASSWORD"], dynamic: [entry], evidence })).toEqual([])
  })

  test("an allowlist entry whose call site is gone goes stale instead of covering for it", () => {
    const entry = {
      suffix: "PASSWORD",
      path: "packages/cli/src/env.ts",
      evidence: `"POWER_PASSWORD",`,
      why: "Config chain",
    }
    const evidence = new Map([[entry.path, "export const passwordKeys = [] as const\n"]])
    const problems = check({ scan: { sites: [], blind: [] }, list: ["PASSWORD"], dynamic: [entry], evidence })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("is stale")
  })

  test("an allowlisted name that is not in the list is a problem too", () => {
    const entry = { suffix: "GONE", path: "packages/cli/src/env.ts", evidence: "x", why: "" }
    const problems = check({
      scan: { sites: [], blind: [] },
      list: [],
      dynamic: [entry],
      evidence: new Map([[entry.path, "x"]]),
    })
    expect(
      problems.some((problem) => problem.includes("allowlisted as a dynamic read but is not in Env.branded")),
    ).toBe(true)
  })

  test("a blind read fails the check rather than passing quietly", () => {
    const problems = check({
      scan: { sites: [], blind: [{ path: "packages/demo/src/demo.ts", line: 3, reason: "env(key)" }] },
      list: [],
      dynamic: [],
      evidence: noEvidence,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("cannot resolve this read")
  })
})

test("maskComments keeps offsets and line numbers intact", () => {
  const source = `const a = 1 // env("X")\nconst b = "//not a comment"\n`
  const masked = maskComments(source)
  expect(masked).toHaveLength(source.length)
  expect(masked.split("\n")).toHaveLength(source.split("\n").length)
  expect(masked).not.toContain(`env("X")`)
  expect(masked).toContain(`"//not a comment"`)
})

test("scan concatenates per-file results", () => {
  const a = file(`import { env } from "@opencode-ai/util/env"\nconst v = env("DB")\n`, "packages/a/src/a.ts")
  const b = file(`import { env } from "@opencode-ai/util/env"\nconst v = env("CONFIG")\n`, "packages/b/src/b.ts")
  expect(scan([a, b]).sites.map((site) => site.suffix)).toEqual(["DB", "CONFIG"])
})

// The lint against the real tree. `bun run lint:env-branding` runs the same code; this keeps the
// contract enforced by `bun test` in this package as well.
test("Env.branded matches the reads in this repository", async () => {
  expect(await run()).toBe(0)
}, 60_000)

test("every dynamic allowlist entry is also in Env.branded", () => {
  const listed: readonly string[] = branded
  for (const entry of dynamic) expect(listed).toContain(entry.suffix)
})
