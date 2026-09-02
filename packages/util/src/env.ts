// force-agent overlay: environment variables are branded `FORCE_AGENT_*`. Every earlier
// brand stays honored — `LABHARNESS_*`, `LABFY_*`, `POWER_*` — and so do the
// upstream `OPENCODE_*` names, so a deployment made under any of the four previous
// spellings keeps working. Read a variable by its suffix, never by its full name,
// so all five spellings are always checked.
//
// `env("SERVER_PASSWORD")` -> FORCE_AGENT_SERVER_PASSWORD, else LABHARNESS_SERVER_PASSWORD,
// else LABFY_SERVER_PASSWORD, else POWER_SERVER_PASSWORD, else OPENCODE_SERVER_PASSWORD.

export const PREFIX = "FORCE_AGENT_"
/** The previous brand. Still resolved: `labharness` is published to npm with this spelling. */
export const PREVIOUS_PREFIX = "LABHARNESS_"
/** The brand before that. Still resolved: `labfyagent` was published with this spelling. */
export const LABFY_PREFIX = "LABFY_"
/** The brand before that. Still resolved: dropping it would discard a deployed value. */
export const LEGACY_PREFIX = "POWER_"
export const UPSTREAM_PREFIX = "OPENCODE_"

/** Every branded prefix, most specific first. Upstream is not "branded" - it is the fallback. */
const PREFIXES = [PREFIX, PREVIOUS_PREFIX, LABFY_PREFIX, LEGACY_PREFIX] as const

/**
 * Every spelling this build resolves, in precedence order — the branded ones
 * first, upstream last. A list rather than a hand-written chain: the brand has
 * changed four times, and each rename used to mean editing `env`, `names` and a
 * tuple type in lockstep. Appending here is now the whole change.
 */
const RESOLVED = [...PREFIXES, UPSTREAM_PREFIX] as const

export function env(name: string): string | undefined {
  for (const prefix of RESOLVED) {
    const value = process.env[`${prefix}${name}`]
    if (value !== undefined) return value
  }
  return undefined
}

/** Every spelling of a variable, most specific first. Useful for deletes and Config chains. */
export function names(name: string): readonly string[] {
  return RESOLVED.map((prefix) => `${prefix}${name}`)
}

/** Truthy in the sense the CLI uses everywhere: "1" or "true", case-insensitive. */
export function truthy(name: string): boolean {
  return ["1", "true"].includes(env(name)?.toLowerCase() ?? "")
}

/**
 * Every suffix this build actually resolves through `env`/`truthy`/`names`.
 *
 * The upstream has ~77 `OPENCODE_*` variables read straight off `process.env`;
 * renaming all of them would be an eternal merge conflict, so the overlay routes
 * only the operationally relevant ones through the helper. That is a deliberate
 * gap, and the gap used to fail *silently* and *open*: `POWER_MODELS_URL` was
 * accepted by the shell, ignored by the process, and the binary went on calling
 * the default catalog host. This list is the contract — keep it in sync with the
 * call sites, and `unrecognized()` turns every other branded-prefix variable into
 * a warning instead of a surprise. PATCHES.md documents what is deliberately absent.
 *
 * Keeping it in sync is not left to memory: `script/lint-env.ts` (`bun run
 * lint:env-branding`, chained into `bun run lint`) scans the tree for real call
 * sites and fails both ways — a suffix read but unlisted, and a suffix listed
 * but unread. It already caught `AGENT_CONCURRENCY` going live while this list
 * still omitted it, which made the CLI warn about a variable that works.
 */
export const branded = [
  "AGENT_CONCURRENCY",
  "AGENT_SPAWN_LIMIT",
  "ALLOW_UNAUTHENTICATED_LOOPBACK",
  "BROWSER_CODEMODE",
  "BROWSER_HEADED",
  "BROWSER_PATH",
  "CODEMODE_DETERMINISTIC",
  "CONFIG",
  "CONFIG_CONTENT",
  "CONFIG_DIR",
  "DB",
  "DEV_CORS",
  "DISABLE_AUTOUPDATE",
  "DISABLE_CHANNEL_DB",
  "DISABLE_MODELS_FETCH",
  "ENABLE_AUTOUPDATE",
  "LOG_LEVEL",
  "MODELS_PATH",
  "MODELS_URL",
  "PASSWORD",
  "PRINT_LOGS",
  "SANDBOX",
  "SERVER_PASSWORD",
  "SIMULATE",
  "WORKFLOW_AGENT_TOKENS",
  "WORKFLOW_FANOUT",
] as const

export type Branded = (typeof branded)[number]

const brandedSet: ReadonlySet<string> = new Set<string>(branded)

/** True when `env(name)` is actually consulted somewhere in this build. */
export function recognized(name: string): name is Branded {
  return brandedSet.has(name)
}

/** The branded prefix `key` carries, or `undefined` when it carries none. */
function brandOf(key: string): (typeof PREFIXES)[number] | undefined {
  return PREFIXES.find((prefix) => key.startsWith(prefix))
}

/**
 * Branded variables present in the environment that this build never reads —
 * under the current `FORCE_AGENT_*` prefix or any older brand: `LABHARNESS_*`,
 * `LABFY_*`, `POWER_*`. The older prefixes are included deliberately: an
 * operator still on an old brand is exactly the one who needs to hear that a
 * name was dropped on the floor.
 *
 * Sorted, full names — the operator needs the exact spelling to act on it.
 */
export function unrecognized(source: Record<string, string | undefined> = process.env): string[] {
  return Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .filter((key) => {
      const prefix = brandOf(key)
      return prefix !== undefined && !recognized(key.slice(prefix.length))
    })
    .sort()
}

export interface WarnOptions {
  readonly source?: Record<string, string | undefined>
  /** Defaults to stderr. Injected in tests. */
  readonly write?: (line: string) => void
}

/**
 * Say out loud which branded variables were set and dropped on the floor.
 *
 * Deliberately written to stderr rather than through the Effect logger: the
 * stderr logger is gated behind `PRINT_LOGS`, and a misconfiguration that only
 * shows up when logging is already turned on is the same silent failure again.
 *
 * Returns the names it warned about so a caller can assert on them.
 */
export function warnUnrecognized(options: WarnOptions = {}): readonly string[] {
  const found = unrecognized(options.source)
  if (found.length === 0) return found
  const write = options.write ?? ((line: string) => void process.stderr.write(line))
  const detail = found.map((name) => {
    const prefix = brandOf(name) ?? ""
    return `${name} (this build reads ${UPSTREAM_PREFIX}${name.slice(prefix.length)})`
  })
  const older = found.some((name) => {
    const prefix = brandOf(name)
    return prefix !== undefined && prefix !== PREFIX
  })
  write(
    `warning: ${found.length} ${PREFIXES.map((prefix) => `${prefix}*`).join("/")} variable${found.length === 1 ? " is" : "s are"} set but not read by this build: ` +
      `${detail.join(", ")}. Export the ${UPSTREAM_PREFIX} spelling instead, or see PATCHES.md for the branded list.` +
      (older
        ? ` Note that ${PREVIOUS_PREFIX}* and ${LEGACY_PREFIX}* are earlier brands: they are still honored for the names this build does read, but ${PREFIX}* is the current prefix.`
        : "") +
      `\n`,
  )
  return found
}

export * as Env from "./env.js"
