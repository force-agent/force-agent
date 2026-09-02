import { describe, expect, test } from "bun:test"
import { reconnectBackoff } from "../src/solid/connection"

describe("reconnectBackoff", () => {
  test("doubles from 1s and caps at 30s", () => {
    const fixed = () => 0.5
    expect(reconnectBackoff(1, fixed)).toBe(1000)
    expect(reconnectBackoff(2, fixed)).toBe(2000)
    expect(reconnectBackoff(4, fixed)).toBe(8000)
    expect(reconnectBackoff(10, fixed)).toBe(30000)
    expect(reconnectBackoff(100, fixed)).toBe(30000)
  })

  test("jitters within ±25%", () => {
    expect(reconnectBackoff(3, () => 0)).toBe(3000)
    expect(reconnectBackoff(3, () => 1)).toBe(5000)
  })
})

import { httpStatusOf, isAuthError } from "../src/solid/connection"
import { ClientError } from "../src/promise/generated/client-error"

describe("isAuthError", () => {
  test("reads the status a rejected credential leaves on the error", () => {
    expect(isAuthError(new ClientError("UnexpectedStatus", { cause: { status: 401 } }))).toBe(true)
    expect(isAuthError(new ClientError("UnexpectedStatus", { cause: { status: 403 } }))).toBe(true)
    expect(isAuthError(new ClientError("UnexpectedStatus", { cause: { status: 500 } }))).toBe(false)
    expect(isAuthError(new ClientError("Transport"))).toBe(false)
  })

  test("accepts a declared error body that carries the status or the tag", () => {
    expect(isAuthError({ status: 401 })).toBe(true)
    expect(isAuthError({ _tag: "UnauthorizedError" })).toBe(true)
    expect(isAuthError({ _tag: "NotFoundError" })).toBe(false)
    expect(isAuthError(undefined)).toBe(false)
    expect(isAuthError("nope")).toBe(false)
  })

  test("httpStatusOf digs one level into cause", () => {
    expect(httpStatusOf({ cause: { status: 404 } })).toBe(404)
    expect(httpStatusOf({ status: 429 })).toBe(429)
    expect(httpStatusOf({})).toBeUndefined()
  })
})

import { reconnectPolicy } from "../src/solid/connection"

describe("reconnectPolicy", () => {
  const fixed = () => 0.5
  test("retries with backoff while the failures are not about credentials", () => {
    expect(reconnectPolicy({ authFailures: 0, attempt: 1 }, fixed)).toEqual({ stop: false, delay: 1000 })
    expect(reconnectPolicy({ authFailures: 0, attempt: 5 }, fixed)).toEqual({ stop: false, delay: 16000 })
  })

  test("tolerates two rejected credentials, stops at the third", () => {
    expect(reconnectPolicy({ authFailures: 1, attempt: 1 }, fixed).stop).toBe(false)
    expect(reconnectPolicy({ authFailures: 2, attempt: 2 }, fixed).stop).toBe(false)
    expect(reconnectPolicy({ authFailures: 3, attempt: 3 }, fixed)).toEqual({ stop: true })
    expect(reconnectPolicy({ authFailures: 99, attempt: 99 }, fixed)).toEqual({ stop: true })
  })
})
