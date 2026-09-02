import { afterEach, describe, expect, test } from "bun:test"
import { BindPolicy } from "../src/bind-policy"

const escape = `POWER_${BindPolicy.escapeVariable}`

afterEach(() => {
  delete process.env[escape]
})

describe("BindPolicy.scope", () => {
  test("classifies the hostnames a listener can be handed", () => {
    expect(BindPolicy.scope("127.0.0.1")).toBe("loopback")
    expect(BindPolicy.scope("127.1.2.3")).toBe("loopback")
    expect(BindPolicy.scope("localhost")).toBe("loopback")
    expect(BindPolicy.scope("::1")).toBe("loopback")
    expect(BindPolicy.scope("[::1]")).toBe("loopback")
    expect(BindPolicy.scope("0.0.0.0")).toBe("wildcard")
    expect(BindPolicy.scope("::")).toBe("wildcard")
    expect(BindPolicy.scope(undefined)).toBe("wildcard")
    expect(BindPolicy.scope("192.168.68.62")).toBe("routable")
    expect(BindPolicy.scope("box.local")).toBe("routable")
  })
})

describe("BindPolicy.classify", () => {
  // Battle-test finding: a password of spaces counted as "configured", so
  // `--hostname 0.0.0.0` was accepted and the server was effectively open.
  test("a secret that is empty or only whitespace is no secret at all", () => {
    for (const secret of ["", " ", "   ", "\t", "\n", " \t\n ", undefined, null]) {
      expect(BindPolicy.classify(secret)).toBe("ephemeral")
    }
  })

  test("a secret shorter than the minimum is weak, not configured", () => {
    expect(BindPolicy.minimumSecretLength).toBe(8)
    expect(BindPolicy.classify("short")).toBe("weak")
    expect(BindPolicy.classify("  short  ")).toBe("weak")
    expect(BindPolicy.classify("1234567")).toBe("weak")
  })

  test("a secret at or above the minimum is configured", () => {
    expect(BindPolicy.classify("12345678")).toBe("configured")
    expect(BindPolicy.classify("  a-real-password  ")).toBe("configured")
  })

  test("a whitespace or weak secret cannot open a reachable bind", () => {
    for (const secret of ["   ", "short"]) {
      const credential = BindPolicy.classify(secret)
      expect(BindPolicy.check({ hostname: "0.0.0.0", credential })).toBeInstanceOf(BindPolicy.RefusedError)
      expect(BindPolicy.check({ hostname: "192.168.68.62", credential })).toBeInstanceOf(BindPolicy.RefusedError)
    }
  })

  test("a weak secret still serves loopback, so an existing local deployment survives", () => {
    expect(BindPolicy.check({ hostname: "127.0.0.1", credential: BindPolicy.classify("short") })).toBeUndefined()
    expect(BindPolicy.check({ hostname: "localhost", credential: BindPolicy.classify("short") })).toBeUndefined()
  })

  test("the refusal names the actual problem", () => {
    const weak = BindPolicy.check({ hostname: "0.0.0.0", credential: BindPolicy.classify("short") })
    expect(weak?.message).toContain("shorter than 8 characters")
    const blank = BindPolicy.check({ hostname: "0.0.0.0", credential: BindPolicy.classify("   ") })
    expect(blank?.message).toContain("generated at startup")
  })
})

describe("BindPolicy.check", () => {
  test("refuses a reachable bind whose credential was generated at startup", () => {
    for (const hostname of ["0.0.0.0", "::", "192.168.68.62", "box.local"]) {
      expect(BindPolicy.check({ hostname, credential: "ephemeral" })).toBeInstanceOf(BindPolicy.RefusedError)
      expect(BindPolicy.check({ hostname, credential: "none" })).toBeInstanceOf(BindPolicy.RefusedError)
      expect(BindPolicy.check({ hostname, credential: "configured" })).toBeUndefined()
    }
  })

  test("the escape variable never unlocks a reachable bind", () => {
    process.env[escape] = "1"
    expect(BindPolicy.check({ hostname: "0.0.0.0", credential: "ephemeral" })).toBeInstanceOf(BindPolicy.RefusedError)
    expect(BindPolicy.check({ hostname: "192.168.68.62", credential: "none" })).toBeInstanceOf(BindPolicy.RefusedError)
    expect(BindPolicy.check({ hostname: "0.0.0.0", credential: "none", allowUnauthenticatedLoopback: true })).toBeInstanceOf(
      BindPolicy.RefusedError,
    )
  })

  test("allows loopback, and only loopback may drop the credential behind the escape", () => {
    expect(BindPolicy.check({ hostname: "127.0.0.1", credential: "ephemeral" })).toBeUndefined()
    expect(BindPolicy.check({ hostname: "127.0.0.1", credential: "configured" })).toBeUndefined()
    expect(BindPolicy.check({ hostname: "127.0.0.1", credential: "none" })).toBeInstanceOf(BindPolicy.RefusedError)
    process.env[escape] = "1"
    expect(BindPolicy.check({ hostname: "127.0.0.1", credential: "none" })).toBeUndefined()
    expect(BindPolicy.check({ hostname: "::1", credential: "none" })).toBeUndefined()
  })
})
