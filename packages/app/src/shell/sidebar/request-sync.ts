import { createEffect, onCleanup, type Accessor } from "solid-js"
import { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import { useTabs } from "@/shell/tabs/tabs"

/**
 * Re-hydrates permission and question state for background session tabs after a
 * reconnect.
 *
 * While the SSE stream is live the client store is written unguarded (permission.asked,
 * form.created in @opencode-ai/client data.ts), so background sessions stay fresh on
 * their own. What is lost is the reload/reconnect gap: permission.sync and form.sync run
 * only for the ACTIVE session (session/requests/model.ts). Those two feed the sidebar's
 * unread dot, so without this a background session that asked for permission while the
 * client was away shows nothing.
 *
 * Deliberately does NOT restore session.sync / message.sync / pending.sync per background
 * tab — the SSE stream covers those, and the timeline syncs on open.
 */
export function createSidebarRequestSync(input: {
  conn: Accessor<ServerConnection.Any>
  ctx: Accessor<ServerCtx | undefined>
  activeSessionID: Accessor<string | undefined>
}) {
  const tabs = useTabs()

  createEffect(() => {
    const ctx = input.ctx()
    if (!ctx || ctx.sdk.connection.status() !== "connected") return

    const key = ServerConnection.key(input.conn())
    const active = input.activeSessionID()
    const ids = tabs.store.flatMap((tab) =>
      tab.type === "session" && tab.server === key && tab.sessionId !== active ? [tab.sessionId] : [],
    )
    if (ids.length === 0) return

    const timers = ids.map((id, index) =>
      window.setTimeout(
        () =>
          void Promise.allSettled([
            ctx.data.session.permission.sync(id),
            ctx.data.session.form.sync(id),
          ]),
        300 + index * 50,
      ),
    )
    onCleanup(() => timers.forEach((timer) => window.clearTimeout(timer)))
  })
}
