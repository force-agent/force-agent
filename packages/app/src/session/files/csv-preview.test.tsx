import { describe, expect, test } from "bun:test"
import { isCsvTooLarge, parseCsv } from "@/workspaces/files/csv"

describe("CsvPreview spec", () => {
  test("opening csv shows header + first row", () => {
    const csv = "name,age\nJohn,30\nAlice,25"
    const { headers, rows } = parseCsv(csv)
    expect(headers).toEqual(["name", "age"])
    expect(rows[0]).toEqual(["John", "30"])
  })

  test("offers download when too large", () => {
    const big = "a".repeat(1_048_577)
    expect(isCsvTooLarge(big)).toBe(true)
    expect(isCsvTooLarge("a,b\n1,2")).toBe(false)
  })
})
