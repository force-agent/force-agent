export * as InProcess from "./in-process"

declare const grantBrand: unique symbol

/**
 * Nominal witness that a route graph is being built for a caller that owns the
 * handler directly — the SDK host, a Durable Object test harness, a unit test —
 * rather than for a listener that accepts requests off a socket.
 *
 * The witness is not a boolean and not a `ServerOptions` field: it cannot be
 * produced by decoding user input, by forgetting to set a password, or by
 * threading options through from a CLI flag. A caller has to import this module
 * and mint one, which is the point.
 *
 * Minting also produces the credential the route graph is configured with, so
 * the in-process path is authenticated like every other path instead of being a
 * second, unauthenticated construction of the same routes. The owner stamps
 * {@link authorization} onto the requests it hands to the handler.
 */
export interface Grant {
  readonly [grantBrand]: "@opencode/InProcessGrant"
  readonly password: string
}

export const username = "opencode"

export function grant(): Grant {
  return { password: secret() } as Grant
}

export function authorization(input: Grant) {
  return `Basic ${btoa(`${username}:${input.password}`)}`
}

/** Returns the request with the grant's credential stamped on it. */
export function authorize(request: Request, input: Grant) {
  const headers = new Headers(request.headers)
  headers.set("authorization", authorization(input))
  return new Request(request, { headers })
}

function secret() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
