import { createMemo, createSignal, createUniqueId, Show, type JSX } from "solid-js"
import { createQuery } from "@tanstack/solid-query"
import { Icon } from "@opencode-ai/ui/icon"
import { SessionFilePanelV2, SessionFilePanelV2Empty } from "@opencode-ai/session-ui/v2/session-file-panel-v2"
import {
  SessionReviewV2DiffControls,
  SessionReviewV2FileNav,
  SessionReviewV2Sidebar,
} from "@opencode-ai/session-ui/v2/session-review-v2"
import FileTreeV2, { type Kind } from "@/session/files/file-tree-v2"
import { useFile } from "@/workspaces/files/model"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useSessionLayout } from "@/session/session-layout"
import { SessionFileDiffView, SessionFileView } from "@/session/files/file-tabs"
import { applyFileListKeyDown, SessionFileList } from "@/session/files/list"
import type { SessionReviewModel } from "@/session/review/model"
import { filterReviewFiles } from "@/session/review/review-diff-kinds"

const emptyFiles: string[] = []

export type SessionFileBrowserState = {
  sidebarOpened: () => boolean
  sidebarWidth: () => number
  sidebarTransition: () => boolean
  resizeSidebar: (width: number) => void
  toggleSidebar: () => void
}

/**
 * Changes-mode sidebar: the tree is restricted to `files` and the filter runs
 * locally over that list. Without it the sidebar browses the whole workspace
 * and the filter searches the server.
 */
export type SessionFileBrowserChanges = {
  files: string[]
  ready: boolean
}

/**
 * Diff preview: a file in `files` (the changed files of the current mode)
 * renders as a diff with the review toolbar instead of as plain contents.
 */
export type SessionFileBrowserDiff = {
  files: string[]
  review: SessionReviewModel
  onSelectFile: (path: string) => void
}

export function SessionFileBrowserTab(props: {
  tab: string
  placeholder: boolean
  active?: string
  kinds: ReadonlyMap<string, Kind>
  state: SessionFileBrowserState
  title?: JSX.Element
  stats?: JSX.Element
  changes?: SessionFileBrowserChanges
  diff?: SessionFileBrowserDiff
  filterAutofocus?: boolean
  onSelect: (path: string) => void
  onSelectPermanent: (path: string) => void
  filterRef?: (element: HTMLInputElement) => void
}) {
  const file = useFile()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const { workspaceKey } = useSessionLayout()
  const resultsID = `session-file-browser-results-${createUniqueId()}`
  const [filter, setFilter] = createSignal("")
  const [explicitHighlight, setExplicitHighlight] = createSignal<string>()
  const sidebarOpened = () => props.placeholder || props.state.sidebarOpened()
  const diffFile = createMemo(() => {
    const diff = props.diff
    if (!diff || props.placeholder) return undefined
    const path = file.pathFromTab(props.tab)
    if (!path || !diff.files.includes(path)) return undefined
    return path
  })
  const query = createMemo(() => filter().trim())
  const search = createQuery(() => {
    const value = query()
    return {
      queryKey: [serverSDK.scope, "session-open-file", workspaceKey(), value] as const,
      enabled: serverSDK.connection.status() === "connected" && value.length > 0 && !props.changes,
      queryFn: ({ signal }) => file.searchFiles(value, { limit: 200, signal }),
    }
  })
  const files = createMemo(() => {
    if (!query()) return emptyFiles
    const changes = props.changes
    if (changes) return filterReviewFiles(changes.files, query())
    if (search.isPending) return emptyFiles
    return [...new Set(search.data ?? emptyFiles)]
  })
  const highlighted = createMemo(() => {
    const values = files()
    if (values.length === 0) return undefined
    const explicit = explicitHighlight()
    if (explicit && values.includes(explicit)) return explicit
    return values[0]
  })

  const loading = createMemo(() => query().length > 0 && !props.changes && search.isPending)
  // Changes-only trees omit "M" — every row is already a change; A/D stay visible.
  const kinds = createMemo(() => {
    if (!props.changes) return props.kinds
    return new Map([...props.kinds].filter(([, kind]) => kind !== "mix"))
  })
  const optionID = (path: string) => `${resultsID}-option-${files().indexOf(path)}`

  const onFilterKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.key === "Escape" && query()) {
      event.preventDefault()
      setFilter("")
      return
    }
    if (!query()) return
    applyFileListKeyDown(event, files(), highlighted(), {
      onHighlight: setExplicitHighlight,
      onSelect: props.onSelectPermanent,
    })
  }

  // Keep the sidebar outside Kobalte Tabs.Content: a morphing content value
  // unmounts the whole panel on every file-tab switch and resets sidebar scroll.
  return (
    <SessionFilePanelV2
      toolbar={!!diffFile()}
      toolbarStart={
        <Show when={diffFile()}>
          {(path) => (
            <SessionReviewV2FileNav
              files={props.diff!.files}
              activeFile={path()}
              onSelectFile={props.diff!.onSelectFile}
            />
          )}
        </Show>
      }
      toolbarEnd={
        <Show when={props.diff}>
          {(diff) => (
            <SessionReviewV2DiffControls
              expandMode={diff().review.panelState.expandMode()}
              onExpandModeChange={diff().review.panelState.setExpandMode}
              diffStyle={diff().review.diffStyle.current()}
              onDiffStyleChange={diff().review.diffStyle.set}
            />
          )}
        </Show>
      }
      sidebar={
        <SessionReviewV2Sidebar
          open={sidebarOpened()}
          transition={props.state.sidebarTransition()}
          title={props.title}
          stats={props.stats}
          filter={filter()}
          onFilterChange={setFilter}
          onFilterKeyDown={onFilterKeyDown}
          filterAutofocus={props.filterAutofocus ?? props.placeholder}
          filterRef={props.filterRef}
          filterControls={resultsID}
          filterActiveDescendant={highlighted() ? optionID(highlighted()!) : undefined}
          filterExpanded={query().length > 0 && files().length > 0}
          width={props.state.sidebarWidth()}
          onWidthChange={props.state.resizeSidebar}
        >
          <Show
            when={query()}
            fallback={
              <Show
                when={!props.changes || props.changes.ready}
                fallback={
                  <div role="status" class="px-2 py-2 text-12-regular text-text-weak">
                    {language.t("common.loading")}
                    {language.t("common.loading.ellipsis")}
                  </div>
                }
              >
                <Show
                  when={props.changes}
                  fallback={
                    <FileTreeV2
                      active={props.active}
                      kinds={kinds()}
                      onFileClick={(node) => props.onSelect(node.path)}
                      onFileDoubleClick={(node) => props.onSelectPermanent(node.path)}
                    />
                  }
                >
                  {(changes) => (
                    <Show
                      when={changes().files.length > 0}
                      fallback={
                        <div role="status" class="px-2 py-6 text-12-regular text-text-weak text-center">
                          {language.t("session.review.noChanges")}
                        </div>
                      }
                    >
                      <FileTreeV2
                        allowed={changes().files}
                        active={props.active}
                        kinds={kinds()}
                        draggable={false}
                        onFileClick={(node) => props.onSelect(node.path)}
                        onFileDoubleClick={(node) => props.onSelectPermanent(node.path)}
                      />
                    </Show>
                  )}
                </Show>
              </Show>
            }
          >
            <Show
              when={!loading()}
              fallback={
                <div role="status" class="px-2 py-2 text-12-regular text-text-weak">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              }
            >
              <Show
                when={files().length > 0}
                fallback={
                  <div role="status" class="px-2 py-2 text-12-regular text-text-weak">
                    {language.t("palette.empty")}
                  </div>
                }
              >
                <SessionFileList
                  id={resultsID}
                  role="listbox"
                  optionID={optionID}
                  files={files()}
                  kinds={kinds()}
                  active={props.active}
                  highlighted={highlighted()}
                  onFileClick={(path) => {
                    setExplicitHighlight(path)
                    props.onSelect(path)
                  }}
                  onFileDoubleClick={props.onSelectPermanent}
                />
              </Show>
            </Show>
          </Show>
        </SessionReviewV2Sidebar>
      }
    >
      <Show
        when={!props.placeholder}
        fallback={
          <SessionFilePanelV2Empty>
            <div class="flex flex-col items-center gap-3 text-center text-text-weak">
              <Icon name="file-tree" size="large" />
              <div class="text-14-medium text-text-strong">{language.t("command.file.open")}</div>
              <div class="text-13-regular">{language.t("session.files.selectToOpen")}</div>
            </div>
          </SessionFilePanelV2Empty>
        }
      >
        <Show
          when={diffFile()}
          keyed
          fallback={
            <div class="min-h-0 flex-1">
              <Show when={props.tab} keyed>
                {(tab) => <SessionFileView tab={tab} />}
              </Show>
            </div>
          }
        >
          {(path) => <SessionFileDiffView path={path} review={props.diff!.review} />}
        </Show>
      </Show>
    </SessionFilePanelV2>
  )
}
