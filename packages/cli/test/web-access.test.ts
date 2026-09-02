import { describe, expect, test } from "bun:test"
import { WebAccess } from "../src/services/web-access"

const base = {
  address: "http://127.0.0.1:4096",
  hostname: "127.0.0.1",
  username: "opencode",
  password: "s3cret",
  configured: true,
  reveal: true,
} satisfies WebAccess.Access

describe("web access announcement", () => {
  test("prints a loopback URL and the credential the UI will demand", () => {
    const output = WebAccess.render(base)
    expect(output).toContain("http://127.0.0.1:4096")
    expect(output).toContain("opencode")
    expect(output).toContain("s3cret")
    // The embedded UI is behind Basic auth; the announcement has to say so or the URL is a dead end.
    expect(output).toContain("HTTP Basic")
    expect(output).toContain(`?auth_token=${Buffer.from("opencode:s3cret").toString("base64")}`)
    // Nothing to warn about: loopback with an operator-supplied password.
    expect(output).not.toContain("changes on restart")
    expect(output).not.toContain("plain HTTP")
  })

  test("keeps the password and auth token out of a stdout that is not a terminal", () => {
    const output = WebAccess.render({ ...base, reveal: false })
    expect(output).toContain("http://127.0.0.1:4096")
    expect(output).toContain("HTTP Basic")
    expect(output).not.toContain("s3cret")
    expect(output).not.toContain("auth_token")
    expect(output).toContain("not printed")
    expect(output).toContain("LABHARNESS_PASSWORD value")
    expect(output).toContain("web --show-credentials")
  })

  test("tells an unconfigured, hidden password how to get one", () => {
    const output = WebAccess.render({ ...base, reveal: false, configured: false })
    expect(output).not.toContain("s3cret")
    expect(output).toContain("set LABHARNESS_PASSWORD")
    expect(WebAccess.hidden({ configured: false }, "serve")).toContain("serve --show-credentials")
  })

  test("says the password was kept across a self-update restart", () => {
    expect(WebAccess.render({ ...base, configured: false, restarted: true })).toContain("password kept")
    expect(WebAccess.render({ ...base, configured: false })).not.toContain("password kept")
  })

  test("says the password is ephemeral when it was not configured", () => {
    expect(WebAccess.render({ ...base, configured: false })).toContain("changes on restart")
  })

  test("warns that a reachable listener carries the credential in the clear", () => {
    const output = WebAccess.render({ ...base, address: "http://0.0.0.0:4096", hostname: "0.0.0.0" })
    expect(output).toContain("plain HTTP")
  })

  test("resolves a wildcard bind to addresses a browser can actually use", () => {
    const urls = WebAccess.urls("http://0.0.0.0:4096", "0.0.0.0")
    expect(urls).toContain("http://127.0.0.1:4096")
    expect(urls).not.toContain("http://0.0.0.0:4096")
    expect(new Set(urls).size).toBe(urls.length)
  })

  test("leaves a specific bind alone", () => {
    expect(WebAccess.urls("http://127.0.0.1:4096", "127.0.0.1")).toEqual(["http://127.0.0.1:4096"])
    expect(WebAccess.urls("http://192.168.1.5:4096", "192.168.1.5")).toEqual(["http://192.168.1.5:4096"])
  })
})
