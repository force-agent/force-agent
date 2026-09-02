import Papa from "papaparse"

export const CSV_MAX_BYTES = 1_048_576

export type CsvTable = {
  headers: string[]
  rows: string[][]
}

export function parseCsv(text: string): CsvTable {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (cleaned.trim() === "") return { headers: [], rows: [] }

  const result = Papa.parse<string[]>(cleaned, {
    delimiter: "",
    skipEmptyLines: true,
  })

  const data = result.data.filter((row: string[]) => row.some((cell: string) => cell !== ""))

  if (data.length === 0) return { headers: [], rows: [] }

  const headers = data[0] ?? []
  const rawRows = data.slice(1)

  const width = headers.length
  const rows = rawRows.map((row: string[]) => {
    if (row.length === width) return row
    if (row.length < width) return [...row, ...Array(width - row.length).fill("")]
    return row.slice(0, width)
  })

  return { headers, rows }
}

export function isCsvPath(path: string | undefined): boolean {
  if (!path) return false
  return path.toLowerCase().endsWith(".csv")
}

export function isCsvTooLarge(content: string): boolean {
  return new TextEncoder().encode(content).length > CSV_MAX_BYTES
}
