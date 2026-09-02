import { read, utils, type WorkBook } from "xlsx"
import type { CsvTable } from "./csv"

export const XLSX_MAX_BYTES = 1_048_576

export type XlsxWorkbook = WorkBook

export function isXlsxPath(path: string | undefined): boolean {
  if (!path) return false
  return path.toLowerCase().endsWith(".xlsx")
}

// Content arrives base64-encoded from createFileContent; decoded byte size = floor(len/4)*3 - padding.
export function isXlsxTooLarge(base64: string): boolean {
  let padding = 0
  if (base64.endsWith("==")) padding = 2
  else if (base64.endsWith("=")) padding = 1
  return Math.floor(base64.length / 4) * 3 - padding > XLSX_MAX_BYTES
}

export function readXlsx(base64: string): XlsxWorkbook {
  return read(base64ToBytes(base64))
}

export function sheetToTable(workbook: XlsxWorkbook, name: string): CsvTable {
  const sheet = workbook.Sheets[name]
  if (!sheet) return { headers: [], rows: [] }

  const grid = utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" })
  const data = grid.map((row) => row.map((cell) => (cell == null ? "" : String(cell)))).filter((row) => row.some((cell) => cell !== ""))

  if (data.length === 0) return { headers: [], rows: [] }

  const headers = data[0] ?? []
  const width = headers.length
  const rows = data.slice(1).map((row) => {
    if (row.length === width) return row
    if (row.length < width) return [...row, ...Array(width - row.length).fill("")]
    return row.slice(0, width)
  })

  return { headers, rows }
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return new Uint8Array(Buffer.from(value, "base64"))
  }
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
