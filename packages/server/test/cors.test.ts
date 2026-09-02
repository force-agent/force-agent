import { afterEach, describe, expect, test } from "bun:test"
import { isAllowedCorsOrigin, isAllowedRequestOrigin } from "../src/cors"

afterEach(() => {
  delete process.env["POWER_DEV_CORS"]
})

// The origin list is what gates PTY connect-ticket issue, which is exempt from
// Basic auth because a browser cannot set headers on a WebSocket upgrade.
describe("isAllowedCorsOrigin", () => {
  test("refuses the origins upstream granted unconditionally", () => {
    for (const origin of [
      "https://opencode.ai",
      "https://app.opencode.ai",
      "https://console.dev.opencode.ai",
      "oc://renderer",
      "oc://renderer/index.html",
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "https://evil.example",
    ]) {
      expect(isAllowedCorsOrigin(origin)).toBe(false)
    }
  })

  test("allows what the operator configured", () => {
    const opts = { cors: ["https://console.internal"] }
    expect(isAllowedCorsOrigin("https://console.internal", opts)).toBe(true)
    expect(isAllowedCorsOrigin("https://other.internal", opts)).toBe(false)
  })

  test("allows localhost only behind the development flag", () => {
    process.env["POWER_DEV_CORS"] = "1"
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true)
    expect(isAllowedCorsOrigin("http://127.0.0.1:5173")).toBe(true)
    expect(isAllowedCorsOrigin("https://localhost:5173")).toBe(true)
    // The flag widens localhost, nothing else.
    expect(isAllowedCorsOrigin("https://opencode.ai")).toBe(false)
    expect(isAllowedCorsOrigin("oc://renderer")).toBe(false)
    expect(isAllowedCorsOrigin("http://localhost.evil.example")).toBe(false)
  })

  test("a missing origin is not a cross-origin request", () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true)
  })
})

describe("isAllowedRequestOrigin", () => {
  test("keeps same-origin requests working without any allowlist", () => {
    expect(isAllowedRequestOrigin("http://127.0.0.1:4096", "127.0.0.1:4096")).toBe(true)
    expect(isAllowedRequestOrigin("http://127.0.0.1:4096", "127.0.0.1:4097")).toBe(false)
    expect(isAllowedRequestOrigin("https://opencode.ai", "127.0.0.1:4096")).toBe(false)
  })
})
