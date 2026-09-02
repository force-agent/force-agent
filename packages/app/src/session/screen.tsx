import { ErrorBoundary, Show, Match, Switch, createEffect, createMemo, createComputed, on } from "solid-js"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { SessionHeader } from "@/session/header/session-header"
import { useLayout } from "@/shell/state/layout"
import { useSettings } from "@/settings/model"
import { MessageTimeline } from "@/session/timeline/message-timeline"
import type { SessionModel } from "@/session/model"
import { SessionPanelFrame } from "@/session/session-frame"
import { SessionSidebar } from "@/session/sidebar/sidebar"
import { useUsageExceededDialogs } from "./usage-exceeded-dialogs"
import { SessionErrorFallback } from "./route-error"
import { createSessionScreenLayout } from "./screen-layout"
import { createSessionReview } from "./review/model"
import { SessionMobileReview, SessionMobileTabs } from "./review/view"
import { createSessionTimelineInteraction } from "./timeline/interaction"
import { ActiveSessionComposerRegion, createActiveSessionRegion } from "./composer/region"
import { SessionIdentityHeader } from "./session-identity-header"
import { SessionWorkspaceTabs, WORKSPACE_TABS_BAR_HEIGHT } from "./tabs/workspace-tabs"
import { createWorkspaceTabsModel } from "./tabs/workspace-tabs-model"
import { registerWorkspaceTabFocus } from "./tabs/workspace-tab-focus"

export function SessionScreen(props: { session: SessionModel }) {
  const session = props.session
  const layout = useLayout()
  const settings = useSettings()
  const isDesktop = session.isDesktop
  const screen = createSessionScreenLayout(session)
  const timeline = createSessionTimelineInteraction(session)
  const messagesReady = timeline.ready
  const [store, setStore] = createStore({
    deferRender: false,
  })

  createComputed((prev) => {
    const key = session.identity.sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      const owner = session.ownership.capture()
      requestAnimationFrame(() => {
        setTimeout(() => owner.run(() => setStore("deferRender", false)), 0)
      })
    }
    return key
  })
  const review = createSessionReview({ session, screen, deferRender: () => store.deferRender })

  const workspaceTabs = createWorkspaceTabsModel({
    sessionKey: session.identity.sessionKey,
    view: () => session.layout.view().workspaceTab,
    isDesktop,
  })
  // Chrome outside this screen (header toggle, commands) activates a tab through
  // the model, not by writing the view directly — only `set()` mounts the panel.
  registerWorkspaceTabFocus(
    () => session.identity.sessionKey(),
    (tab) => workspaceTabs.focus(tab as Parameters<typeof workspaceTabs.focus>[0]),
  )
  const composer = createActiveSessionRegion({
    session,
    screen,
    timeline,
  })

  useUsageExceededDialogs()

  const mobileTabsBottom = createMemo(() => !isDesktop() && settings.general.mobileTitlebarPosition() === "bottom")

  const sessionErrorFallback = (error: unknown, reset: () => void) => {
    createEffect(on(session.identity.sessionKey, reset, { defer: true }))
    return <SessionErrorFallback error={error} sessionID={session.identity.params.id} />
  }

  const sessionPanelContent = () => (
    <>
      <Show when={!isDesktop() && !!session.identity.params.id && !mobileTabsBottom()}>
        <SessionMobileTabs review={review} compact />
      </Show>
      {/* Surface query errors without suspending session metadata while messages load. */}
      <Show when={timeline.resource.error}>
        {(error) => {
          throw error()
        }}
      </Show>
      <div class="flex flex-1 min-h-0 flex-col overflow-hidden">
        <Switch>
          <Match when={session.identity.params.id && review.mobile.changes()}>
            <SessionMobileReview review={review} />
          </Match>
          <Match when={session.identity.params.id}>
            <Show when={!messagesReady()}>
              <SessionIdentityHeader sessionID={session.identity.params.id ?? ""} session={session.data.info()} />
            </Show>
            <Show when={messagesReady() ? session.identity.params.id : undefined} keyed>
              {(_id) => (
                <MessageTimeline
                  session={session}
                  background={composer.region.state.background}
                  actions={composer.actions.timeline}
                  scroll={timeline.scroll}
                  onResumeScroll={timeline.actions.resume}
                  setScrollRef={timeline.view.setScrollRef}
                  onScheduleScrollState={timeline.view.scheduleScrollState}
                  onPin={timeline.view.pin}
                  onUnpin={timeline.view.unpin}
                  onUserScroll={timeline.view.markUserScroll}
                  onHistoryScroll={timeline.view.onHistoryScroll}
                  onSelectionInteraction={timeline.view.selectionInteraction}
                  pinned={timeline.view.pinned()}
                  centered={screen.centered()}
                  setContentRef={timeline.view.setContentRef}
                  diffs={review.details.diffs}
                  onReview={review.openChanges}
                  workspaceMoveEligible={composer.workspaceMoveEligible()}
                  onSummaryOpenChange={review.details.setOpen}
                  anchor={timeline.view.anchor}
                  setRevealMessage={timeline.view.setRevealMessage}
                  setScrollToEnd={timeline.view.setScrollToEnd}
                />
              )}
            </Show>
          </Match>
        </Switch>
      </div>

      <Show when={!review.mobile.changes() ? session.identity.params.id : undefined} keyed>
        {(_id) => (
          <div class="shrink-0">
            <ActiveSessionComposerRegion
              model={composer}
              session={session}
              accentSubmit={session.workspace.current()}
              onResponseSubmit={timeline.actions.resume}
            />
          </div>
        )}
      </Show>
      <Show when={!!session.identity.params.id && mobileTabsBottom()}>
        <SessionMobileTabs review={review} compact bottom />
      </Show>
    </>
  )

  return (
    <>
      <SessionHeader />
      <div class="flex flex-1 min-h-0 flex-col gap-2 overflow-hidden px-2 pb-2 pt-[var(--shell-top-inset,8px)]">
        <div
          ref={screen.panel.ref}
          class="relative flex flex-1 min-h-0 flex-col gap-2 overflow-hidden md:flex-row"
          style={{ "--session-tabs-bar-height": `${WORKSPACE_TABS_BAR_HEIGHT}px` }}
        >
          <div
            classList={{
              "@container relative z-10 shrink-0 flex flex-col min-h-0 h-full flex-1 overflow-hidden md:flex-none transition-[width]": true,
              "duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !screen.size.active(),
            }}
            data-slot="session-chat-panel"
            style={{
              width: screen.panel.width(),
            }}
          >
            <Show when={!!session.identity.params.id}>
              <SessionWorkspaceTabs
                model={workspaceTabs}
                review={review}
                chat={() => <ErrorBoundary fallback={sessionErrorFallback}>{sessionPanelContent()}</ErrorBoundary>}
              />
            </Show>

            <Show when={screen.panel.resizable()}>
              <div onPointerDown={() => screen.size.start()}>
                <ResizeHandle
                  class="-end-1"
                  direction="horizontal"
                  size={screen.panel.resizedWidth()}
                  min={450}
                  max={screen.panel.max()}
                  onResize={(width) => {
                    screen.size.touch()
                    layout.session.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>

          {/* Always-on: the point of the strip is that agent activity never hides. */}
          <Show when={screen.extensions.open()}>
            <div
              data-slot="session-extensions-panel"
              class="relative z-10 hidden h-full min-h-0 shrink-0 flex-col md:flex"
              style={{
                width: `${screen.extensions.width()}px`,
                // Bar height plus the gap-2 SessionWorkspaceTabs puts between the bar and the
                // body, so this frame's top edge lines up with the chat body's, not the bar's.
                "padding-top": "calc(var(--session-tabs-bar-height, 0px) + 0.5rem)",
              }}
            >
              <SessionPanelFrame raised>
                <SessionSidebar session={session} mode={screen.extensions.mode()} />
              </SessionPanelFrame>
              <Show when={screen.extensions.mode() === "full"}>
                <ResizeHandle
                  class="-start-1"
                  direction="horizontal"
                  edge="start"
                  size={screen.extensions.width()}
                  min={screen.extensions.min}
                  max={screen.extensions.max()}
                  onResize={layout.extensions.resize}
                />
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </>
  )
}
