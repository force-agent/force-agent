import { ServerAuth } from "@opencode-ai/server/auth"
import { Config, Effect, Redacted } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// force-agent overlay: the branded FORCE_AGENT_* spellings win, then every earlier
// brand in order — LABHARNESS_*, LABFY_*, POWER_* — then the upstream OPENCODE_*
// spellings. Dropping any fallback would silently discard a deployed password
// and boot the server without auth. The array order IS the precedence.
export const passwordKeys = [
  "FORCE_AGENT_PASSWORD",
  "FORCE_AGENT_SERVER_PASSWORD",
  "LABHARNESS_PASSWORD",
  "LABHARNESS_SERVER_PASSWORD",
  "LABFY_PASSWORD",
  "LABFY_SERVER_PASSWORD",
  "POWER_PASSWORD",
  "POWER_SERVER_PASSWORD",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
] as const

// The server password: sent by clients connecting to an explicit --server, and
// adopted by a manually run or standalone server. Folded rather than chained by
// hand: the list grows by two entries on every rebrand, and a chain that has to
// be extended in lockstep is how a spelling silently stops being read.
export const password = passwordKeys
  .slice(1)
  .reduce(
    (chain, key) => chain.pipe(Config.orElse(() => Config.redacted(key))),
    Config.redacted(passwordKeys[0]) as Config.Config<Redacted.Redacted<string>>,
  )
  .pipe(Config.withDefault(undefined))

/**
 * The password an operator actually configured, or `undefined`.
 *
 * `password` above resolves the first spelling that is *set*; this one answers
 * the question every caller really asks — is there a credential here worth
 * treating as one. A value that is empty or only whitespace answers no, so it
 * can never be mistaken for proof that a reachable bind is protected. The
 * string is returned untrimmed: whatever authenticates has to stay byte-equal
 * to what the operator exported.
 */
export const configuredPassword = password.pipe(
  Effect.map((value) => {
    const secret = value === undefined ? undefined : Redacted.value(value)
    return ServerAuth.usable(secret) ? secret : undefined
  }),
)

export function session() {
  const secret: ReadonlyArray<string> = passwordKeys
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !secret.includes(entry[0]),
    ),
  )
}

export * as Env from "./env"
