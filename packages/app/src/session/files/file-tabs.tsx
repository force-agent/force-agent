import { createEffect, createMemo, createResource, createSignal, lazy, onCleanup, Show, Suspense } from "solid-js"
import { Dynamic } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { FileSearchHandle } from "@opencode-ai/session-ui/file"
import { SessionReviewFilePreviewV2 } from "@opencode-ai/session-ui/v2/session-review-file-preview-v2"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { cloneSelectedLineRange } from "@opencode-ai/session-ui/pierre/selection-bridge"
import { sampledChecksum } from "@opencode-ai/util/encode"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { showToast } from "@/shell/notifications/toast"
import { useFile, type SelectedLineRange } from "@/workspaces/files/model"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import { getSessionHandoff } from "@/session/handoff"
import { useSessionLayout } from "@/session/session-layout"
import { createSessionTabs } from "@/session/helpers"
import type { SessionReviewModel } from "@/session/review/model"
import { reviewDiffNeedsLoad } from "@/session/review/review-diff-kinds"

const CsvPreview = lazy(() => import("@/session/files/csv-preview").then((module) => ({ default: module.CsvPreview })))
const XlsxPreview = lazy(() => import("@/session/files/xlsx-preview").then((module) => ({ default: module.XlsxPreview })))
const PdfPreview = lazy(() => import("@/session/files/pdf-preview").then((module) => ({ default: module.PdfPreview })))

type SessionFileViewProps = {
  tab: string
}

type ScrollPos = { x: number; y: number }

function createScrollSync(input: { tab: () => string; view: ReturnType<typeof useSessionLayout>["view"] }) {
  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined
  let pending: ScrollPos | undefined
  const [code, setCode] = createSignal<HTMLElement[]>([])

  const getCode = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const save = (next: ScrollPos) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const out = pending
      pending = undefined
      if (!out) return

      input.view().setScroll(input.tab(), out)
    })
  }

  const onCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return

    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    save({
      x: target.scrollLeft,
      y: el.scrollTop,
    })
  }

  const sync = () => {
    const next = getCode()
    const current = code()
    if (next.length === current.length && next.every((el, i) => el === current[i])) return
    setCode(next)
  }

  const restore = () => {
    const el = scroll
    if (!el) return

    const pos = input.view().scroll(input.tab())
    if (!pos) return

    sync()

    if (code().length > 0) {
      for (const item of code()) {
        if (item.scrollLeft !== pos.x) item.scrollLeft = pos.x
      }
    }

    if (el.scrollTop !== pos.y) el.scrollTop = pos.y
    if (code().length > 0) return
    if (el.scrollLeft !== pos.x) el.scrollLeft = pos.x
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return

    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restore()
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (code().length === 0) sync()

    save({
      x: code()[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    })
  }

  createEffect(() => {
    for (const item of code()) makeEventListener(item, "scroll", onCodeScroll)
  })

  const setViewport = (el: HTMLDivElement) => {
    scroll = el
    restore()
  }

  onCleanup(() => {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  return {
    handleScroll,
    queueRestore,
    setViewport,
  }
}

/**
 * Diff preview for a changed file in the Files tab: the same viewer the review
 * uses, fed by the review model's diff list for the current changes mode.
 * Summary-only diffs (no hunks) load their patch through `review.loadDiff`.
 */
export function SessionFileDiffView(props: { path: string; review: SessionReviewModel }) {
  const sdk = useWorkspaceLocation()
  const serverSDK = useServerSDK()
  const readFile = async (path: string) =>
    serverSDK.api.file
      .read({ path, location: { directory: sdk().directory } })
      .then((data) => ({ type: "text" as const, content: new TextDecoder().decode(data) }))
      .catch((error) => {
        console.debug("[session-file-diff] failed to read file", { path, error })
        return undefined
      })

  const source = createMemo(() => props.review.diffs().find((diff) => diff.file === props.path))
  const detailSource = createMemo(() => {
    const diff = source()
    if (!diff || !reviewDiffNeedsLoad(diff)) return undefined
    return { diff, version: props.review.diffVersion() }
  })
  const [loadedDiff] = createResource(detailSource, async ({ diff, version }) => {
    const value = await props.review.loadDiff(diff.file, version)
    if (value?.file !== diff.file) return undefined
    return { source: diff, version, value }
  })
  const diff = createMemo(() => {
    const value = source()
    if (loadedDiff.state !== "ready") return value
    const loaded = loadedDiff()
    if (loaded && loaded.source === value && loaded.version === props.review.diffVersion()) return loaded.value
    return value
  })

  return (
    <Show when={diff()}>
      {(value) => (
        <SessionReviewFilePreviewV2
          file={props.path}
          diff={value()}
          diffStyle={props.review.diffStyle.current()}
          expandMode={props.review.panelState.expandMode()}
          readFile={readFile}
          onLineComment={props.review.comments.add}
          onLineCommentUpdate={props.review.comments.update}
          onLineCommentDelete={props.review.comments.remove}
          lineCommentActions={props.review.comments.actions()}
          comments={props.review.comments.all()}
          focusedComment={props.review.comments.focus()}
          onFocusedCommentChange={props.review.comments.setFocus}
        />
      )}
    </Show>
  )
}

export function FileTabContent(props: { tab: string }) {
  return (
    <Tabs.Content value={props.tab}>
      <SessionFileView tab={props.tab} />
    </Tabs.Content>
  )
}

export function SessionFileView(props: SessionFileViewProps) {
  const file = useFile()
  const language = useLanguage()
  const fileComponent = useFileComponent()
  const { sessionKey, tabs, view } = useSessionLayout()
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  }).activeFileTab

  let find: FileSearchHandle | null = null

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
  }

  const path = createMemo(() => file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const selectedLines = createMemo<SelectedLineRange | null>(() => {
    const p = path()
    if (!p) return null
    if (file.ready()) return (file.selectedLines(p) as SelectedLineRange | undefined) ?? null
    return (getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined) ?? null
  })
  const scrollSync = createScrollSync({
    tab: () => props.tab,
    view,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    const p = path()
    if (!p) return
    file.setSelectedLines(p, range ? cloneSelectedLineRange(range) : null)
  }

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      if (activeFileTab() !== props.tab) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "f") return

      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  let prev = {
    loaded: false,
    ready: false,
    active: false,
  }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = activeFileTab() === props.tab
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    scrollSync.queueRestore()
  })

  const renderFile = (source: string) => (
    <div class="relative overflow-hidden pb-40">
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        enableLineSelection
        selectedLines={selectedLines()}
        onRendered={() => {
          scrollSync.queueRestore()
        }}
        onLineSelected={syncSelected}
        onLineSelectionEnd={syncSelected}
        onLineNumberSelectionEnd={syncSelected}
        search={search}
        class="select-text"
        media={{
          mode: "auto",
          path: path(),
          current: state()?.content,
          onLoad: scrollSync.queueRestore,
          onError: (args: { kind: "image" | "audio" | "svg" }) => {
            if (args.kind !== "svg") return
            showToast({
              variant: "error",
              title: language.t("toast.file.loadFailed.title"),
            })
          },
        }}
      />
    </div>
  )

  const isCsv = createMemo(() => path()?.toLowerCase().endsWith(".csv") ?? false)
  const isXlsx = createMemo(() => path()?.toLowerCase().endsWith(".xlsx") ?? false)
  const isPdf = createMemo(() => path()?.toLowerCase().endsWith(".pdf") ?? false)

  const content = () => (
    <div class="mt-3 relative h-full min-h-0">
      <Show when={state()?.loaded && isCsv()}>
        <Suspense fallback={<div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
          <CsvPreview path={path()!} content={contents()} />
        </Suspense>
      </Show>
      <Show when={state()?.loaded && isXlsx()}>
        <Suspense fallback={<div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
          <XlsxPreview path={path()!} content={contents()} />
        </Suspense>
      </Show>
      <Show when={state()?.loaded && isPdf()}>
        <Suspense fallback={<div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
          <PdfPreview path={path()!} content={contents()} />
        </Suspense>
      </Show>
      <Show when={state()?.loaded && !isCsv() && !isXlsx() && !isPdf()}>
        <ScrollView class="h-full" viewportRef={scrollSync.setViewport} onScroll={scrollSync.handleScroll}>
          {renderFile(contents())}
        </ScrollView>
      </Show>
      {/* Loading and error only replace content that is not there yet: a reload keeps the file on screen. */}
      <Show when={state()?.loading && !state()?.loaded}>
        <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
      </Show>
      <Show when={!state()?.loaded && state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Show>
    </div>
  )

  return content()
}
