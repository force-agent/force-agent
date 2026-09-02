import type { SessionInfo } from "@opencode-ai/client/promise"
import { skipToken, useQuery } from "@tanstack/solid-query"
import { createMemo, type Accessor } from "solid-js"
import { loadHomeSessionIndex, mergeHomeSessionIndex, retainHomeSessions } from "@/home/sessions/index"
import type { LayoutRoute, LocalProject } from "@/shell/state/layout"
import type { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import { compareSessionTime, displayName } from "@/shell/layout/helpers"
import { pathKey } from "@/workspaces/path-key"
import { sessionLabel } from "@/session/title"
import type { Tab } from "@/shell/tabs/tabs"

const SESSION_LIMIT = 64
// Keep the large immutable result opaque so Solid Query does not recursively unwrap every session on mount.
const selectSessions = (sessions: SessionInfo[]) => () => sessions

/**
 * Per-server session index for the nav sidebar. Shares the queryKey and fetch
 * shape with the home screen (["home-sessions", conn]) so TanStack dedupes the
 * request and rename/delete invalidations refresh both surfaces.
 */
export function createServerSessionIndex(input: {
  conn: Accessor<ServerConnection.Any | undefined>
  ctx: Accessor<ServerCtx | undefined>
  enabled: Accessor<boolean>
}) {
  const sessionLoad = useQuery(() => {
    const ctx = input.ctx()
    const conn = input.conn()
    return {
      queryKey: ["home-sessions", conn] as const,
      enabled: input.enabled() && !!ctx && ctx.sdk.connection.status() === "connected",
      queryFn: ctx
        ? ({ signal }: { signal: AbortSignal }) =>
            loadHomeSessionIndex((query, options) => ctx.sdk.api.session.list(query, options), signal)
        : skipToken,
      retry: false,
      staleTime: 30_000,
      refetchOnMount: true,
      refetchOnReconnect: true,
      select: selectSessions,
    }
  })

  const sessions = createMemo(() => {
    const ctx = input.ctx()
    if (!ctx || !input.conn()) return []
    return retainHomeSessions(
      ctx.data.session.apply(
        mergeHomeSessionIndex(sessionLoad.isPending ? [] : (sessionLoad.data?.() ?? []), ctx.data.session.list()),
      ),
      SESSION_LIMIT,
      Date.now(),
    )
  })

  return { sessions, loading: () => sessionLoad.isPending }
}

/** Sessions belonging to one project (worktree + sandboxes), newest first. */
export function sessionsForProject(sessions: readonly SessionInfo[], project: LocalProject): SessionInfo[] {
  const keys = new Set([pathKey(project.worktree), ...(project.sandboxes ?? []).map(pathKey)])
  return sessions
    .filter((session) => keys.has(pathKey(session.location.directory)))
    .slice()
    .sort(compareSessionTime)
}

/**
 * Whether a server section renders collapsed. The collapse toggle only exists in
 * multi-server mode, so a persisted `true` from a time when there were two servers
 * must not survive a drop to one — otherwise the sidebar renders empty with no
 * element able to expand it again.
 */
export function serverSectionCollapsed(
  flags: Record<string, boolean>,
  key: string,
  multiServer: boolean,
): boolean {
  if (!multiServer) return false
  return flags[key] ?? false
}

/**
 * Which sessions a project row shows under the current filter, and whether the row
 * shows at all. A filter matching the PROJECT name reveals the project with all of
 * its sessions — filtering them by the same term would render a matched project as
 * "No sessions yet".
 */
export function filterProjectSessions(input: {
  sessions: readonly SessionInfo[]
  project: LocalProject
  filter: string
}): { visible: boolean; sessions: SessionInfo[] } {
  const all = sessionsForProject(input.sessions, input.project)
  if (!input.filter) return { visible: true, sessions: all }
  if (displayName(input.project).toLowerCase().includes(input.filter)) return { visible: true, sessions: all }
  const matched = all.filter((session) => sessionLabel(session).toLowerCase().includes(input.filter))
  return { visible: matched.length > 0, sessions: matched }
}

/** Server the current route belongs to; undefined on home. */
export function activeServerKey(route: LayoutRoute, tabs: readonly Tab[]): ServerConnection.Key | undefined {
  if (route.type === "session") return route.server
  if (route.type === "draft") {
    const draft = tabs.find((tab) => tab.type === "draft" && tab.draftID === route.draftID)
    return draft?.type === "draft" ? draft.server : undefined
  }
  return undefined
}
