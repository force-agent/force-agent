import type { PDFDocumentProxy } from "pdfjs-dist"

export const PDF_MAX_BYTES = 1_048_576

export type PdfDocument = PDFDocumentProxy

// Set from the browser layer so Bun tests can run pdf.js without the Vite worker asset.
let workerUrl: string | undefined

export function isPdfPath(path: string | undefined): boolean {
  if (!path) return false
  return path.toLowerCase().endsWith(".pdf")
}

// Content arrives base64-encoded from createFileContent; decoded byte size = floor(len/4)*3 - padding.
export function isPdfTooLarge(base64: string): boolean {
  let padding = 0
  if (base64.endsWith("==")) padding = 2
  else if (base64.endsWith("=")) padding = 1
  return Math.floor(base64.length / 4) * 3 - padding > PDF_MAX_BYTES
}

export function configurePdfWorker(url: string) {
  workerUrl = url
}

export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await import("pdfjs-dist")
  if (workerUrl) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  return pdfjs.getDocument({ data: bytes }).promise
}

export async function renderPdfPage(input: {
  doc: PdfDocument
  page: number
  canvas: HTMLCanvasElement
  fitWidth: number
}) {
  const page = await input.doc.getPage(input.page)
  const natural = page.getViewport({ scale: 1 })
  const scale = input.fitWidth > 0 ? Math.min(2, input.fitWidth / natural.width) : 1
  const viewport = page.getViewport({ scale })
  input.canvas.width = Math.floor(viewport.width)
  input.canvas.height = Math.floor(viewport.height)
  const context = input.canvas.getContext("2d")
  if (!context) return
  await page.render({ canvas: input.canvas, canvasContext: context, viewport }).promise
}

export function pdfBytes(base64: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(
    typeof Buffer !== "undefined" && typeof Buffer.from === "function"
      ? Buffer.from(base64, "base64")
      : (() => {
          const binary = atob(base64)
          const decoded = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i)
          return decoded
        })(),
  )
  return bytes
}
