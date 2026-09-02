import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"
import { isDeterministic, setDeterministic } from "../src/stdlib/date.js"

const run = (code: string) => Effect.runPromise(CodeMode.execute({ code, tools: {} }))

afterEach(() => {
  setDeterministic(false)
})

// Every spelling that reaches the host clock. Blocking a subset is worse than blocking none: the
// model just rewrites `Date.now()` as `+new Date()` and the run silently stops being replayable.
const hostClockReads = [
  ["Date.now()", "return Date.now()"],
  ["+new Date()", "return +new Date()"],
  ["new Date().getTime()", "return new Date().getTime()"],
  ["new Date().toISOString()", "return new Date().toISOString()"],
  ["Date()", "return String(Date())"],
  ["new Date() via valueOf", "return new Date().valueOf()"],
  ["new Date() through a coercion", "return `${new Date()}`"],
] as const

// Pure of their arguments, so a replay reproduces them exactly. These must keep working in both
// modes, otherwise deterministic mode has no usable way to talk about time at all.
const pureTimeExpressions = [
  ["Date.parse", `return Date.parse("2020-01-01T00:00:00.000Z")`, 1577836800000],
  ["Date.UTC", "return Date.UTC(2020, 0, 1)", 1577836800000],
  ["new Date(<timestamp>)", "return new Date(1234567890).getTime()", 1234567890],
  ["new Date(<string>)", `return new Date("2020-01-01T00:00:00.000Z").getTime()`, 1577836800000],
  ["new Date(<parts>)", "return new Date(Date.UTC(2020, 0, 1)).toISOString()", "2020-01-01T00:00:00.000Z"],
] as const

describe("deterministic clock", () => {
  test("is off by default", async () => {
    expect(isDeterministic()).toBe(false)
    const result = await run("return typeof Date.now()")
    expect(result.ok && result.value).toBe("number")
  })

  describe("with the flag off, every clock read still works", () => {
    for (const [name, code] of hostClockReads) {
      test(name, async () => {
        const result = await run(code)
        expect(result.ok).toBe(true)
      })
    }
  })

  describe("with the flag on, every clock read is refused", () => {
    for (const [name, code] of hostClockReads) {
      test(name, async () => {
        setDeterministic(true)
        const result = await run(code)
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error.message).toContain("is not available in deterministic mode")
      })
    }
  })

  test("the refusal names the other spellings, so the model does not just rewrite the call", async () => {
    setDeterministic(true)
    const result = await run("return Date.now()")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("Date.now()")
    expect(result.error.message).toContain("new Date()")
    expect(result.error.message).toContain("Date()")
  })

  test("two runs of the same program can no longer disagree, because neither run produces a value", async () => {
    setDeterministic(true)
    const a = await run("return new Date().toISOString()")
    const b = await run("return new Date().toISOString()")
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
  })

  describe("argument-pure time stays available in both modes", () => {
    for (const [name, code, expected] of pureTimeExpressions) {
      test(`${name} with the flag off`, async () => {
        const result = await run(code)
        expect(result.ok && result.value).toEqual(expected)
      })
      test(`${name} with the flag on`, async () => {
        setDeterministic(true)
        const result = await run(code)
        expect(result.ok && result.value).toEqual(expected)
      })
    }
  })

  test("a date built from an explicit timestamp still answers its getters under the flag", async () => {
    setDeterministic(true)
    const result = await run(`
      const d = new Date(1577836800000)
      d.setUTCFullYear(2021)
      return [d.getUTCFullYear(), d.toISOString()]
    `)
    expect(result.ok && result.value).toEqual([2021, "2021-01-01T00:00:00.000Z"])
  })

  test("refuses Math.random() when enabled, and serves it when not", async () => {
    const off = await run("return typeof Math.random()")
    expect(off.ok && off.value).toBe("number")
    setDeterministic(true)
    const on = await run("return Math.random()")
    expect(on.ok).toBe(false)
    if (on.ok) return
    expect(on.error.message).toContain("Math.random() is not available in deterministic mode")
  })
})
