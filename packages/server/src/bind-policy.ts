export * as BindPolicy from "./bind-policy"

import { Env } from "@opencode-ai/util/env"
import { Data, Effect } from "effect"
import { ServerAuth } from "./auth"

/**
 * Which listener a hostname produces.
 *
 * - `loopback`  — reachable only from this machine.
 * - `wildcard`  — every interface, including whatever the machine is routable on.
 * - `routable`  — a specific non-loopback address or name.
 */
export type Scope = "loopback" | "wildcard" | "routable"

/**
 * Where the server's credential came from.
 *
 * - `configured` — the operator supplied it (env var, service config) and it is
 *   long enough to be worth something: it can be handed to a client, so a
 *   reachable listener is usable and closed.
 * - `weak`       — the operator supplied it, but it is shorter than
 *   `minimumSecretLength`. Still the real password, still enforced by Basic
 *   auth; just not an access control story for an interface the whole network
 *   can reach. See `classify`.
 * - `ephemeral`  — minted at startup and printed/registered locally. Fine for a
 *   loopback listener, useless as an access control story for a reachable one.
 * - `none`       — the listener would accept unauthenticated requests.
 */
export type Credential = "configured" | "weak" | "ephemeral" | "none"

/**
 * Shortest secret that may stand alone as the access control for a listener the
 * network can reach.
 *
 * 8 is NIST SP 800-63B's floor for a user-chosen secret, and Basic auth over a
 * server that runs arbitrary code on the operator's machine is the case that
 * floor exists for. The rule is scoped to reachable binds on purpose: a short
 * password on loopback still boots, still authenticates, and still works
 * exactly as it did — so no existing local deployment breaks on an upgrade.
 */
export const minimumSecretLength = 8

/**
 * Classify a secret the caller resolved from the environment or service config.
 *
 * `undefined` — including a value that was only whitespace — means the caller
 * has nothing an operator configured and will mint its own, hence `ephemeral`.
 * A caller that will serve with no credential at all passes `"none"` itself.
 */
export function classify(secret: string | undefined | null): Credential {
  if (!ServerAuth.usable(secret)) return "ephemeral"
  return secret.trim().length >= minimumSecretLength ? "configured" : "weak"
}

/**
 * The one escape hatch, and it only ever applies to a loopback listener. It
 * cannot unlock a wildcard or routable bind: those are refused without a
 * configured credential no matter what the environment says.
 */
export const escapeVariable = "ALLOW_UNAUTHENTICATED_LOOPBACK"

export class RefusedError extends Data.TaggedError("BindPolicy.RefusedError")<{
  readonly hostname: string
  readonly scope: Scope
  readonly credential: Credential
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

export interface Input {
  readonly hostname: string | undefined
  readonly credential: Credential
  /** Defaults to reading the escape variable from the environment. */
  readonly allowUnauthenticatedLoopback?: boolean
}

export function scope(hostname: string | undefined): Scope {
  const host = normalize(hostname)
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "0") return "wildcard"
  if (host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1") return "loopback"
  if (host.endsWith(".localhost")) return "loopback"
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return "loopback"
  return "routable"
}

/**
 * Refuses — never warns — a listener that would be reachable from off this
 * machine without a credential an operator actually configured.
 *
 * This narrows who can reach the API. It says nothing about what the agent may
 * do once someone is through it.
 */
export function check(input: Input): RefusedError | undefined {
  const hostname = input.hostname ?? ""
  const target = scope(hostname)
  if (target === "loopback") {
    if (input.credential !== "none") return undefined
    const escape = input.allowUnauthenticatedLoopback ?? Env.truthy(escapeVariable)
    if (escape) return undefined
    return new RefusedError({
      hostname,
      scope: target,
      credential: input.credential,
      reason:
        `Refusing to serve ${describe(hostname, target)} with no credential. ` +
        `Configure LABHARNESS_PASSWORD, or set LABHARNESS_${escapeVariable}=1 to accept an unauthenticated loopback listener.`,
    })
  }
  if (input.credential === "configured") return undefined
  return new RefusedError({
    hostname,
    scope: target,
    credential: input.credential,
    reason:
      `Refusing to bind ${describe(hostname, target)} with ${reasonFor(input.credential)}. ` +
      `Set LABHARNESS_PASSWORD to a value you control, at least ${minimumSecretLength} characters, before binding a ` +
      `reachable interface, or bind 127.0.0.1 instead. ` +
      `LABHARNESS_${escapeVariable} does not apply to a non-loopback bind.`,
  })
}

/** `check`, as an Effect that fails rather than returning the refusal. */
export const assert = (input: Input): Effect.Effect<void, RefusedError> => {
  const refusal = check(input)
  return refusal ? Effect.fail(refusal) : Effect.void
}

function reasonFor(credential: Credential) {
  if (credential === "none") return "no credential"
  if (credential === "weak") return `a credential shorter than ${minimumSecretLength} characters`
  return "a credential generated at startup"
}

function describe(hostname: string, target: Scope) {
  if (target === "wildcard") return `every interface (${hostname === "" ? "0.0.0.0" : hostname})`
  return hostname
}

function normalize(hostname: string | undefined) {
  const host = (hostname ?? "").trim().toLowerCase()
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}
