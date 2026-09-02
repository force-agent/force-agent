import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Menu } from "@opencode-ai/ui/menu"
import { TextInput } from "@opencode-ai/ui/text-input"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { ServerConnection } from "@/runtime/server/registry"
import { useServerCtx } from "@/runtime/server/runtime"
import { displayName } from "@/shell/layout/helpers"
import { ProjectIcon } from "@/shell/layout/project-icon"
import { type LocalProject, type LayoutRoute, useLayout } from "@/shell/state/layout"
import { useTabs, type Tab } from "@/shell/tabs/tabs"
import { pathKey } from "@/workspaces/path-key"
import { createNavSidebarController, type NavSidebarController } from "./controller"
import { createServerSessionIndex, filterProjectSessions } from "./sessions"
import { createSidebarRequestSync } from "./request-sync"
import { NavSessionRow } from "./session-row"
import { ChannelIndicator } from "@/shell/titlebar/titlebar"
import { usePlatform } from "@/runtime/platform/platform"
import { useUpdaterAction } from "@/shell/updates/action"

/**
 * Persistent left navigation sidebar: projects → sessions tree in the middle,
 * Settings at the bottom. Replaces the visible tab strip; the tabs store keeps
 * working underneath as the MRU/draft backbone.
 */
export function NavSidebar(props: {
  /** The topbar is collapsed (web build): its DEV/BETA badge moves to the title row here. */
  titlebarHidden?: boolean
  debugTools?: { visible: boolean; toggle: () => void }
}) {
  const controller = createNavSidebarController()
  const language = controller.language
  const layout = useLayout()
  const tabs = useTabs()
  const platform = usePlatform()
  const updater = useUpdaterAction()
  const [filter, setFilter] = createSignal("")
  const [searchOpen, setSearchOpen] = createSignal(false)

  const activeServer = createMemo(() => controller.servers.active())
  const multiServer = createMemo(() => controller.servers.list().length > 1)
  const home = createMemo(() => layout.route().type === "home")

  // The button reads "Update to X" without a click when a newer version is out: ask once per
  // page load on the web (the desktop updater already checks on its own schedule).
  onMount(() => {
    if (platform.platform === "desktop") return
    if (platform.updater?.state().status !== "idle") return
    void platform.updater.check().catch(() => undefined)
  })
  const updateLabel = () => {
    const state = platform.updater?.state()
    if (state?.status === "ready" || state?.status === "manual")
      return language.t("navSidebar.update.install", { version: state.version })
    if (state?.status === "checking" || state?.status === "installing" || state?.status === "restarting")
      return language.t(updater.action().label)
    return language.t("navSidebar.update.check")
  }

  return (
    <div data-slot="nav-sidebar-root" class="flex h-full min-h-0 w-full flex-col gap-2">
      <div class="flex shrink-0 items-center gap-0.5 px-1.5">
        <Show when={props.titlebarHidden}>
          <ChannelIndicator debugTools={props.debugTools} />
        </Show>
        {/* The title doubles as the way back to the home now that the topbar lost its
            Home button. Same toggle as mod+b: the titlebar keeps the recent tab remembered
            on every route change, so no current tab needs to be passed here. */}
        <button
          type="button"
          data-action="nav-home"
          class="flex-1 truncate text-left text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint hover:text-v2-text-text-muted"
          title={language.t("home.title")}
          aria-pressed={home()}
          onClick={() => tabs.toggleHome({ home: home() })}
        >
          {language.t("navSidebar.title")}
        </button>
        {/* Search is a toggle, not a permanent field: an always-on input costs a full
            row of a dense sidebar even when nobody is filtering. */}
        <Tooltip placement="bottom" value={language.t("navSidebar.search.placeholder")}>
          <IconButton
            data-action="nav-sidebar-search"
            variant="ghost-muted"
            size="small"
            state={searchOpen() ? "pressed" : undefined}
            icon={<Icon name="magnifying-glass" />}
            aria-label={language.t("navSidebar.search.placeholder")}
            aria-expanded={searchOpen()}
            onClick={() => {
              const next = !searchOpen()
              setSearchOpen(next)
              if (!next) setFilter("")
            }}
          />
        </Tooltip>
        <Show when={!multiServer()}>
          <Tooltip placement="bottom" value={language.t("home.project.add")}>
            <IconButton
              data-action="nav-sidebar-add-project"
              variant="ghost-muted"
              size="small"
              icon={<Icon name="folder-add-left" />}
              aria-label={language.t("home.project.add")}
              onClick={() => {
                const conn = activeServer()
                if (conn) controller.projects.add(conn)
              }}
            />
          </Tooltip>
        </Show>
      </div>

      <Show when={searchOpen()}>
        <TextInput
          value={filter()}
          placeholder={language.t("navSidebar.search.placeholder")}
          autocomplete="off"
          spellcheck={false}
          // autofocus only fires on initial document parse; this input mounts on toggle.
          ref={(element: HTMLInputElement) => queueMicrotask(() => element.focus())}
          class="!w-full min-w-0 shrink-0"
          onInput={(event) => setFilter(event.currentTarget.value)}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            setFilter("")
            setSearchOpen(false)
          }}
        />
      </Show>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <For each={controller.servers.list()}>
          {(conn) => (
            <NavServerSection
              controller={controller}
              conn={conn}
              multiServer={multiServer()}
              filter={filter().trim().toLowerCase()}
              route={layout.route()}
            />
          )}
        </For>
      </div>

      <div class="shrink-0 border-t border-v2-border-border-muted pt-1.5">
        <Show when={platform.updater}>
          <button
            type="button"
            data-action="nav-sidebar-update"
            data-state={platform.updater?.state().status}
            class="flex h-7 w-full items-center gap-2 rounded-[6px] px-1.5 text-[12px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:cursor-default disabled:hover:bg-transparent"
            disabled={!updater.action().run}
            onClick={() => void updater.run()}
          >
            <Icon name="arrow-down-to-line" size="small" />
            <span class="min-w-0 flex-1 truncate text-left">{updateLabel()}</span>
          </button>
        </Show>
        <button
          type="button"
          data-action="nav-sidebar-settings"
          class="flex h-7 w-full items-center gap-2 rounded-[6px] px-1.5 text-[12px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
          onClick={() => controller.utility.settings()}
        >
          <Icon name="settings-gear" size="small" />
          {language.t("navSidebar.settings")}
        </button>
      </div>
    </div>
  )
}

function serverTitle(conn: ServerConnection.Any) {
  if (conn.displayName) return conn.displayName
  if (conn.type === "ssh") return conn.host
  try {
    return new URL(conn.http.url).host
  } catch {
    return conn.http.url
  }
}

function NavServerSection(props: {
  controller: NavSidebarController
  conn: ServerConnection.Any
  multiServer: boolean
  filter: string
  route: LayoutRoute
}) {
  const controller = props.controller
  const language = controller.language
  const tabs = useTabs()
  const ctx = useServerCtx(() => props.conn)
  const collapsed = () => controller.servers.collapsed(props.conn)
  const index = createServerSessionIndex({
    conn: () => props.conn,
    ctx,
    enabled: () => !collapsed(),
  })
  const projects = createMemo(() => controller.projects.list(props.conn))
  const key = () => ServerConnection.key(props.conn)
  const healthy = () => controller.servers.health(props.conn)?.healthy !== false

  const drafts = createMemo(() =>
    tabs.store.filter((tab): tab is Extract<Tab, { type: "draft" }> => tab.type === "draft" && tab.server === key()),
  )

  createEffect(() => controller.session.rememberInfo(props.conn, index.sessions()))
  createSidebarRequestSync({
    conn: () => props.conn,
    ctx,
    activeSessionID: () => (props.route.type === "session" ? props.route.sessionId : undefined),
  })

  // Sessions living in directories the client never registered as projects
  // (fresh browser, cleared storage) still deserve a row: synthesize a project
  // group per orphan directory. Opening one of its sessions registers the real
  // project via projects.open, which replaces the synthetic row.
  const [orphanExpanded, setOrphanExpanded] = createStore<Record<string, boolean>>({})
  const orphanProjects = createMemo<LocalProject[]>(() => {
    const known = new Set(
      projects().flatMap((project) => [pathKey(project.worktree), ...(project.sandboxes ?? []).map(pathKey)]),
    )
    const dirs = new Map<string, string>()
    for (const session of index.sessions()) {
      const dirKey = pathKey(session.location.directory)
      if (known.has(dirKey) || dirs.has(dirKey)) continue
      dirs.set(dirKey, session.location.directory)
    }
    return [...dirs.values()].map((worktree) => ({ worktree, expanded: orphanExpanded[pathKey(worktree)] ?? true }))
  })

  return (
    <div data-slot="nav-sidebar-server" class="flex flex-col">
      <Show when={props.multiServer}>
        <button
          type="button"
          class="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 text-[12px] font-medium text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"
          classList={{ "opacity-60": !healthy() }}
          aria-expanded={!collapsed()}
          onClick={() => controller.servers.toggleCollapsed(props.conn)}
        >
          <Icon
            name="chevron-down"
            size="small"
            class="shrink-0 text-v2-icon-icon-muted transition-transform duration-150"
            style={{ transform: `rotate(${collapsed() ? -90 : 0}deg)` }}
          />
          <span class="min-w-0 flex-1 truncate text-left">{serverTitle(props.conn)}</span>
          <Show when={!healthy()}>
            <span class="shrink-0 text-[11px] text-v2-text-text-faint">{language.t("navSidebar.server.offline")}</span>
          </Show>
          <Tooltip placement="bottom" value={language.t("home.project.add")}>
            <IconButton
              as="span"
              variant="ghost-muted"
              size="small"
              icon={<Icon name="folder-add-left" />}
              aria-label={language.t("home.project.add")}
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                controller.projects.add(props.conn)
              }}
            />
          </Tooltip>
        </button>
      </Show>

      <Show when={!collapsed()}>
        <Show
          when={projects().length > 0 || orphanProjects().length > 0}
          fallback={
            <button
              type="button"
              class="flex h-7 w-full items-center gap-2 rounded-[6px] px-1.5 text-[12px] text-v2-text-text-faint hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
              onClick={() => controller.projects.add(props.conn)}
            >
              <Icon name="folder-add-left" size="small" />
              {language.t("navSidebar.empty.projects")}
            </button>
          }
        >
          <For each={projects()}>
            {(project) => (
              <NavProjectSection
                controller={controller}
                conn={props.conn}
                project={project}
                sessions={index.sessions()}
                loading={index.loading()}
                drafts={drafts()}
                filter={props.filter}
                route={props.route}
              />
            )}
          </For>
          <For each={orphanProjects()}>
            {(project) => (
              <NavProjectSection
                controller={controller}
                conn={props.conn}
                project={project}
                sessions={index.sessions()}
                loading={index.loading()}
                drafts={drafts()}
                filter={props.filter}
                route={props.route}
                onToggleExpanded={() =>
                  setOrphanExpanded(pathKey(project.worktree), !(orphanExpanded[pathKey(project.worktree)] ?? true))
                }
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  )
}

function NavProjectSection(props: {
  controller: NavSidebarController
  conn: ServerConnection.Any
  project: LocalProject
  sessions: readonly SessionInfo[]
  loading: boolean
  drafts: Extract<Tab, { type: "draft" }>[]
  filter: string
  route: LayoutRoute
  onToggleExpanded?: () => void
}) {
  const controller = props.controller
  const language = controller.language
  const tabs = useTabs()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const expanded = () => controller.projects.expanded(props.project)
  const unseen = () => controller.projects.unseenCount(props.conn, props.project)
  const key = () => ServerConnection.key(props.conn)

  const filtered = createMemo(() =>
    filterProjectSessions({ sessions: props.sessions, project: props.project, filter: props.filter }),
  )

  const projectDrafts = createMemo(() =>
    props.drafts.filter((draft) => pathKey(draft.worktree ?? draft.directory) === pathKey(props.project.worktree)),
  )

  const sessionActive = (sessionID: string) => {
    const route = props.route
    if (route.type !== "session" || route.server !== key()) return false
    if (route.sessionId === sessionID) return true
    // Keep the parent row highlighted while a subsession is on screen.
    return tabs.store.some(
      (tab) =>
        tab.type === "session" &&
        tab.server === key() &&
        tab.sessionId === sessionID &&
        tab.routeSessionId === route.sessionId,
    )
  }

  return (
    <Show when={filtered().visible}>
      <div data-slot="nav-sidebar-project" class="flex flex-col">
        <div class="group/project relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 hover:bg-v2-overlay-simple-overlay-hover">
          <button
            type="button"
            class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
            aria-expanded={expanded()}
            onClick={() => {
              // Collapsing is not "viewing": only clear unread when the project opens.
              const opening = !expanded()
              if (props.onToggleExpanded) props.onToggleExpanded()
              else controller.projects.toggleExpanded(props.conn, props.project)
              if (opening && unseen() > 0) controller.projects.clearNotifications(props.conn, props.project)
            }}
          >
            <Icon
              name="chevron-down"
              size="small"
              class="shrink-0 text-v2-icon-icon-muted transition-transform duration-150"
              style={{ transform: `rotate(${expanded() ? 0 : -90}deg)` }}
            />
            <ProjectIcon project={props.project} class="size-4 shrink-0" />
            <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-v2-text-text-base">
              {displayName(props.project)}
            </span>
            <Show when={unseen() > 0}>
              <span
                data-slot="nav-sidebar-project-unseen"
                class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-v2-icon-icon-accent px-1 text-[10px] font-medium text-v2-text-text-inverted"
              >
                {unseen()}
              </span>
            </Show>
          </button>
          <div class="hidden shrink-0 group-hover/project:flex" classList={{ "!flex": menuOpen() }}>
            <Menu gutter={4} modal={false} placement="bottom-end" open={menuOpen()} onOpenChange={setMenuOpen}>
              <Menu.Trigger
                as={IconButton}
                data-action="nav-sidebar-project-menu"
                variant="ghost-muted"
                size="small"
                icon={<Icon name="outline-dots" />}
                aria-label={language.t("common.moreOptions")}
              />
              <Menu.Portal>
                <Menu.Content>
                  <Menu.Item onSelect={() => controller.session.create(props.conn, props.project.worktree)}>
                    {language.t("command.session.new")}
                  </Menu.Item>
                  <Menu.Item onSelect={() => controller.projects.edit(props.conn, props.project)}>
                    {language.t("dialog.project.edit.title")}
                  </Menu.Item>
                  <Show when={controller.projects.canReveal(props.conn)}>
                    <Menu.Item onSelect={() => controller.projects.reveal(props.conn, props.project)}>
                      {language.t("navSidebar.project.reveal")}
                    </Menu.Item>
                  </Show>
                  <Menu.Separator />
                  <Menu.Item onSelect={() => controller.projects.close(props.conn, props.project.worktree)}>
                    {language.t("common.close")}
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu>
          </div>
        </div>

        <Show when={expanded()}>
          <div class="flex flex-col pl-4">
            <For each={projectDrafts()}>
              {(draft) => (
                <div
                  data-slot="nav-sidebar-draft-row"
                  data-active={props.route.type === "draft" && props.route.draftID === draft.draftID ? "" : undefined}
                  class="group/draft flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[6px] pl-2 pr-1 text-[12px] italic text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover data-[active]:bg-v2-overlay-simple-overlay-pressed data-[active]:text-v2-text-text-base"
                >
                  <button
                    type="button"
                    class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => tabs.select(draft)}
                  >
                    <Icon name="pencil-line" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                    <span class="min-w-0 flex-1 truncate">{language.t("command.session.new")}</span>
                  </button>
                  <IconButton
                    class="hidden group-hover/draft:flex"
                    variant="ghost-muted"
                    size="small"
                    icon={<Icon name="close-small" />}
                    aria-label={language.t("common.close")}
                    onClick={() => {
                      const idx = tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === draft.draftID)
                      if (idx !== -1) tabs.closeTab(idx)
                    }}
                  />
                </div>
              )}
            </For>
            <Show
              when={filtered().sessions.length > 0 || props.loading}
              fallback={
                <div class="flex h-7 items-center px-2 text-[11px] text-v2-text-text-faint">
                  {language.t("navSidebar.empty.sessions")}
                </div>
              }
            >
              <For each={filtered().sessions}>
                {(session) => (
                  <NavSessionRow
                    conn={props.conn}
                    session={session}
                    active={sessionActive(session.id)}
                    onOpen={() => controller.session.open(props.conn, session)}
                    onRename={(title) => controller.session.rename(props.conn, session, title)}
                    onDelete={() => controller.session.remove(props.conn, session)}
                    onExport={() => controller.session.export(props.conn, session)}
                  />
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
