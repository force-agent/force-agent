import { Context } from "effect"
import { Env } from "@opencode-ai/util/env"

// power-agent overlay: upstream grants CORS to `*.opencode.ai`, `oc://renderer`
// and three tauri origins, plus localhost unconditionally. Those grants are what
// lets a page the operator never chose talk to the API — including the endpoints
// that mint PTY connect tickets, which are exempt from Basic auth because a
// browser cannot set headers on a WebSocket upgrade. The ticket issue path is
// gated by origin, so the origin list is the gate. It now contains only what the
// operator configured, plus localhost when a development flag is set.

const DEV_ORIGINS_VARIABLE = "DEV_CORS"

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (developmentOrigins() && isLocalhostOrigin(input)) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function isLocalhostOrigin(input: string) {
  try {
    const url = new URL(input)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  } catch {
    return false
  }
}

function developmentOrigins() {
  try {
    // Resolves all branded spellings (LABHARNESS_/LABFY_/POWER_/OPENCODE_); the
    // previous hand-rolled read only knew POWER_/OPENCODE_ and silently ignored
    // the current prefix.
    return Env.truthy(DEV_ORIGINS_VARIABLE)
  } catch {
    return false
  }
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
