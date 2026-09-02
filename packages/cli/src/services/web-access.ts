export * as WebAccess from "./web-access"

import { BindPolicy } from "@opencode-ai/server/bind-policy"
import { ServerInfo } from "@opencode-ai/server/server-info"
import { EOL } from "node:os"

/**
 * force-agent overlay: what `web` prints once the listener is up.
 *
 * `serve` prints a listen line for an operator who is about to point a client at it. `web`
 * is aimed at a person opening a browser, and the embedded UI sits behind the same Basic
 * credential as `/api` (see `packages/server/test/web-ui-auth.test.ts`) — so a URL alone is
 * not usable. Everything a browser needs is printed together, and nothing is printed that a
 * reader could mistake for "no credential required".
 */
export interface Access {
  /** The address the listener actually bound, as `HttpServer.formatAddress` renders it. */
  readonly address: string
  /** The hostname the operator asked for, before the socket resolved it. */
  readonly hostname: string
  readonly username: string
  readonly password: string
  /** False when the password was minted at startup instead of supplied by the operator. */
  readonly configured: boolean
  /**
   * Whether the credential itself goes to stdout. False when stdout is not a terminal
   * (a log, the journal, a pipe) unless the operator asked with `--show-credentials`.
   */
  readonly reveal: boolean
  /** True when this process took over the password of the one a self-update replaced. */
  readonly restarted?: boolean
}

/**
 * Every URL a browser can reach this listener on. A wildcard bind resolves to the routable
 * addresses of this machine plus loopback, because `0.0.0.0` is not something you can type
 * into a browser.
 */
export function urls(address: string, hostname: string): ReadonlyArray<string> {
  if (BindPolicy.scope(hostname) !== "wildcard") return [address]
  const loopback = new URL(address)
  loopback.hostname = loopback.hostname.includes(":") ? "[::1]" : "127.0.0.1"
  return [...new Set([loopback.toString().replace(/\/$/, ""), ...ServerInfo.connectionURLs(address, hostname)])]
}

export function render(access: Access): string {
  const reachable = urls(access.address, access.hostname)
  const lines = [
    "",
    `  Web UI    ${reachable[0]}`,
    ...reachable.slice(1).map((url) => `            ${url}`),
    "",
    `  Username  ${access.username}`,
  ]
  if (access.reveal)
    lines.push(
      `  Password  ${access.password}`,
      "",
      "  The browser prompts for these (HTTP Basic). A client that cannot show a prompt",
      `  can append ?auth_token=${token(access)} to the URL instead.`,
    )
  else lines.push(`  Password  ${hidden(access)}`, "", "  The browser prompts for these (HTTP Basic).")
  if (access.restarted) lines.push("", "  Restarted after update — password kept.")
  if (!access.configured)
    lines.push(
      "",
      "  This password was generated for this run and changes on restart.",
      "  Set LABHARNESS_PASSWORD to pin one you control.",
    )
  if (BindPolicy.scope(access.hostname) !== "loopback")
    lines.push(
      "",
      "  This listener is reachable from the network and speaks plain HTTP: the",
      "  credential crosses the wire in the clear. Put it behind TLS before exposing it",
      "  beyond a network you trust.",
    )
  lines.push("")
  return lines.join(EOL) + EOL
}

function token(access: Access) {
  return Buffer.from(`${access.username}:${access.password}`).toString("base64")
}

/** Replaces the password when it must not reach a non-terminal stdout; also used by `serve`. */
export function hidden(access: Pick<Access, "configured">, command = "web") {
  return access.configured
    ? `(not printed: stdout is not a terminal; it is the LABHARNESS_PASSWORD value, or run \`${command} --show-credentials\` in a terminal)`
    : `(not printed: stdout is not a terminal; set LABHARNESS_PASSWORD, or run \`${command} --show-credentials\` in a terminal)`
}
