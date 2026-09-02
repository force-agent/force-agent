import { For, Show, createMemo, onCleanup } from "solid-js"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Keybind } from "@opencode-ai/ui/keybind"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"

import { SessionFileBrowserTab } from "@/session/files/session-file-browser-tab"
import { SortableTab } from "@/session/files/tab"
import { useFile } from "@/workspaces/files/model"
import { useLanguage } from "@/runtime/i18n/language"
import { useSessionLayout } from "@/session/session-layout"
import { createFileTabListSync } from "@/session/files/file-tab-scroll"
import { SESSION_OPEN_FILE_TAB } from "@/session/helpers"
import { createSessionFiles } from "@/session/tabs/use-session-files"
import { ReviewTitle } from "@/session/review/view"
import type { SessionReviewModel } from "@/session/review/model"
import { useSessionModel } from "@/session/model"

export function FilesPanel(props: { review: SessionReviewModel }) {
  const file = useFile()
  const language = useLanguage()
  const { tabs, view } = useSessionLayout()
  const session = useSessionModel()

  const openReviewPanel = () => {
    view().workspaceTab.set("files")
  }

  // Diffs come from the shared review model: same query as the review, keyed
  // by the changes-mode select in the sidebar header.
  const files = createSessionFiles({
    canReview: session.canReview,
    diffs: props.review.diffs,
    openReviewPanel,
  })

  const diffFiles = files.diffFiles
  const kinds = files.kinds

  const panelTabs = files.panelTabs
  const activeTab = files.activeTab
  const activeFileTab = files.activeFileTab
  const openTab = files.openTab
  const previewTab = files.previewTab
  const activateTab = files.activateTab
  const openFileBrowser = files.openFileBrowser
  const temporaryTab = files.temporaryTab
  const browserTab = files.browserTab
  const openFileKeybind = files.openFileKeybind
  const closeTabKeybind = files.closeTabKeybind

  // The review sidebar is the only tree on this tab: it browses the whole
  // workspace in "all files" mode and the changed files in the diff modes.
  // `browserPaneTab()` falls back to the last active file tab, so the transient
  // "Review" selection that Kobalte makes while a preview trigger is replaced
  // never lands here; without any file tab the pane shows the "Open file" hint.
  const browserPaneTab = () => browserTab() ?? activeFileTab() ?? SESSION_OPEN_FILE_TAB
  const browserState = { ...props.review.panelState, sidebarOpened: () => true }
  // The "Open file" picker opens any file: it always browses the whole tree
  // (server-side search), whatever changes mode the select is in. Only the
  // picker tab being active counts — `browserPaneTab()` also falls back to it
  // when no file tab exists, and that empty state keeps the changes list.
  const changesMode = () => props.review.mode() !== "all" && browserTab() !== SESSION_OPEN_FILE_TAB
  const changes = createMemo(() => (changesMode() ? { files: diffFiles(), ready: props.review.ready() } : undefined))

  let tabList: HTMLDivElement | undefined

  return (
    <div class="flex h-full min-h-0 w-full overflow-hidden">
      <div
        id="session-side-panel-file-browser-tabpanel"
        class="flex-1 min-w-0 flex flex-col overflow-hidden"
        role="tabpanel"
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                event.target instanceof Element &&
                (!!event.target.closest('[data-slot="tabs-trigger-close-button"]') ||
                  !!event.target.closest(".session-review-v2-open-in-app-slot")),
            }),
          ]}
          modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => tabList ?? null })]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragEnd={(event) => {
            const source = event.operation.source
            if (event.canceled || !isSortable(source) || source.initialIndex === source.index) return
            tabs().move(source.id.toString(), source.index)
          }}
        >
          <Tabs value={activeTab()} onChange={activateTab} class="flex flex-col h-full min-h-0 overflow-hidden">
            <div class="session-review-v2-tabs-bar sticky top-0 shrink-0 flex items-center">
              <Tabs.List
                ref={(el: HTMLDivElement) => {
                  tabList = el
                  const stop = createFileTabListSync({ el, contextOpen: () => false })
                  onCleanup(stop)
                }}
              >
                <For each={panelTabs()}>
                  {(tab) => (
                    <Show
                      when={tab === SESSION_OPEN_FILE_TAB}
                      fallback={
                        <SortableTab
                          tab={tab}
                          index={tabs().all().indexOf(tab)}
                          temporary={temporaryTab() === tab}
                          onTabClose={tabs().close}
                          onTabDoubleClick={temporaryTab() === tab ? openTab : undefined}
                        />
                      }
                    >
                      <Tabs.Trigger
                        value={SESSION_OPEN_FILE_TAB}
                        onMiddleClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                        closeButton={
                          <Tooltip
                            value={
                              <>
                                {language.t("common.closeTab")}
                                <Show when={closeTabKeybind().length > 0}>
                                  <Keybind keys={closeTabKeybind()} variant="neutral" />
                                </Show>
                              </>
                            }
                            placement="bottom"
                            gutter={10}
                          >
                            <Tabs.CloseButton
                              onClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                              aria-label={language.t("common.closeTab")}
                            />
                          </Tooltip>
                        }
                        hideCloseButton
                      >
                        <div class="flex items-center gap-1.5 italic">
                          <Icon name="open-file" size="small" />
                          <span>{language.t("command.file.open")}</span>
                        </div>
                      </Tabs.Trigger>
                    </Show>
                  )}
                </For>
                <div class="h-full shrink-0 sticky right-0 z-10 flex items-center justify-center bg-v2-background-bg-base">
                  <Tooltip
                    value={
                      <>
                        {language.t("command.file.open")}
                        <Show when={openFileKeybind().length > 0}>
                          <Keybind keys={openFileKeybind()} variant="neutral" />
                        </Show>
                      </>
                    }
                    placement="bottom"
                    class="flex items-center"
                  >
                    <IconButton
                      icon={<Icon name="plus-small" />}
                      variant="ghost-muted"
                      size="large"
                      onClick={() => openFileBrowser()}
                      aria-label={language.t("command.file.open")}
                    />
                  </Tooltip>
                </div>
              </Tabs.List>
            </div>

            <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
              <SessionFileBrowserTab
                tab={browserPaneTab()}
                placeholder={browserPaneTab() === SESSION_OPEN_FILE_TAB}
                active={file.pathFromTab(browserTab() ?? activeFileTab() ?? "")}
                kinds={kinds()}
                state={browserState}
                title={<ReviewTitle review={props.review} />}
                stats={
                  <Show when={changesMode()}>
                    <DiffChanges changes={props.review.diffs()} />
                  </Show>
                }
                changes={changes()}
                diff={{
                  files: diffFiles(),
                  review: props.review,
                  onSelectFile: (path) => previewTab(file.tab(path)),
                }}
                filterAutofocus={files.openFileOpen()}
                onSelect={(path) => previewTab(file.tab(path))}
                onSelectPermanent={(path) => openTab(file.tab(path))}
                filterRef={files.setFilterRef}
              />
            </div>
          </Tabs>
        </DragDropProvider>
      </div>
    </div>
  )
}
