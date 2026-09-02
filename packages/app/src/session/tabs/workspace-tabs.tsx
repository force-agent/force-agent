import { For, Show, type JSX } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import "./workspace-tabs.css"

import { useLanguage } from "@/runtime/i18n/language"
import { SessionPanelFrame } from "@/session/session-frame"
import {
  WORKSPACE_PANELS_ID,
  workspaceTabID,
  workspaceTabPanelID,
  type WorkspaceTabID,
} from "@/session/tabs/workspace-tab"
import type { WorkspaceTabsModel } from "@/session/tabs/workspace-tabs-model"
import { BrowserPanel } from "@/session/tabs/panels/browser-panel"
import { ContextPanel } from "@/session/tabs/panels/context-panel"
import { FilesPanel } from "@/session/tabs/panels/files-panel"
import { SessionContextUsage } from "@/session/timeline/session-context-usage"
import type { SessionReviewModel } from "@/session/review/model"
import { TitlebarRightMount } from "@/shell/titlebar/right-slot"

/** Height of the tab bar, published so the Skills strip can align with the body below it. */
export const WORKSPACE_TABS_BAR_HEIGHT = 36

export function SessionWorkspaceTabs(props: {
  model: WorkspaceTabsModel
  review: SessionReviewModel
  chat: () => JSX.Element
  panels?: () => JSX.Element
}) {
  const language = useLanguage()

  const label = (tab: WorkspaceTabID) => {
    switch (tab) {
      case "chat":
        return language.t("session.tab.chat")
      case "context":
        return language.t("session.tab.context")
      case "files":
        return language.t("session.tab.files")
      case "browser":
        return language.t("session.tab.browser")
    }
  }

  return (
    <div data-slot="session-workspace" class="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      {/* Same surface recipe as SessionPanelFrame(raised) below and to the right: no border. */}
      <div
        data-slot="session-workspace-tabs-bar"
        class="flex shrink-0 items-center overflow-x-auto rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
        style={{ height: `${WORKSPACE_TABS_BAR_HEIGHT}px` }}
      >
        <Tabs
          variant="surface"
          value={props.model.active()}
          onChange={(value) => props.model.set(value as WorkspaceTabID)}
          data-scope="session-workspace"
          aria-label={language.t("session.workspace.tabs")}
          class="flex h-full min-w-0 flex-1 items-center"
        >
          <Tabs.List class="flex w-full items-center gap-1 overflow-x-auto p-1">
            <For each={props.model.all()}>
              {(tab) => (
                <Tabs.Trigger
                  value={tab}
                  id={workspaceTabID(tab)}
                  // Kobalte's Trigger overwrites data-slot with "tabs-trigger"; data-tab survives.
                  data-tab={tab}
                  aria-controls={props.model.is(tab) ? workspaceTabPanelID(tab) : undefined}
                >
                  <Show when={tab === "context"} fallback={label(tab)}>
                    <span class="flex items-center gap-2">
                      <SessionContextUsage variant="indicator" />
                      <span>{label(tab)}</span>
                    </span>
                  </Show>
                </Tabs.Trigger>
              )}
            </For>
          </Tabs.List>
        </Tabs>
        {/*
          Right edge of the bar hosts what the topbar used to: the session's
          StatusPopover portals in here (SessionHeader → TitlebarRight), so it
          survives the topbar being collapsed in the web build.
        */}
        <div class="ml-auto flex h-full shrink-0 items-center pr-1">
          <TitlebarRightMount />
        </div>
      </div>

      {/*
        Flex column, not a bare block: SessionPanelFrame sizes itself from
        `flex-1` here instead of resolving `h-full` against a percentage base
        that only some engines derive from a flex-resolved height.
      */}
      <div data-slot="session-workspace-body" class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <SessionPanelFrame raised>
          {/*
            Chat is mounted unconditionally and only ever hidden: unmounting it
            would drop scroll position, in-flight streaming and unsent composer
            text. Every other panel follows the same hidden+inert discipline once
            it has been opened once.
          */}
          <div
            id={workspaceTabPanelID("chat")}
            role="tabpanel"
            aria-labelledby={workspaceTabID("chat")}
            data-slot="session-workspace-panel"
            data-tab="chat"
            class="flex min-h-0 flex-1 flex-col overflow-hidden"
            classList={{ hidden: !props.model.is("chat") }}
            inert={!props.model.is("chat") || undefined}
          >
            {props.chat()}
          </div>

          {/*
            The wrapper is always in the DOM (E2E specs and the header's
            aria-controls point at it), but it must not take space while Chat is
            active: an empty sibling that took height would split the column
            50/50 and push the composer to mid-screen.

            `flex-1` rather than `h-full`: exactly one of the two siblings is
            visible, so it takes the frame's height from flex layout. A
            percentage would have to resolve against a flex-derived height, and
            Chrome 151 does not treat that base as definite — measured on a
            MacBook, the panel grew to its content (3755px in a 778px window)
            and carried the composer 3058px below the fold, with nothing to
            scroll it back.
          */}
          <div
            id={WORKSPACE_PANELS_ID}
            class="flex min-h-0 flex-1 flex-col overflow-hidden"
            classList={{ hidden: props.model.is("chat") }}
          >
            <Show when={props.model.mounted("context")}>
              <div
                id={workspaceTabPanelID("context")}
                role="tabpanel"
                aria-labelledby={workspaceTabID("context")}
                data-slot="session-workspace-panel"
                data-tab="context"
                class="flex min-h-0 flex-1 flex-col overflow-hidden"
                classList={{ hidden: !props.model.is("context") }}
                inert={!props.model.is("context") || undefined}
              >
                <ContextPanel />
              </div>
            </Show>

            <Show when={props.model.mounted("files")}>
              <div
                id={workspaceTabPanelID("files")}
                role="tabpanel"
                aria-labelledby={workspaceTabID("files")}
                data-slot="session-workspace-panel"
                data-tab="files"
                class="flex min-h-0 flex-1 flex-col overflow-hidden"
                classList={{ hidden: !props.model.is("files") }}
                inert={!props.model.is("files") || undefined}
              >
                <FilesPanel review={props.review} />
              </div>
            </Show>

            <Show when={props.model.mounted("browser")}>
              <div
                id={workspaceTabPanelID("browser")}
                role="tabpanel"
                aria-labelledby={workspaceTabID("browser")}
                data-slot="session-workspace-panel"
                data-tab="browser"
                class="flex min-h-0 flex-1 flex-col overflow-hidden"
                classList={{ hidden: !props.model.is("browser") }}
                inert={!props.model.is("browser") || undefined}
              >
                <BrowserPanel active={props.model.is("browser")} />
              </div>
            </Show>
          </div>

          <Show when={props.panels}>{(panels) => <div>{panels()()}</div>}</Show>
        </SessionPanelFrame>
      </div>
    </div>
  )
}
