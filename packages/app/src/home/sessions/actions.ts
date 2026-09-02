import type { SessionInfo } from "@opencode-ai/client/promise"
import type { useQueryClient } from "@tanstack/solid-query"
import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import type { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { removedSessionIDs } from "@/session/session-domain"
import { downloadSessionExport, fetchSessionExport, sessionExportFilename } from "@/session/commands/export"
import { sessionLabel } from "@/session/title"
import { showToast } from "@/shell/notifications/toast"

export interface SessionActionDeps {
  language: ReturnType<typeof useLanguage>
  queryClient: ReturnType<typeof useQueryClient>
}

/** Rename a session, keeping the store, the canonical record and the home-sessions query cache in sync. */
export async function renameSession(
  deps: SessionActionDeps,
  conn: ServerConnection.Any,
  ctx: ServerCtx,
  session: SessionInfo,
  title: string,
): Promise<boolean> {
  const next = title.trim()
  if (!next || next === sessionLabel(session)) return true
  return ctx.sdk.api.session
    .rename({ sessionID: session.id, title: next })
    .then(() => {
      ctx.data.session.remember({ ...(ctx.data.session.get(session.id) ?? session), title: next })
      // Rename advances time.updated server-side; re-sync the canonical
      // record so date grouping and ordering do not go stale.
      ctx.data.session.invalidate(session.id)
      void ctx.data.session.sync(session.id).catch(() => {})
      deps.queryClient.setQueryData<SessionInfo[]>(["home-sessions", conn], (current) =>
        current?.map((item) => (item.id === session.id ? { ...item, title: next } : item)),
      )
      return true
    })
    .catch((cause) => {
      showToast({
        title: deps.language.t("common.requestFailed"),
        description: errorMessage(cause, deps.language.t("common.requestFailed")),
      })
      return false
    })
}

/** Delete a session (and its subsessions); tab cleanup rides the SESSION_TABS_REMOVED_EVENT. */
export async function removeSession(
  deps: SessionActionDeps,
  conn: ServerConnection.Any,
  ctx: ServerCtx,
  session: SessionInfo,
): Promise<boolean> {
  const ids = [...removedSessionIDs(ctx.data.session.list(), session.id)]
  return ctx.data.session
    .remove(session.id)
    .then(() => {
      notifySessionTabsRemoved({
        server: ServerConnection.key(conn),
        directory: session.location.directory,
        sessionIDs: ids,
      })
      return true
    })
    .catch((cause) => {
      showToast({
        title: deps.language.t("session.delete.failed.title"),
        description: errorMessage(cause, deps.language.t("session.delete.failed.title")),
      })
      return false
    })
    .finally(() => {
      void deps.queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })
    })
}

/** Download a session export as a file, with success/failure toasts. */
export async function exportSessionToFile(
  deps: SessionActionDeps,
  ctx: ServerCtx,
  session: SessionInfo,
): Promise<void> {
  try {
    const data = await fetchSessionExport({ sessionID: session.id, api: ctx.sdk.api })
    const filename = sessionExportFilename(data.info)
    downloadSessionExport(filename, data)
    showToast({
      variant: "success",
      icon: "circle-check",
      title: deps.language.t("toast.session.export.success.title"),
      description: deps.language.t("toast.session.export.success.description", { filename }),
    })
  } catch (cause) {
    showToast({
      variant: "error",
      title: deps.language.t("toast.session.export.failed.title"),
      description:
        cause instanceof Error ? cause.message : deps.language.t("toast.session.export.failed.description"),
    })
  }
}
