import { createEffect, type Accessor } from "solid-js"
import { tabKey, useTabs, type Tab } from "@/shell/tabs/tabs"
import { OPEN_SESSION_TAB_LIMIT, selectTabToEvict } from "./capacity"

/**
 * Bounds the persisted tab store.
 *
 * With the nav sidebar as the default navigation, nothing in the UI closes tabs, so the
 * store would otherwise accumulate every session ever opened in the window. Hosted in the
 * titlebar because that is the one place that observes EVERY activation (route effect,
 * sidebar, command palette and notifications all funnel through it) and it mounts in both
 * layouts.
 *
 * Uses removeTab, not closeTab: an evicted tab was not closed by the user, so it must not
 * enter the reopen stack. removeTab already disposes tab memory, persisted info and draft
 * state, and does not navigate for a non-active tab.
 */
export function useTabCapacity(input: { currentTab: Accessor<Tab | undefined> }) {
  const tabs = useTabs()
  const recency = new Map<string, number>()
  let counter = 0

  createEffect(() => {
    const tab = input.currentTab()
    if (tab) recency.set(tabKey(tab), ++counter)
  })

  createEffect(() => {
    if (!tabs.ready()) return
    const current = input.currentTab()
    // On the home route nothing is active; evicting blind could drop the tab the user is
    // about to return to, so wait until something is activated.
    if (!current) return

    const live = new Set(tabs.store.map(tabKey))
    for (const key of [...recency.keys()]) if (!live.has(key)) recency.delete(key)

    const protectedKeys = new Set<string>([tabKey(current)])
    for (const tab of tabs.store) {
      if (tab.type !== "session") continue
      if (tabs.pendingSession(tab.server, tab.sessionId)) protectedKeys.add(tabKey(tab))
    }

    const victim = selectTabToEvict({
      tabs: tabs.store,
      protectedKeys,
      recency,
      limit: OPEN_SESSION_TAB_LIMIT,
    })
    if (!victim) return
    const index = tabs.store.findIndex((tab) => tabKey(tab) === victim)
    if (index !== -1) tabs.removeTab(index)
  })
}
