#!/usr/bin/env bun
/**
 * power-agent overlay: keeps `Env.branded` honest.
 *
 * `Env.branded` (packages/util/src/env.ts) is the list of variable suffixes this build actually
 * resolves through the `POWER_*` helper. `Env.unrecognized()` turns every *other* `POWER_*` the
 * operator exported into a warning, so the list is not documentation — it is the thing that decides
 * whether a running binary tells an operator their variable is dead.
 *
 * The list is maintained by hand, and it has already been wrong once: `AGENT_CONCURRENCY` became a
 * live call site while the list still omitted it, so the CLI warned that a variable which *works*
 * was not read — instructing the operator to abandon a correct setting. The mirror failure is just
 * as quiet: leaving an entry behind after its last call site is deleted suppresses a warning that
 * should have fired.
 *
 * This lint walks every `packages/*​/src` file, collects the reads it can actually see, and fails in
 * both directions:
 *
 *   - a suffix read somewhere but missing from `branded`
 *   - a suffix in `branded` with no read anywhere
 *
 * WHAT IT CAN SEE. Static scanning of TypeScript by regex is not sound, so the rule here is that
 * anything it cannot resolve is reported loudly instead of dropped:
 *
 *   1. a call through the helper — `env("X")`, `truthy("X")`, `names("X")` — including renamed
 *      imports (`import { env as branded }`) and the namespace form (`Env.truthy("X")`);
 *   2. a call through a top-level local wrapper that forwards its first parameter to the helper
 *      (`const positive = (name: string, fallback: number) => { const raw = env(name) ... }`), which
 *      is how `packages/core` reads its numeric budgets;
 *   3. a helper call whose argument is a module-level `const NAME = "SUFFIX"` — how
 *      `server/src/bind-policy.ts` reads its escape hatch;
 *   4. a direct `process.env` access spelled `POWER_X`, or `` process.env[`POWER_${NAME}`] `` with
 *      a resolvable `NAME` — how `codemode/src/stdlib/date.ts` and `server/src/cors.ts` read theirs.
 *      The `OPENCODE_` sibling of such a read is deliberately NOT a site: the upstream reads ~77 of
 *      those straight off `process.env` and branding them all is a merge conflict forever.
 *
 * Anything else — a name built at runtime, a name that only reaches the environment through an
 * Effect `Config` chain — is invisible to a scanner, and pretending otherwise would make this lint
 * lie. Those go in `dynamic` below, one commented entry each, and every entry carries a snippet the
 * lint re-checks: delete the call site and the allowlist entry goes stale and fails too.
 *
 * Run it: `bun run lint:env-branding` (also chained into `bun run lint`).
 */

import { branded } from "../src/env.js"

/** Module specifier the rest of the monorepo imports the helper from. */
const HELPER_MODULE = "@opencode-ai/util/env"

/** The exported functions that perform a branded read. Anything else is not a site. */
const HELPER_FUNCTIONS = ["env", "truthy", "names"] as const

/** Namespace export of the same module: `import { Env } from "@opencode-ai/util/env"`. */
const HELPER_NAMESPACE = "Env"

export const PREFIX = "FORCE_AGENT_"

/** A read of a branded variable that the scanner resolved to a concrete suffix. */
export interface Site {
  readonly suffix: string
  readonly path: string
  readonly line: number
  /** How the read was spelled, quoted back in failure messages. */
  readonly via: string
}

/** A read the scanner found but could not resolve. Never dropped — always reported. */
export interface Blind {
  readonly path: string
  readonly line: number
  readonly reason: string
}

export interface SourceFile {
  readonly path: string
  readonly text: string
}

export interface Scan {
  readonly sites: readonly Site[]
  readonly blind: readonly Blind[]
}

/**
 * Reads a scanner cannot see, declared by hand.
 *
 * `evidence` is re-checked against `path` on every run, so an entry cannot outlive the call site it
 * describes: remove the code and the lint fails on the stale entry instead of silently keeping a
 * suffix alive in `branded`.
 */
export interface DynamicSite {
  readonly suffix: string
  readonly path: string
  /** Substring that must still be present in `path` for this entry to be legitimate. */
  readonly evidence: string
  readonly why: string
}

export const dynamic: readonly DynamicSite[] = [
  {
    suffix: "PASSWORD",
    path: "packages/cli/src/env.ts",
    evidence: `"POWER_PASSWORD",`,
    why:
      "Read through an Effect `Config.redacted` chain over `passwordKeys`, by full name and by " +
      "array index (`Config.redacted(passwordKeys[0])`). The suffix never appears as an argument " +
      "to the helper, so no scan can see it.",
  },
  {
    suffix: "SERVER_PASSWORD",
    path: "packages/cli/src/env.ts",
    evidence: `"POWER_SERVER_PASSWORD",`,
    why: "Same `passwordKeys` chain as PASSWORD — the second spelling the CLI accepts for the same credential.",
  },
]

/** Replace comment bodies with spaces, preserving offsets and line breaks, leaving strings intact. */
export function maskComments(text: string): string {
  const out = text.split("")
  const n = text.length
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " "
  }
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === "/" && d === "/") {
      const end = text.indexOf("\n", i)
      const stop = end === -1 ? n : end
      blank(i, stop)
      i = stop
      continue
    }
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i)
      continue
    }
    i++
  }
  return out.join("")
}

/** Index just past the string literal that starts at `start`. Templates skip balanced `${}`. */
function skipString(text: string, start: number): number {
  const quote = text[start]
  const n = text.length
  let i = start + 1
  while (i < n) {
    const c = text[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    if (quote === "`" && c === "$" && text[i + 1] === "{") {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        const b = text[i]
        if (b === "{") depth++
        else if (b === "}") depth--
        i++
      }
      continue
    }
    i++
  }
  return n
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++
  return line
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** True when `specifier` names the env helper module. */
function isHelperModule(specifier: string, path: string): boolean {
  if (specifier === HELPER_MODULE) return true
  // util's own files reach it relatively; nothing outside util may, so a stray `./env` elsewhere
  // (packages/cli has its own `env.ts`) is not mistaken for the helper.
  return /(^|\/)env\.js$/.test(specifier) && path.includes("packages/util/src/")
}

/** Every local spelling in `file` that performs a branded read: `env`, `branded`, `Env.truthy`, ... */
function readersOf(code: string, path: string): { readers: Set<string>; imports: number } {
  const readers = new Set<string>()
  let imports = 0
  const pattern = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
  for (const match of code.matchAll(pattern)) {
    const specifier = match[2]
    if (!isHelperModule(specifier, path)) continue
    imports++
    for (const raw of match[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/)
      const exported = parts[0]?.trim()
      const local = (parts[1] ?? parts[0])?.trim()
      if (!exported || !local) continue
      if ((HELPER_FUNCTIONS as readonly string[]).includes(exported)) readers.add(local)
      if (exported === HELPER_NAMESPACE) for (const fn of HELPER_FUNCTIONS) readers.add(`${local}.${fn}`)
    }
  }
  return { readers, imports }
}

/** Module-level `const NAME = "SUFFIX"` bindings, the only identifiers a call argument may resolve to. */
function constantsOf(code: string): Map<string, string> {
  const constants = new Map<string, string>()
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"([A-Z][A-Z0-9_]*)"/g))
    constants.set(match[1], match[2])
  return constants
}

interface Wrapper {
  readonly name: string
  readonly parameter: string
  readonly start: number
  readonly end: number
}

/**
 * Top-level functions that forward their first parameter to a reader — `positiveEnv` in
 * `core/src/tool/plugin/agent.ts`, `positive` in `core/src/workflow/plan.ts`.
 *
 * A declaration's body is taken to run until the next declaration that starts a line, which is what
 * the repo's formatting (prettier, no semicolons) actually produces.
 */
function wrappersOf(code: string, readers: ReadonlySet<string>): Wrapper[] {
  const found: Wrapper[] = []
  const declaration =
    /^(?:export\s+)?(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^)]*)\)[^=\n]*=>|(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\))/gm
  const boundary = /^(?:export\s+)?(?:const|let|var|function|class|type|interface|async|declare)\b/gm
  for (const match of code.matchAll(declaration)) {
    const name = match[1] ?? match[3]
    const params = match[2] ?? match[4] ?? ""
    if (!name) continue
    const parameter = params.split(",")[0]?.trim().split(":")[0]?.trim()
    if (!parameter || !/^[A-Za-z_$][\w$]*$/.test(parameter)) continue
    const start = match.index + match[0].length
    boundary.lastIndex = start
    const next = boundary.exec(code)
    const end = next ? next.index : code.length
    const body = code.slice(start, end)
    const forwards = [...readers].some((reader) =>
      new RegExp(`${escapeForRegex(reader)}\\s*\\(\\s*${escapeForRegex(parameter)}\\s*[),]`).test(body),
    )
    if (forwards) found.push({ name, parameter, start, end })
  }
  return found
}

export function scanFile(file: SourceFile): Scan {
  const code = maskComments(file.text)
  const sites: Site[] = []
  const blind: Blind[] = []
  const constants = constantsOf(code)
  const { readers, imports } = readersOf(code, file.path)

  if (imports === 0 && (file.text.includes(HELPER_MODULE) || /from\s*["'][^"']*\/env\.js["']/.test(code)))
    blind.push({
      path: file.path,
      line: 1,
      reason: `references the env helper but no import statement could be parsed, so this file's call sites are invisible to the lint`,
    })

  // A wrapper turns its own name into a reader; a wrapper may wrap a wrapper, so iterate.
  let wrappers: Wrapper[] = []
  for (let pass = 0; pass < 3; pass++) {
    wrappers = wrappersOf(code, readers)
    const before = readers.size
    for (const wrapper of wrappers) readers.add(wrapper.name)
    if (readers.size === before) break
  }

  for (const reader of readers) {
    const call = new RegExp(`${escapeForRegex(reader)}\\s*\\(\\s*(?:"([A-Z][A-Z0-9_]*)"|([A-Za-z_$][\\w$]*))`, "g")
    for (const match of code.matchAll(call)) {
      const line = lineAt(code, match.index)
      if (match[1]) {
        sites.push({ suffix: match[1], path: file.path, line, via: `${reader}("${match[1]}")` })
        continue
      }
      const identifier = match[2]
      const resolved = constants.get(identifier)
      if (resolved) {
        sites.push({ suffix: resolved, path: file.path, line, via: `${reader}(${identifier}) // = "${resolved}"` })
        continue
      }
      // The forwarding call inside a wrapper's own body is the definition, not a call site.
      const inside = wrappers.some(
        (wrapper) => wrapper.parameter === identifier && match.index >= wrapper.start && match.index < wrapper.end,
      )
      if (inside) continue
      blind.push({
        path: file.path,
        line,
        reason: `${reader}(${identifier}) — the argument is not a string literal and does not resolve to a module-level constant`,
      })
    }
  }

  // Direct `process.env` reads of the branded spelling.
  for (const match of code.matchAll(
    /process\s*(?:\?\.)?\.\s*env\s*(?:\?\.)?\s*\[\s*["']POWER_([A-Z][A-Z0-9_]*)["']\s*\]/g,
  ))
    sites.push({
      suffix: match[1],
      path: file.path,
      line: lineAt(code, match.index),
      via: `process.env["POWER_${match[1]}"]`,
    })

  for (const match of code.matchAll(/process\s*(?:\?\.)?\.\s*env\s*(?:\?\.)?\.\s*POWER_([A-Z][A-Z0-9_]*)/g))
    sites.push({
      suffix: match[1],
      path: file.path,
      line: lineAt(code, match.index),
      via: `process.env.POWER_${match[1]}`,
    })

  for (const match of code.matchAll(
    /process\s*(?:\?\.)?\.\s*env\s*(?:\?\.)?\s*\[\s*`POWER_\$\{\s*([A-Za-z_$][\w$]*)\s*\}`\s*\]/g,
  )) {
    const identifier = match[1]
    const line = lineAt(code, match.index)
    const resolved = constants.get(identifier)
    if (resolved) {
      sites.push({
        suffix: resolved,
        path: file.path,
        line,
        via: `process.env[\`POWER_\${${identifier}}\`] // = "POWER_${resolved}"`,
      })
      continue
    }
    blind.push({
      path: file.path,
      line,
      reason: `process.env[\`POWER_\${${identifier}}\`] — ${identifier} does not resolve to a module-level constant`,
    })
  }

  return { sites, blind }
}

export function scan(files: readonly SourceFile[]): Scan {
  const sites: Site[] = []
  const blind: Blind[] = []
  for (const file of files) {
    const result = scanFile(file)
    sites.push(...result.sites)
    blind.push(...result.blind)
  }
  return { sites, blind }
}

export interface CheckInput {
  readonly scan: Scan
  readonly list: readonly string[]
  readonly dynamic: readonly DynamicSite[]
  /** Contents of each file a `dynamic` entry points at, keyed by path. */
  readonly evidence: ReadonlyMap<string, string>
}

/** Human-readable problems, empty when the contract holds. */
export function check(input: CheckInput): string[] {
  const problems: string[] = []
  const listed = new Set(input.list)
  const seen = new Map<string, Site[]>()
  for (const site of input.scan.sites) {
    const bucket = seen.get(site.suffix) ?? []
    bucket.push(site)
    seen.set(site.suffix, bucket)
  }

  for (const [suffix, sites] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
    if (listed.has(suffix)) continue
    const where = sites.map((site) => `      ${site.path}:${site.line}  ${site.via}`).join("\n")
    problems.push(
      `${PREFIX}${suffix} is read by this build but missing from Env.branded.\n` +
        `      The CLI would warn the operator that a variable which WORKS is not read.\n` +
        `      Fix: add "${suffix}" to \`branded\` in packages/util/src/env.ts (keep it sorted).\n` +
        `      Read at:\n${where}`,
    )
  }

  const allowed = new Map(input.dynamic.map((entry) => [entry.suffix, entry]))
  for (const suffix of input.list) {
    if (seen.has(suffix)) continue
    const entry = allowed.get(suffix)
    if (entry) continue
    problems.push(
      `${PREFIX}${suffix} is in Env.branded but nothing reads it.\n` +
        `      The warning that should fire for a dead variable is being suppressed.\n` +
        `      Fix: drop "${suffix}" from \`branded\` in packages/util/src/env.ts, or — if the read is\n` +
        `      built dynamically and cannot be scanned — add it to \`dynamic\` in this file with the\n` +
        `      call site's path and a snippet the lint can re-check.`,
    )
  }

  for (const entry of input.dynamic) {
    if (!listed.has(entry.suffix))
      problems.push(
        `${PREFIX}${entry.suffix} is allowlisted as a dynamic read but is not in Env.branded.\n` +
          `      Fix: add "${entry.suffix}" to \`branded\`, or drop the \`dynamic\` entry.`,
      )
    const text = input.evidence.get(entry.path)
    if (text === undefined) {
      problems.push(
        `the dynamic allowlist points at ${entry.path}, which does not exist.\n` +
          `      Fix: update or remove the \`dynamic\` entry for ${PREFIX}${entry.suffix}.`,
      )
      continue
    }
    if (!text.includes(entry.evidence))
      problems.push(
        `the dynamic allowlist entry for ${PREFIX}${entry.suffix} is stale: ${entry.path} no longer\n` +
          `      contains ${JSON.stringify(entry.evidence)}.\n` +
          `      Fix: if the read is gone, drop "${entry.suffix}" from \`branded\` and from \`dynamic\`;\n` +
          `      if it merely moved, update the entry.`,
      )
  }

  for (const item of input.scan.blind)
    problems.push(
      `${item.path}:${item.line} — the lint cannot resolve this read, so it can neither confirm nor\n` +
        `      deny that Env.branded covers it: ${item.reason}.\n` +
        `      Fix: pass a string literal or a module-level constant, or add the suffix to \`dynamic\`\n` +
        `      in this file with a note explaining why it cannot be seen.`,
    )

  return problems
}

const ROOT = new URL("../../../", import.meta.url)

async function collect(): Promise<SourceFile[]> {
  const root = Bun.fileURLToPath(ROOT)
  const patterns = ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx", "packages/*/*/src/**/*.ts"]
  const paths = new Set<string>()
  for (const pattern of patterns)
    for await (const hit of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) paths.add(hit)
  const files: SourceFile[] = []
  for (const relative of [...paths].sort()) {
    const path = relative.replaceAll("\\", "/")
    if (path.includes("node_modules/") || path.includes("/dist/")) continue
    // The definition of the contract, not a consumer of it.
    if (path === "packages/util/src/env.ts") continue
    files.push({ path, text: await Bun.file(`${root}/${path}`).text() })
  }
  return files
}

export async function run(): Promise<number> {
  const root = Bun.fileURLToPath(ROOT)
  const files = await collect()
  const result = scan(files)
  const evidence = new Map<string, string>()
  for (const entry of dynamic) {
    if (evidence.has(entry.path)) continue
    const file = Bun.file(`${root}/${entry.path}`)
    if (await file.exists()) evidence.set(entry.path, await file.text())
  }
  const problems = check({ scan: result, list: [...branded], dynamic, evidence })
  if (problems.length === 0) {
    console.log(
      `lint:env-branding — ok: ${branded.length} branded suffixes, ` +
        `${result.sites.length} reads across ${files.length} source files ` +
        `(${dynamic.length} allowlisted as dynamic).`,
    )
    return 0
  }
  console.error(`lint:env-branding — Env.branded is out of sync with the code (${problems.length}):\n`)
  for (const [index, problem] of problems.entries()) console.error(`  ${index + 1}. ${problem}\n`)
  console.error(`  Env.branded lives in packages/util/src/env.ts; the lint lives in packages/util/script/lint-env.ts.`)
  return 1
}

if (import.meta.main) process.exit(await run())
