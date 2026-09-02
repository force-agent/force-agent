import { describe, expect, test } from "bun:test"
import { CSV_MAX_BYTES, isCsvTooLarge, parseCsv } from "./csv"

describe("parseCsv", () => {
  test("handles quotes", () => {
    const text = `a,b\n"hello, world",2\n"a ""quoted""",3`
    const { headers, rows } = parseCsv(text)
    expect(headers).toEqual(["a", "b"])
    expect(rows[0]).toEqual(["hello, world", "2"])
    expect(rows[1]).toEqual(['a "quoted"', "3"])
  })

  test("handles semicolon delimiter", () => {
    const text = "name;age\nJohn;30\nAlice;25"
    const { headers, rows } = parseCsv(text)
    expect(headers).toEqual(["name", "age"])
    expect(rows).toEqual([
      ["John", "30"],
      ["Alice", "25"],
    ])
  })

  test("handles BOM", () => {
    const text = "\ufeffname,age\nJohn,30"
    const { headers, rows } = parseCsv(text)
    expect(headers).toEqual(["name", "age"])
    expect(rows).toEqual([["John", "30"]])
  })

  test("handles CRLF", () => {
    const text = "a,b\r\n1,2\r\n3,4\r\n"
    const { headers, rows } = parseCsv(text)
    expect(headers).toEqual(["a", "b"])
    expect(rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ])
  })

  test("handles missing field", () => {
    const text = "a,b,c\n1,2\n3,4,5"
    const { headers, rows } = parseCsv(text)
    expect(headers).toEqual(["a", "b", "c"])
    expect(rows[0]).toEqual(["1", "2", ""])
    expect(rows[1]).toEqual(["3", "4", "5"])
  })

  test("handles quoted field with semicolon", () => {
    const text = `name;value\n"Doe; John";30`
    const { headers, rows } = parseCsv(text)
    expect(headers).toEqual(["name", "value"])
    expect(rows[0]).toEqual(["Doe; John", "30"])
  })

  test("returns empty for blank input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] })
    expect(parseCsv("   \n  ")).toEqual({ headers: [], rows: [] })
  })
})

describe("isCsvTooLarge", () => {
  test("false under limit", () => {
    expect(isCsvTooLarge("a,b\n1,2")).toBe(false)
  })

  test("true over limit", () => {
    const big = "a".repeat(CSV_MAX_BYTES + 1)
    expect(isCsvTooLarge(big)).toBe(true)
  })

  test("false at limit", () => {
    const atLimit = "a".repeat(CSV_MAX_BYTES)
    expect(isCsvTooLarge(atLimit)).toBe(false)
  })
})
