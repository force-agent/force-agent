import { createEffect, createMemo, type Accessor } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import type { FileDiffInfo } from "@opencode-ai/client/promise"

import { normalizeFileTreeV2Path } from "@/session/files/file-tree-v2-model"
import { useCommand } from "@/shell/commands/command"
import { useFile, type SelectedLineRange } from "@/workspaces/files/model"
import { setSessionHandoff } from "@/session/handoff"
import { useSessionLayout } from "@/session/session-layout"
import { SESSION_OPEN_FILE_TAB, createOpenSessionFileTab, createSessionTabs } from "@/session/helpers"

export type DiffKind = "add" | "del" | "mix"

function renderDiff(value: FileDiffInfo): value is FileDiffInfo {
  return typeof value.file === "string"
}

/**
 * Shared file/tab state for the session workspace.
 *
 * Create this once per session screen and hand the model to every panel that
 * needs it — creating it per panel would duplicate `createSessionTabs` and
 * split the open-tab strip in two.
 */
export function createSessionFiles(input: {
  canReview: Accessor<boolean>
  diffs: Accessor<FileDiffInfo[]>
  /** Reveals the surface that hosts file tabs. */
  openReviewPanel: () => void
}) {
  const file = useFile()
  const command = useCommand()
  const { sessionKey, tabs } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const reviewTab = createMemo(() => isDesktop())

  const diffs = createMemo(() => input.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: DiffKind | undefined, b: DiffKind) => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const out = new Map<string, DiffKind>()
    for (const diff of diffs()) {
      const file = normalizeFileTreeV2Path(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: input.canReview,
    fileBrowser: () => true,
  })

  let fileFilter: HTMLInputElement | undefined
  const setFilterRef = (element: HTMLInputElement | undefined) => (fileFilter = element)

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel: input.openReviewPanel,
    setActive: tabs().setActive,
  })

  const previewTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().previewTab(next)
    const path = file.pathFromTab(next)
    if (path) void file.load(path)
    input.openReviewPanel()
    queueMicrotask(() => tabs().setActive(next))
  }

  const openFileBrowser = () => {
    previewTab(SESSION_OPEN_FILE_TAB)
    queueMicrotask(() => fileFilter?.focus())
  }

  const activateTab = (value: string) => {
    const next = normalizeTab(value)
    const path = file.pathFromTab(next)
    if (path) void file.load(path)
    input.openReviewPanel()
    tabs().setActive(next)
  }

  const browserTab = createMemo(() => {
    const active = tabState.activeTab()
    if (active === SESSION_OPEN_FILE_TAB) return SESSION_OPEN_FILE_TAB
    if (active && file.pathFromTab(active)) return active
    return tabState.activeFileTab()
  })

  // Keep the file-browser shell mounted while any file tab exists. Kobalte briefly
  // selects Review while the tab For replaces a preview trigger, which would
  // otherwise dispose the sidebar and reset scroll.
  const fileBrowserMounted = createMemo(() => {
    return tabState.openedTabs().length > 0 || tabState.openFileOpen() || !!browserTab()
  })
  const fileBrowserVisible = createMemo(() => {
    const active = tabState.activeTab()
    return active !== "review" && active !== "context" && active !== "empty"
  })

  const openFileKeybind = createMemo(() => command.keybindParts("file.open"))
  const closeTabKeybind = createMemo(() => command.keybindParts("tab.close"))

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return {
    ...tabState,
    reviewTab,
    diffs,
    diffFiles,
    kinds,
    nofiles,
    normalizeTab,
    openTab,
    previewTab,
    activateTab,
    openFileBrowser,
    setFilterRef,
    temporaryTab: tabs().preview,
    browserTab,
    fileBrowserMounted,
    fileBrowserVisible,
    openFileKeybind,
    closeTabKeybind,
  }
}

export type SessionFilesModel = ReturnType<typeof createSessionFiles>
