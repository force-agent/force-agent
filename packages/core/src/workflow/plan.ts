export * as WorkflowPlan from "./plan.js"

import { env } from "@opencode-ai/util/env"
import { createHash } from "node:crypto"

/**
 * force-agent overlay: pre-flight description of a multi-agent Code Mode run.
 *
 * A Code Mode program that fans out with `tools.agent.spawn` can start dozens of child sessions
 * before the user sees anything, and each child bills its own context. The gate in
 * `plugin/workflow-gate.ts` shows three numbers when it asks — how many phases the script runs, how
 * many agents it admits, and how many tokens that projects to — plus a digest so a remembered
 * approval survives a re-run of the *same* script and nothing else.
 *
 * THIS IS METADATA, NOT THE DECISION. It is a static estimate read off the source text, and static
 * analysis of JavaScript by regex cannot be made sound: an alias (`const s = tools.agent.spawn`), a
 * computed member name, or a helper function called from `.map()` all read as zero or one call site
 * while starting any number of children. The gate therefore asserts off the run's REAL spawns, seen
 * at `tool.execute.before`; this estimate only enriches the prompt and, when it already shows a
 * fan-out, lets the prompt appear before the first child instead of after it. An under-count defers
 * the question, it never cancels it.
 *
 * The digest is taken over the script text, so it stays stable — and a remembered approval keeps
 * matching — even when the estimate and the real fan-out disagree.
 */

/** Dedicated permission action, distinct from the per-child `subagent` assertion. */
export const ACTION = "workflow.run"

/**
 * Below this, the run is a plain subagent call that the `subagent` action already gates. Applied to
 * the static estimate (to decide whether the prompt can be raised up front) and, decisively, to the
 * count of real spawns the gate observes.
 */
export const MULTI_AGENT_MINIMUM = 2

/** Advisory-only ceilings. Crossing one warns; it never blocks. */
export const AGENT_ADVISORY = 25
export const TOKEN_ADVISORY = 1_500_000

const DEFAULT_TOKENS_PER_AGENT = 60_000
const DEFAULT_FANOUT = 4
/** Metadata rides the event stream to every connected client, so the script is capped. */
const SCRIPT_LIMIT = 16_000

export interface Phase {
  /** 1-based position in the run. */
  readonly index: number
  /** `parallel` means the spawns share a `Promise` combinator and start together. */
  readonly kind: "parallel" | "sequential"
  readonly agents: number
}

export interface Plan {
  /** `sha256:<hex>` over the normalized script. Stable across runs, different for a changed one. */
  readonly digest: string
  readonly phases: ReadonlyArray<Phase>
  /** Projected child sessions across every phase. */
  readonly agents: number
  /** Projected total context, `agents * tokensPerAgent`. */
  readonly tokens: number
  readonly advisories: ReadonlyArray<string>
  /** The script as shown to the approver, truncated when very long. */
  readonly script: string
}

const positive = (name: string, fallback: number) => {
  const raw = env(name)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** `tools.agent.spawn(`, in every spelling the Code Mode catalog admits. */
const SPAWN_SITE = /\btools\s*(?:\.\s*agent|\[\s*["']agent["']\s*\])\s*(?:\.\s*spawn|\[\s*["']spawn["']\s*\])\s*\(/g
const COMBINATOR = /\bPromise\s*\.\s*(?:all|allSettled|any|race)\s*\(/g
const ITERATOR = /\.\s*(?:map|flatMap|forEach)\s*\(/g
const LOOP = /\b(?:for|while)\s*\(/g

interface Span {
  readonly start: number
  readonly end: number
  /** True when `start` follows a receiver expression whose length may be readable. */
  readonly receiver: boolean
}

export const digest = (code: string) => "sha256:" + createHash("sha256").update(normalize(code)).digest("hex")

export function analyze(code: string): Plan {
  const text = maskComments(code)
  const structure = maskStrings(text)
  const sites = matchAll(SPAWN_SITE, text).map((match) => match.index + match[0].length - 1)
  const combinators = spans(structure, COMBINATOR, false)
  const multipliers = [...spans(structure, ITERATOR, true), ...loopSpans(structure)]
  const fanout = positive("WORKFLOW_FANOUT", DEFAULT_FANOUT)

  // Every spawn under the same outermost combinator starts together and is one parallel phase;
  // anything else is its own sequential step. Grouping by the outermost span keeps a nested
  // `Promise.all` inside another from splitting one fan-out into two phases.
  const groups = new Map<number, number>()
  const order: number[] = []
  for (const site of sites) {
    const enclosing = combinators.filter((span) => span.start < site && site < span.end)
    const key = enclosing.length === 0 ? site : Math.min(...enclosing.map((span) => span.start))
    const count = multipliers
      .filter((span) => span.start < site && site < span.end)
      .reduce((total, span) => total * iterations(structure, span, fanout), 1)
    if (!groups.has(key)) order.push(key)
    groups.set(key, (groups.get(key) ?? 0) + count)
  }

  const phases = order.map(
    (key, index): Phase => ({
      index: index + 1,
      kind: sites.includes(key) && groups.get(key) === 1 ? "sequential" : "parallel",
      agents: groups.get(key) ?? 0,
    }),
  )
  const agents = phases.reduce((total, phase) => total + phase.agents, 0)
  const tokens = agents * positive("WORKFLOW_AGENT_TOKENS", DEFAULT_TOKENS_PER_AGENT)

  const advisories: string[] = []
  if (agents > AGENT_ADVISORY)
    advisories.push(
      `This run projects ${agents} agents, past the advisory ceiling of ${AGENT_ADVISORY}. It still runs if you approve it.`,
    )
  if (tokens > TOKEN_ADVISORY)
    advisories.push(
      `This run projects ${format(tokens)} tokens, past the advisory ceiling of ${format(TOKEN_ADVISORY)}. It still runs if you approve it.`,
    )

  return { digest: digest(code), phases, agents, tokens, advisories, script: truncate(code) }
}

const format = (value: number) => value.toLocaleString("en-US")

const normalize = (code: string) => code.replaceAll("\r\n", "\n").trim()

const truncate = (code: string) =>
  code.length <= SCRIPT_LIMIT
    ? code
    : `${code.slice(0, SCRIPT_LIMIT)}\n... (${code.length - SCRIPT_LIMIT} more characters)`

function matchAll(pattern: RegExp, code: string) {
  return Array.from(code.matchAll(new RegExp(pattern.source, pattern.flags)))
}

/** One span per match, from the trailing `(` to the paren that closes it. */
function spans(structure: string, pattern: RegExp, receiver: boolean): Span[] {
  return matchAll(pattern, structure).map((match) => {
    const start = match.index + match[0].length - 1
    return { start, end: closing(structure, start), receiver }
  })
}

/** `for`/`while` headers plus their block body, so a spawn in the body is seen as repeated. */
function loopSpans(structure: string): Span[] {
  return matchAll(LOOP, structure).flatMap((match) => {
    const header = match.index + match[0].length - 1
    const afterHeader = closing(structure, header)
    const body = structure.indexOf("{", afterHeader)
    if (body === -1 || structure.slice(afterHeader + 1, body).trim() !== "") return []
    return [{ start: match.index, end: closing(structure, body), receiver: false }]
  })
}

/**
 * How many times a spawn inside `span` runs. A literal array receiver (`[a, b, c].map(...)`) is
 * exact; anything else falls back to the configured fan-out because the length is only known at
 * runtime.
 */
function iterations(structure: string, span: Span, fanout: number): number {
  // A loop header has no receiver in front of it; reading one would pick up an unrelated
  // expression from an earlier statement and under-count the run.
  if (!span.receiver) return fanout
  const before = structure.slice(0, span.start)
  const dot = before.lastIndexOf(".")
  if (dot === -1) return fanout
  const head = before.slice(0, dot).trimEnd()
  if (!head.endsWith("]")) return fanout
  const open = opening(structure, head.length - 1)
  if (open === -1) return fanout
  const inner = structure.slice(open + 1, head.length - 1)
  if (inner.trim() === "") return fanout
  return topLevelCommas(inner) + 1
}

function topLevelCommas(inner: string): number {
  let depth = 0
  let count = 0
  for (const char of inner) {
    if (char === "(" || char === "[" || char === "{") depth++
    else if (char === ")" || char === "]" || char === "}") depth--
    else if (char === "," && depth === 0) count++
  }
  return count
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" }

/** Index of the bracket closing the one at `open`, or the end of the script when unbalanced. */
function closing(structure: string, open: number): number {
  const stack: string[] = []
  for (let index = open; index < structure.length; index++) {
    const char = structure[index]!
    const closer = CLOSERS[char]
    if (closer !== undefined) {
      stack.push(closer)
      continue
    }
    if (char !== ")" && char !== "]" && char !== "}") continue
    if (stack.pop() !== char) return structure.length
    if (stack.length === 0) return index
  }
  return structure.length
}

/** Mirror of `closing`, scanning backwards from a closing bracket. */
function opening(structure: string, close: number): number {
  const stack: string[] = []
  for (let index = close; index >= 0; index--) {
    const char = structure[index]!
    if (char === ")" || char === "]" || char === "}") {
      stack.push(char)
      continue
    }
    const closer = CLOSERS[char]
    if (closer === undefined) continue
    if (stack.pop() !== closer) return -1
    if (stack.length === 0) return index
  }
  return -1
}

/**
 * Blanks comment bodies, preserving length so every index still points at the original script.
 * Strings survive: a spawn named inside one is counted, which over-estimates rather than under.
 */
function maskComments(code: string): string {
  const out = code.split("")
  let index = 0
  while (index < code.length) {
    const pair = code.slice(index, index + 2)
    if (pair === "//") {
      const newline = code.indexOf("\n", index)
      index = blank(out, index, newline === -1 ? code.length : newline)
      continue
    }
    if (pair === "/*") {
      const end = code.indexOf("*/", index + 2)
      index = blank(out, index, end === -1 ? code.length : end + 2)
      continue
    }
    index = skipLiteral(code, index)
  }
  return out.join("")
}

/** Same, for string and template bodies, so bracket matching never trips over quoted punctuation. */
function maskStrings(code: string): string {
  const out = code.split("")
  let index = 0
  while (index < code.length) {
    const next = skipLiteral(code, index)
    if (next > index + 1) blank(out, index, next)
    index = next > index ? next : index + 1
  }
  return out.join("")
}

/** Past a quoted literal when one starts at `index`, otherwise one character on. */
function skipLiteral(code: string, index: number): number {
  const quote = code[index]
  if (quote !== '"' && quote !== "'" && quote !== "`") return index + 1
  let cursor = index + 1
  while (cursor < code.length) {
    if (code[cursor] === "\\") {
      cursor += 2
      continue
    }
    if (code[cursor] === quote) return cursor + 1
    cursor++
  }
  return code.length
}

function blank(out: string[], from: number, to: number): number {
  for (let index = from; index < to; index++) if (out[index] !== "\n") out[index] = " "
  return to
}
