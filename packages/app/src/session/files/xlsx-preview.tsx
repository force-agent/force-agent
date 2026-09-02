import { createMemo, createSignal, For, lazy, Show, Suspense } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { XLSX_MAX_BYTES, isXlsxTooLarge, readXlsx, sheetToTable, type XlsxWorkbook } from "@/workspaces/files/xlsx"

const SheetTable = lazy(() => import("@/session/files/sheet-table").then((module) => ({ default: module.SheetTable })))

export function XlsxPreview(props: { path: string; content: string }) {
  const language = useLanguage()

  const tooLarge = createMemo(() => isXlsxTooLarge(props.content))

  const workbook = createMemo<XlsxWorkbook | undefined>(() => {
    if (tooLarge()) return undefined
    return readXlsx(props.content)
  })

  const sheetNames = createMemo(() => workbook()?.SheetNames ?? [])

  // Falls back to the first sheet when the stored name belongs to a previously opened file.
  const [picked, setPicked] = createSignal<string>()
  const sheetName = createMemo(() => {
    const names = sheetNames()
    const current = picked()
    if (current && names.includes(current)) return current
    return names[0]
  })

  const table = createMemo(() => {
    const wb = workbook()
    const name = sheetName()
    if (!wb || !name) return { headers: [] as string[], rows: [] as string[][] }
    return sheetToTable(wb, name)
  })

  const download = () => {
    const bytes = Uint8Array.from(atob(props.content), (char) => char.charCodeAt(0))
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = props.path.split("/").pop() ?? "data.xlsx"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Show
      when={!tooLarge()}
      fallback={
        <div class="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <div class="text-14-regular text-text-weak">{language.t("session.files.xlsx.tooLarge")}</div>
          <button
            type="button"
            data-testid="xlsx-download"
            class="rounded bg-background-stronger px-3 py-1.5 text-13-medium text-text-strong border border-border-weak-base hover:bg-background-strongest"
            onClick={download}
          >
            {language.t("session.files.xlsx.download")}
          </button>
          <div class="text-12-regular text-text-weak">
            {((props.content.length * 3) / 4 / 1024 / 1024).toFixed(2)} MB / {(XLSX_MAX_BYTES / 1024 / 1024).toFixed(0)} MB
          </div>
        </div>
      }
    >
      <Show
        when={sheetName() && table().headers.length > 0}
        fallback={
          <div class="px-6 py-10 text-center text-14-regular text-text-weak">{language.t("session.files.xlsx.empty")}</div>
        }
      >
        <div class="flex flex-col h-full min-h-0">
          <div class="shrink-0 flex items-center gap-3 px-3 py-2 text-12-regular text-text-weak border-b border-border-weaker-base">
            <Show when={sheetNames().length > 1}>
              <select
                data-testid="xlsx-sheet-select"
                aria-label={language.t("session.files.xlsx.sheet")}
                class="rounded bg-background-stronger px-2 py-1 text-12-medium text-text-strong border border-border-weak-base"
                value={sheetName()}
                onChange={(event) => setPicked(event.currentTarget.value)}
              >
                <For each={sheetNames()}>{(name) => <option value={name}>{name}</option>}</For>
              </select>
            </Show>
            <div>
              {language.t("session.files.xlsx.rows", { count: String(table().rows.length) })} ·{" "}
              {language.t("session.files.xlsx.columns", { count: String(table().headers.length) })}
            </div>
          </div>
          <Suspense fallback={<div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
            <SheetTable headers={table().headers} rows={table().rows} testid="xlsx" />
          </Suspense>
        </div>
      </Show>
    </Show>
  )
}
