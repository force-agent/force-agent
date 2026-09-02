import type { SessionInfo } from "@opencode-ai/client/promise"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQueryClient } from "@tanstack/solid-query"
import { startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { addProjectsToContext } from "@/home/model"
import { exportSessionToFile, removeSession, renameSession } from "@/home/sessions/actions"
import { useLanguage } from "@/runtime/i18n/language"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal, type ServerCtx } from "@/runtime/server/runtime"
import { useSettingsCommand } from "@/settings/command"
import { closeHomeProject, errorMessage, homeProjectDirectories } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { type LocalProject, useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { pathKey } from "@/workspaces/path-key"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { activeServerKey, serverSectionCollapsed } from "./sessions"

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

/**
 * Controller for the persistent left navigation sidebar (projects → sessions tree).
 * Navigation still goes through the tabs store (MRU backbone): opening a session
 * registers/selects a tab exactly like the home screen does.
 */
export function createNavSidebarController() {
  const global = useGlobal()
  const servers = useServers()
  const tabs = useTabs()
  const layout = useLayout()
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const pickDirectory = useDirectoryPicker()
  const openSettings = useSettingsCommand()

  const [tree, setTree] = persisted(
    Persist.global("navSidebar.tree"),
    createStore({ collapsedServers: {} as Record<string, boolean> }),
  )

  const actionDeps = { language, queryClient }

  function context(conn: ServerConnection.Any): ServerCtx {
    return global.ensureServerCtx(conn)
  }

  function openSession(conn: ServerConnection.Any, session: SessionInfo) {
    const ctx = context(conn)
    const directoryKey = pathKey(session.location.directory)
    const project = ctx.projects
      .list()
      .find(
        (item) =>
          pathKey(item.worktree) === directoryKey ||
          item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
      )
    const directory = project?.worktree ?? session.location.directory
    ctx.data.session.remember(session)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    void startTransition(() => {
      const descriptor = { server: ServerConnection.key(conn), sessionId: session.id }
      const tab = tabs.addSessionTab(descriptor)
      // The strip's SessionTabEntry normally writes this; it never mounts in sidebar mode,
      // so without it the persisted tab info stays empty and the identity header loses its
      // offline/slow-server fallback. (addSessionTab's return widens to Tab.)
      tabs.rememberSessionInfo({ type: "session", ...descriptor }, session)
      tabs.select(tab)
    })
  }

  function newSession(conn: ServerConnection.Any, directory?: string) {
    const ctx = context(conn)
    const target =
      directory ??
      activeDirectory(conn) ??
      ctx.projects.list().find((project) => project.worktree === ctx.projects.last())?.worktree ??
      ctx.projects.list()[0]?.worktree
    if (!target) {
      addProject(conn)
      return
    }
    ctx.projects.open(target)
    ctx.projects.touch(target)
    void tabs.newDraft({ server: ServerConnection.key(conn), directory: target })
  }

  /** Server the current route belongs to, falling back to the first visible one. */
  function activeServer(): ServerConnection.Any | undefined {
    const key = activeServerKey(layout.route(), tabs.store)
    return (key && servers.visible.find((conn) => ServerConnection.key(conn) === key)) ?? servers.visible[0]
  }

  /** Directory of the session or draft currently on screen, if it belongs to this server. */
  function activeDirectory(conn: ServerConnection.Any): string | undefined {
    const route = layout.route()
    const key = ServerConnection.key(conn)
    if (activeServerKey(route, tabs.store) !== key) return undefined
    if (route.type === "draft") {
      const draft = tabs.store.find((tab) => tab.type === "draft" && tab.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") {
      return context(conn).data.session.get(route.sessionId)?.location.directory
    }
    return undefined
  }

  function addProject(conn: ServerConnection.Any) {
    if (global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        const dirs = homeProjectDirectories(result)
        if (dirs.length === 0) return
        addProjectsToContext(context(conn), dirs)
      },
    })
  }

  const canRevealProject = (conn: ServerConnection.Any) =>
    platform.platform === "desktop" && !!platform.openPath && ServerConnection.local(conn)

  return {
    language,
    servers: {
      list: () => servers.visible,
      health: (conn: ServerConnection.Any) => global.servers.health[ServerConnection.key(conn)],
      context,
      active: activeServer,
      collapsed: (conn: ServerConnection.Any) =>
        serverSectionCollapsed(tree.collapsedServers, ServerConnection.key(conn), servers.visible.length > 1),
      toggleCollapsed: (conn: ServerConnection.Any) => {
        if (servers.visible.length <= 1) return
        const key = ServerConnection.key(conn)
        setTree("collapsedServers", key, !tree.collapsedServers[key])
      },
    },
    projects: {
      list: (conn: ServerConnection.Any) => context(conn).projects.list(),
      expanded: (project: LocalProject) => project.expanded,
      toggleExpanded: (conn: ServerConnection.Any, project: LocalProject) => {
        const projects = context(conn).projects
        if (project.expanded) projects.collapse(project.worktree)
        else projects.expand(project.worktree)
      },
      unseenCount: (conn: ServerConnection.Any, project: LocalProject) => {
        const notification = context(conn).notification
        return directories(project).reduce((total, directory) => total + notification.project.unseenCount(directory), 0)
      },
      clearNotifications: (conn: ServerConnection.Any, project: LocalProject) => {
        const notification = context(conn).notification
        directories(project)
          .filter((directory) => notification.project.unseenCount(directory) > 0)
          .forEach((directory) => notification.project.markViewed(directory))
      },
      add: addProject,
      close: (conn: ServerConnection.Any, directory: string) => {
        const next = closeHomeProject(
          layout.home.selection(),
          ServerConnection.key(conn),
          context(conn).projects,
          directory,
        )
        if (next) layout.home.setSelection(next)
      },
      canReveal: canRevealProject,
      reveal: (conn: ServerConnection.Any, project: LocalProject) => {
        if (!platform.openPath || !canRevealProject(conn)) return
        platform.openPath(project.worktree).catch((cause: unknown) =>
          showToast({
            title: language.t("common.requestFailed"),
            description: errorMessage(cause, language.t("common.requestFailed")),
          }),
        )
      },
      edit: (conn: ServerConnection.Any, project: LocalProject) => {
        void import("@/settings/workspaces/project-dialog").then(({ DialogEditProject }) => {
          void dialog.show(() => <DialogEditProject server={conn} project={project} />)
        })
      },
    },
    session: {
      open: openSession,
      create: newSession,
      rename: (conn: ServerConnection.Any, session: SessionInfo, title: string) =>
        renameSession(actionDeps, conn, context(conn), session, title),
      remove: (conn: ServerConnection.Any, session: SessionInfo) =>
        removeSession(actionDeps, conn, context(conn), session),
      export: (conn: ServerConnection.Any, session: SessionInfo) =>
        exportSessionToFile(actionDeps, context(conn), session),
      /** Keep persisted tab info fresh for open tabs (see rememberSessionInfo in openSession). */
      rememberInfo: (conn: ServerConnection.Any, sessions: readonly SessionInfo[]) => {
        const key = ServerConnection.key(conn)
        for (const tab of tabs.store) {
          if (tab.type !== "session" || tab.server !== key) continue
          const session = sessions.find((item) => item.id === tab.sessionId)
          if (session) tabs.rememberSessionInfo({ ...tab }, session)
        }
      },
    },
    utility: {
      settings: openSettings,
    },
  }
}

export type NavSidebarController = ReturnType<typeof createNavSidebarController>
