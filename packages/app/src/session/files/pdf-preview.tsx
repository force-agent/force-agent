import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { useLanguage } from "@/runtime/i18n/language"
import {
  PDF_MAX_BYTES,
  configurePdfWorker,
  isPdfTooLarge,
  openPdf,
  pdfBytes,
  renderPdfPage,
  type PdfDocument,
} from "@/workspaces/files/pdf"

// The worker is bundled as a same-origin asset; pdf.js must never fall back to a CDN.
configurePdfWorker(pdfWorkerUrl)

export function PdfPreview(props: { path: string; content: string }) {
  const language = useLanguage()

  const tooLarge = createMemo(() => isPdfTooLarge(props.content))

  const [state, setState] = createStore({
    doc: null as PdfDocument | null,
    page: 1,
    total: 0,
    failed: false,
  })

  let viewport: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined

  createEffect(
    on(
      () => props.content,
      (content) => {
        setState({ doc: null, page: 1, total: 0, failed: false })
        openPdf(pdfBytes(content))
          .then((doc) => {
            if (props.content !== content) return
            setState({ doc, total: doc.numPages, page: 1, failed: false })
          })
          .catch(() => {
            if (props.content !== content) return
            setState("failed", true)
          })
      },
    ),
  )

  createEffect(
    on(
      () => [state.doc, state.page] as const,
      async ([doc, page]) => {
        if (!doc || !canvas) return
        await renderPdfPage({ doc, page, canvas, fitWidth: viewport?.clientWidth ?? 0 })
      },
    ),
  )

  onCleanup(() => {
    state.doc?.loadingTask.destroy()
  })

  const prevPage = () => {
    if (state.page > 1) setState("page", state.page - 1)
  }

  const nextPage = () => {
    if (state.page < state.total) setState("page", state.page + 1)
  }

  const download = () => {
    const blob = new Blob([pdfBytes(props.content)], { type: "application/pdf" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = props.path.split("/").pop() ?? "document.pdf"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Show
      when={!tooLarge()}
      fallback={
        <div class="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <div class="text-14-regular text-text-weak">{language.t("session.files.pdf.tooLarge")}</div>
          <button
            type="button"
            data-testid="pdf-download"
            class="rounded bg-background-stronger px-3 py-1.5 text-13-medium text-text-strong border border-border-weak-base hover:bg-background-strongest"
            onClick={download}
          >
            {language.t("session.files.pdf.download")}
          </button>
          <div class="text-12-regular text-text-weak">
            {((props.content.length * 3) / 4 / 1024 / 1024).toFixed(2)} MB / {(PDF_MAX_BYTES / 1024 / 1024).toFixed(0)} MB
          </div>
        </div>
      }
    >
      <Show
        when={!state.failed}
        fallback={
          <div class="px-6 py-10 text-center text-14-regular text-text-weak">
            {language.t("session.files.pdf.loadFailed")}
          </div>
        }
      >
        <div class="flex flex-col h-full min-h-0">
          <div class="shrink-0 flex items-center justify-center gap-3 px-3 py-2 text-12-regular text-text-weak border-b border-border-weaker-base">
            <button
              type="button"
              data-testid="pdf-prev"
              aria-label={language.t("session.files.pdf.prev")}
              disabled={state.page <= 1}
              class="rounded bg-background-stronger px-2 py-1 text-12-medium text-text-strong border border-border-weak-base disabled:opacity-50 hover:bg-background-strongest"
              onClick={prevPage}
            >
              ‹
            </button>
            <div data-testid="pdf-page-indicator">
              {language.t("session.files.pdf.page", { page: String(state.page), total: String(state.total) })}
            </div>
            <button
              type="button"
              data-testid="pdf-next"
              aria-label={language.t("session.files.pdf.next")}
              disabled={state.page >= state.total}
              class="rounded bg-background-stronger px-2 py-1 text-12-medium text-text-strong border border-border-weak-base disabled:opacity-50 hover:bg-background-strongest"
              onClick={nextPage}
            >
              ›
            </button>
          </div>
          <div ref={viewport} class="flex-1 min-h-0 overflow-auto bg-background-stronger p-3">
            <Show when={state.doc} fallback={<div class="px-2 py-2 text-text-weak">{language.t("common.loading")}</div>}>
              <canvas data-testid="pdf-canvas" class="mx-auto block bg-white shadow-sm" ref={canvas} />
            </Show>
          </div>
        </div>
      </Show>
    </Show>
  )
}
