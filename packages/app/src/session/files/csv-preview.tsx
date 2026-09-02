import { createMemo, lazy, Show, Suspense } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { CSV_MAX_BYTES, isCsvTooLarge, parseCsv } from "@/workspaces/files/csv"

const SheetTable = lazy(() => import("@/session/files/sheet-table").then((module) => ({ default: module.SheetTable })))

export function CsvPreview(props: { path: string; content: string }) {
  const language = useLanguage()

  const tooLarge = createMemo(() => isCsvTooLarge(props.content))

  const table = createMemo(() => {
    if (tooLarge()) return { headers: [] as string[], rows: [] as string[][] }
    return parseCsv(props.content)
  })

  const download = () => {
    const blob = new Blob([props.content], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = props.path.split("/").pop() ?? "data.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Show
      when={!tooLarge()}
      fallback={
        <div class="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <div class="text-14-regular text-text-weak">{language.t("session.files.csv.tooLarge")}</div>
          <button
            type="button"
            data-testid="csv-download"
            class="rounded bg-background-stronger px-3 py-1.5 text-13-medium text-text-strong border border-border-weak-base hover:bg-background-strongest"
            onClick={download}
          >
            {language.t("session.files.csv.download")}
          </button>
          <div class="text-12-regular text-text-weak">
            {(new TextEncoder().encode(props.content).length / 1024 / 1024).toFixed(2)} MB /{" "}
            {(CSV_MAX_BYTES / 1024 / 1024).toFixed(0)} MB
          </div>
        </div>
      }
    >
      <Show
        when={table().headers.length > 0}
        fallback={
          <div class="px-6 py-10 text-center text-14-regular text-text-weak">{language.t("session.files.csv.empty")}</div>
        }
      >
        <div class="flex flex-col h-full min-h-0">
          <div class="shrink-0 px-3 py-2 text-12-regular text-text-weak border-b border-border-weaker-base">
            {language.t("session.files.csv.rows", { count: String(table().rows.length) })} ·{" "}
            {language.t("session.files.csv.columns", { count: String(table().headers.length) })}
          </div>
          <Suspense fallback={<div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
            <SheetTable headers={table().headers} rows={table().rows} testid="csv" />
          </Suspense>
        </div>
      </Show>
    </Show>
  )
}
