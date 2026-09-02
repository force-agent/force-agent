export * as ServerAuth from "./auth"

import { Context, Layer, Option, Redacted } from "effect"

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  // power-agent overlay: the `layer` static that defaulted to `Option.none()`
  // is gone. An unauthenticated config is no longer something a caller can fall
  // into; routes are built from a password or not at all (see ./routes.ts).
  static configLayer(input: Pick<Info, "password">) {
    return Layer.succeed(this, this.of({ ...input, username: "opencode" }))
  }
}

/**
 * power-agent overlay: whether a supplied secret is a credential at all.
 *
 * A value that is empty or only whitespace is not one. Before this check a
 * `POWER_PASSWORD="   "` counted as an operator-configured credential
 * everywhere it mattered — Basic auth "protected" the server with a space, and
 * `BindPolicy` read it as proof that a `--hostname 0.0.0.0` bind was safe. The
 * shell makes that mistake easy (`POWER_PASSWORD=" "`, a trailing backslash, a
 * heredoc that kept a newline), and nothing downstream could tell the operator.
 *
 * It does NOT trim the secret it accepts: the value that authenticates has to
 * stay byte-identical to what the operator exported, or every client that
 * already holds it stops working.
 */
export function usable(secret: string | undefined | null): secret is string {
  return typeof secret === "string" && secret.trim() !== ""
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}
