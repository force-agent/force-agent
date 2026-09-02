import { describe, expect, test } from "bun:test"
import { utils, write, type WorkBook } from "xlsx"
import { XLSX_MAX_BYTES, isXlsxPath, isXlsxTooLarge, readXlsx, sheetToTable } from "./xlsx"

function buildWorkbook(): WorkBook {
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([["name", "age"], ["John", 30], ["Alice", 25]]), "People")
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([["city", "country"], ["Oslo", "Norway"]]), "Places")
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([["solo"]]), "Empty-ish")
  return workbook
}

function toBase64(workbook: WorkBook): string {
  const buffer = write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer
  return buffer.toString("base64")
}

describe("isXlsxPath", () => {
  test("matches xlsx extension", () => {
    expect(isXlsxPath("data/book.XLSX")).toBe(true)
    expect(isXlsxPath("data/book.csv")).toBe(false)
    expect(isXlsxPath(undefined)).toBe(false)
  })
})

describe("readXlsx", () => {
  test("reads sheet names from a mocked workbook", () => {
    const workbook = readXlsx(toBase64(buildWorkbook()))
    expect(workbook.SheetNames).toEqual(["People", "Places", "Empty-ish"])
  })
})

describe("sheetToTable", () => {
  test("extracts headers and rows", () => {
    const workbook = readXlsx(toBase64(buildWorkbook()))
    expect(sheetToTable(workbook, "People")).toEqual({
      headers: ["name", "age"],
      rows: [
        ["John", "30"],
        ["Alice", "25"],
      ],
    })
  })

  test("switching sheets renders the active sheet", () => {
    const workbook = readXlsx(toBase64(buildWorkbook()))
    expect(sheetToTable(workbook, "Places")).toEqual({
      headers: ["city", "country"],
      rows: [["Oslo", "Norway"]],
    })
    expect(sheetToTable(workbook, "Empty-ish")).toEqual({ headers: ["solo"], rows: [] })
  })

  test("returns empty for unknown sheet", () => {
    const workbook = readXlsx(toBase64(buildWorkbook()))
    expect(sheetToTable(workbook, "Missing")).toEqual({ headers: [], rows: [] })
  })
})

describe("isXlsxTooLarge", () => {
  test("false under limit", () => {
    const workbook = readXlsx(toBase64(buildWorkbook()))
    expect(isXlsxTooLarge(toBase64(workbook))).toBe(false)
  })

  test("true over limit", () => {
    const big = Buffer.from("a".repeat(XLSX_MAX_BYTES + 8)).toString("base64")
    expect(isXlsxTooLarge(big)).toBe(true)
  })

  test("false at limit", () => {
    const atLimit = Buffer.alloc(XLSX_MAX_BYTES, 97).toString("base64")
    expect(isXlsxTooLarge(atLimit)).toBe(false)
  })
})
