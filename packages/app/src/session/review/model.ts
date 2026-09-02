import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { SessionReviewLineComment } from "@opencode-ai/session-ui/session-review"
import { previewSelectedLines } from "@opencode-ai/session-ui/pierre/selection-bridge"
import { checksum } from "@opencode-ai/util/encode"
import { createQuery, skipToken, useQueryClient } from "@tanstack/solid-query"
import { debounce } from "@solid-primitives/scheduled"
import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useComments } from "@/composer/comments"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/workspaces/files/model"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { useComposerState } from "@/composer/persistence"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServerSDK } from "@/runtime/server/client"
import { createOpenReviewFile } from "../helpers"
import type { SessionModel } from "../model"
import type { SessionScreenLayout } from "../screen-layout"
import { createReviewPanelState } from "./panel-state"
import { focusWorkspaceTab } from "../tabs/workspace-tab-focus"
import { reviewDiffDirectory, reviewDiffNeedsLoad, reviewRootDirectory } from "./review-diff-kinds"
import type { DiffStyle } from "./review-tab"

export type ChangeMode = "git" | "branch" | "turn" | "all"
type VcsMode = "git" | "branch"

export function createSessionReview(input: {
  session: SessionModel
  screen: SessionScreenLayout
  deferRender: Accessor<boolean>
}) {
  const data = input.session.shared.data
  const queryClient = useQueryClient()
  const comments = useComments()
  const file = useFile()
  const language = useLanguage()
  const layout = useLayout()
  const prompt = useComposerState()
  const location = useWorkspaceLocation()
  const server = useServerSDK()
  const [state, setState] = createStore({
    mobileTab: "session" as "session" | "changes",
    detailsOpen: false,
    scroll: undefined as HTMLDivElement | undefined,
    pendingFile: undefined as string | undefined,
    pendingOpen: false,
  })
  const mode = () => input.session.layout.view().review.mode() ?? "git"
  const selectedFile = () => input.session.layout.view().review.file()
  createEffect(() => {
    const tab = input.session.tabs.activeFileTab()
    if (!tab) return
    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })
  const vcs = createMemo(() => data.location.vcs.info({ directory: location().directory }))
  const options = createMemo<ChangeMode[]>(() => {
    const list: ChangeMode[] = []
    const project = input.session.project()
    if (project?.vcs === "git") list.push("git")
    if (
      project?.vcs === "git" &&
      vcs()?.branch.current &&
      vcs()?.branch.default &&
      vcs()?.branch.current !== vcs()?.branch.default
    ) {
      list.push("branch")
    }
    // The Files tab browses the whole tree in this mode; the diff query still
    // runs against the working tree so changed files keep their A/D/M badges.
    list.push("all")
    return list
  })
  const mobileChanges = createMemo(() => !input.session.isDesktop() && state.mobileTab === "changes")
  const vcsMode = createMemo<VcsMode | undefined>(() => {
    const value = mode()
    if (value === "all") return "git"
    return value === "git" || value === "branch" ? value : undefined
  })
  const vcsKey = createMemo(
    () =>
      [
        server.scope,
        "session-vcs",
        location().directory,
        vcs()?.branch.current ?? "",
        vcs()?.branch.default ?? "",
      ] as const,
  )
  const wantsReview = createMemo(() =>
    input.session.isDesktop() ? input.screen.review.open() || input.screen.files.open() : mobileChanges(),
  )
  const vcsQuery = createQuery(() => {
    const value = vcsMode()
    return {
      queryKey: [...vcsKey(), value] as const,
      enabled: server.connection.status() === "connected" && wantsReview() && input.session.project()?.vcs === "git",
      refetchOnMount: "always" as const,
      refetchOnWindowFocus: true,
      queryFn: value
        ? () =>
            server.api.vcs
              .diff({
                location: { directory: location().directory },
                mode: value === "git" ? "working" : value,
              })
              .then((result) => result.data)
        : skipToken,
    }
  })
  const detailsQuery = createQuery(() => ({
    queryKey: [server.scope, "session-details", input.session.workspace.directory()] as const,
    enabled: state.detailsOpen && server.connection.status() === "connected" && input.session.project()?.vcs === "git",
    queryFn: () =>
      server.api.vcs
        .diff({ location: { directory: input.session.workspace.directory() }, mode: "working" })
        .then((result) => result.data)
        .catch((error) => {
          console.debug("[session-review] failed to load session details diff", { error })
          return []
        }),
  }))
  const refresh = debounce(() => {
    void queryClient.invalidateQueries({ queryKey: vcsKey() })
    void queryClient.invalidateQueries({
      queryKey: [server.scope, "session-details", input.session.workspace.directory()],
    })
  }, 100)
  createEffect(() => {
    const stop = location().event.listen((event) => {
      if (event.type === "filesystem.changed") refresh()
    })
    onCleanup(stop)
  })
  createEffect(
    on(
      () => input.screen.review.open() || mobileChanges(),
      (open, previous) => {
        if (!open || previous || !input.screen.files.open() || vcsQuery.isFetching) return
        refresh()
      },
      { defer: true },
    ),
  )
  const diffs = () => {
    if (vcsMode()) return vcsQuery.isFetched ? (vcsQuery.data ?? []) : []
    return []
  }
  const activeFile = () => {
    const list = diffs()
    const selected = selectedFile()
    if (selected && list.some((diff) => diff.file === selected)) return selected
    return list[0]?.file
  }
  const count = () => diffs().length
  const hasChanges = () => count() > 0
  const ready = () => {
    if (vcsMode()) return !vcsQuery.isPending
    return true
  }
  const loadDiff = async (path: string, version?: number): Promise<FileDiffInfo | undefined> => {
    const value = vcsMode()
    if (!value) return undefined
    const root = reviewRootDirectory(input.session.project()?.worktree ?? location().directory)
    const directory = reviewDiffDirectory(root, path)
    const source = diffs().find((diff) => diff.file === path)
    const valid = (diff: FileDiffInfo | undefined): FileDiffInfo | undefined => {
      if (!diff || !source) return undefined
      if (diff.additions !== source.additions || diff.deletions !== source.deletions) return undefined
      if (reviewDiffNeedsLoad(diff)) return undefined
      return diff
    }
    const request = (scope: string, context?: number) =>
      queryClient
        .fetchQuery({
          queryKey: [server.scope, ...vcsKey(), value, "directory", scope, context, version] as const,
          staleTime: Number.POSITIVE_INFINITY,
          retry: 2,
          queryFn: () =>
            server.api.vcs
              .diff({
                location: { directory: scope },
                mode: value === "git" ? "working" : value,
                context,
              })
              .then((result) => result.data),
        })
        .then((result) => result.find((diff) => diff.file === path))

    if (directory !== root) {
      try {
        const scoped = valid(await request(directory))
        if (scoped) return scoped
      } catch (error) {
        console.debug("[session-review] failed to load scoped vcs diff", { mode: value, path, directory, error })
      }
    }
    try {
      const bounded = valid(await request(root, 3))
      if (bounded) return bounded
    } catch (error) {
      console.debug("[session-review] failed to load bounded vcs diff", { mode: value, path, root, error })
    }
    return undefined
  }
  const selectionPreview = (path: string, selection: FileSelection): string | undefined => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }
  const addComment = (comment: SessionReviewLineComment) => {
    const selection = selectionFromLines(comment.selection)
    const saved = comments.add({ file: comment.file, selection: comment.selection, comment: comment.comment })
    prompt.context.add({
      type: "file",
      path: comment.file,
      selection,
      comment: comment.comment,
      commentID: saved.id,
      commentOrigin: "review",
      preview: comment.preview ?? selectionPreview(comment.file, selection),
    })
  }
  const updateComment = (comment: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(comment.file, comment.id, comment.comment)
    prompt.context.updateComment(comment.file, comment.id, {
      comment: comment.comment,
      ...(comment.preview ? { preview: comment.preview } : {}),
    })
  }
  const removeComment = (comment: { id: string; file: string }) => {
    comments.remove(comment.file, comment.id)
    prompt.context.removeComment(comment.file, comment.id)
  }
  const commentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))
  const open = () => {
    focusWorkspaceTab(input.session.identity.sessionKey(), "files")
  }
  // The turn summary shows the working-tree diff, which is what git mode
  // lists; there is no diff source for a "last turn" mode in this model. The
  // first changed file opens once that mode's diff is ready (the query only
  // runs while the Files tab is active).
  const openChanges = () => {
    open()
    if (options().includes("git")) input.session.layout.view().review.setMode("git")
    setState("pendingOpen", true)
  }
  const openFile = createOpenReviewFile({
    // The Files tab picks its tree through the changes-mode select; opening a
    // file no longer flips the tree to "all files" behind the user's back.
    showAllFiles: () => {},
    tabForPath: file.tab,
    openTab: (tab) => input.session.layout.tabs().open(tab),
    setActive: (tab) => input.session.layout.tabs().setActive(tab),
    loadFile: file.load,
  })
  createEffect(() => {
    if (!state.pendingOpen || !ready()) return
    const path = activeFile()
    setState("pendingOpen", false)
    if (!path) return
    input.session.layout.view().review.setFile(path)
    openFile(path)
  })
  const reviewDiffId = (path: string): string | undefined => {
    const sum = checksum(path)
    if (!sum) return undefined
    return `session-review-diff-${sum}`
  }
  const reviewDiffTop = (path: string): number | undefined => {
    if (!state.scroll) return undefined
    const id = reviewDiffId(path)
    if (!id) return undefined
    const element = document.getElementById(id)
    if (!(element instanceof HTMLElement) || !state.scroll.contains(element)) return undefined
    const target = element.getBoundingClientRect()
    const root = state.scroll.getBoundingClientRect()
    return target.top - root.top + state.scroll.scrollTop
  }
  const scrollToFile = (path: string) => {
    if (!state.scroll) return false
    const top = reviewDiffTop(path)
    if (top === undefined) return false
    input.session.layout.view().setScroll("review", { x: state.scroll.scrollLeft, y: top })
    state.scroll.scrollTo({ top, behavior: "auto" })
    return true
  }
  const focusFile = (path: string) => {
    open()
    input.session.layout.view().review.openPath(path)
    input.session.layout.view().review.setFile(path)
    setState("pendingFile", path)
  }
  createEffect(() => {
    const pending = state.pendingFile
    if (!pending || !state.scroll || !ready()) return
    const attempt = (count: number) => {
      if (state.pendingFile !== pending) return
      if (count > 60) {
        setState("pendingFile", undefined)
        return
      }
      if (!state.scroll || !scrollToFile(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }
      const top = reviewDiffTop(pending)
      if (top === undefined || Math.abs(state.scroll.scrollTop - top) > 1) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }
      setState("pendingFile", undefined)
    }
    requestAnimationFrame(() => attempt(0))
  })
  let treeDirectory: string | undefined
  createEffect(() => {
    const directory = location().directory
    if (!input.session.isDesktop() || !layout.fileTree.opened() || server.connection.status() !== "connected") return
    const refreshTree = treeDirectory !== directory
    treeDirectory = directory
    void (refreshTree ? file.tree.refresh("") : file.tree.list(""))
  })
  createEffect(
    on(
      () => location().directory,
      () => {
        const tab = input.session.tabs.activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (path) void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    if (!layout.ready() || server.connection.status() !== "connected" || !input.session.project()) return
    const list = options()
    const value = mode()
    if (list.includes(value)) return
    const next = list[0]
    if (next) input.session.layout.view().review.setMode(next)
  })
  createEffect(
    on(
      () => data.session.status(input.session.identity.params.id ?? ""),
      (next, previous) => {
        if (next !== "idle" || previous === undefined || previous === "idle") return
        refresh()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      input.session.identity.sessionKey,
      () => {
        setState("mobileTab", "session")
        setState("scroll", undefined)
        setState("pendingFile", undefined)
      },
      { defer: true },
    ),
  )

  const panelState = createReviewPanelState()
  const panelRendered = createMemo<boolean>((previous) => previous || !input.deferRender(), false)
  return {
    activeFile,
    canReview: input.session.canReview,
    comments: {
      actions: commentActions,
      add: addComment,
      all: comments.all,
      focus: comments.focus,
      mentions: file.searchFilesAndDirectories,
      remove: removeComment,
      changeFocus: (focus: { file: string; id: string } | null) => {
        if (!focus) {
          const current = comments.focus()
          if (current && diffs().some((diff) => diff.file === current.file)) focusFile(current.file)
        }
        comments.setFocus(focus)
      },
      setFocus: comments.setFocus,
      update: updateComment,
    },
    count,
    deferRender: input.deferRender,
    details: {
      diffs: () => (detailsQuery.isFetched ? (detailsQuery.data ?? []) : undefined),
      setOpen: (open: boolean) => setState("detailsOpen", open),
    },
    diffVersion: () => vcsQuery.dataUpdatedAt,
    diffStyle: {
      current: layout.review.diffStyle,
      set: (style: DiffStyle) => layout.review.setDiffStyle(style),
    },
    diffs,
    focusFile,
    hasChanges,
    loadDiff,
    mobile: {
      changes: mobileChanges,
      setTab: (tab: "session" | "changes") => setState("mobileTab", tab),
      tab: () => state.mobileTab,
    },
    mode,
    noGit: createMemo(() => !!input.session.project() && input.session.project()?.vcs !== "git"),
    open,
    openChanges,
    openFile,
    options,
    panelState,
    panelRendered,
    ready,
    screen: input.screen,
    setMode: (value: ChangeMode) => input.session.layout.view().review.setMode(value),
    setScroll: (element: HTMLDivElement | undefined) => setState("scroll", element),
    view: input.session.layout.view,
  }
}

export type SessionReviewModel = ReturnType<typeof createSessionReview>
