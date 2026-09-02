import { describe, expect, test } from "bun:test"
import { PDF_MAX_BYTES, isPdfPath, isPdfTooLarge, openPdf, pdfBytes, renderPdfPage } from "./pdf"

// Minimal valid one-page PDF with the text "Hello PDF".
const HELLO_PDF = `JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2Jq
CjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2Jq
CjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAg
MTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAw
IFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNl
Rm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMzkgPj4Kc3RyZWFt
CkJUIC9GMSAyNCBUZiAyMCA1MCBUZCAoSGVsbG8gUERGKSBUaiBFVAplbmRzdHJlYW0KZW5kb2Jq
CnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAw
MDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAw
MDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhy
ZWYKNDAwCiUlRU9G`
  .replace(/\n/g, "")

describe("isPdfPath", () => {
  test("matches pdf extension", () => {
    expect(isPdfPath("docs/manual.PDF")).toBe(true)
    expect(isPdfPath("docs/manual.pdfx")).toBe(false)
    expect(isPdfPath(undefined)).toBe(false)
  })
})

describe("isPdfTooLarge", () => {
  test("false under limit", () => {
    expect(isPdfTooLarge(HELLO_PDF)).toBe(false)
  })

  test("true over limit", () => {
    const big = Buffer.from("a".repeat(PDF_MAX_BYTES + 8)).toString("base64")
    expect(isPdfTooLarge(big)).toBe(true)
  })
})

describe("openPdf", () => {
  test("loads a minimal PDF and reports page count", async () => {
    const doc = await openPdf(pdfBytes(HELLO_PDF))
    expect(doc.numPages).toBe(1)
  }, 30000)
})

describe("renderPdfPage", () => {
  test("renders page 1 onto a canvas sized to the fitted viewport", async () => {
    const doc = await openPdf(pdfBytes(HELLO_PDF))

    const noop = () => {}
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement
    const context = new Proxy(
      { canvas } as Record<PropertyKey, unknown>,
      {
        get(target, prop) {
          if (prop === "canvas") return target.canvas
          if (prop === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
          if (prop === "measureText") return () => ({ width: 0 })
          if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) })
          if (prop in target) return target[prop]
          return noop
        },
        set(target, prop, value) {
          target[prop] = value
          return true
        },
      },
    ) as unknown as CanvasRenderingContext2D

    // Page is 200x100pt; a 800px viewport would fit at scale 4 but the cap limits it to 2.
    await renderPdfPage({ doc, page: 1, canvas, fitWidth: 800 })
    expect(canvas.width).toBe(400)
    expect(canvas.height).toBe(200)
  }, 30000)
})
