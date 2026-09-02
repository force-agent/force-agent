import { tabKey, type Tab } from "@/shell/tabs/tabs"

/**
 * How many session tabs a window keeps open.
 *
 * Mirrors MAX_PROMPT_SESSIONS (composer/persistence.tsx), the sibling LRU that already
 * bounds the same resource; sits below CLOSED_TAB_LIMIT (tabs/closed.ts) so a burst of
 * user closes still fits the reopen stack; and is well above the nine addressable by
 * mod+1..9.
 *
 * Eviction is safe because the nav sidebar lists every session from the server index,
 * not just open tabs — an evicted session is one click away.
 */
export const OPEN_SESSION_TAB_LIMIT = 20

/**
 * The least-recently-activated evictable session tab, or undefined when the store is
 * within the limit.
 *
 * Returns ONE victim per call by design: removeTab writes inside a startTransition, so
 * indices computed after a previous removal are not reliable. The caller re-runs on store
 * change until the count is under the limit.
 *
 * Store order is never touched — it is the user's drag order in the legacy strip, and
 * positional mod+1..9 must stay stable. Recency picks the victim, it does not reorder.
 */
export function selectTabToEvict(input: {
  tabs: readonly Tab[]
  /** Never evicted: the active tab, and tabs whose session is still being prepared. */
  protectedKeys: ReadonlySet<string>
  /** tabKey -> activation counter; missing means never activated this run. */
  recency: ReadonlyMap<string, number>
  limit: number
}): string | undefined {
  const sessions = input.tabs.filter((tab) => tab.type === "session")
  if (sessions.length <= input.limit) return undefined

  let victim: string | undefined
  let victimRecency = Number.POSITIVE_INFINITY
  for (const tab of sessions) {
    const key = tabKey(tab)
    if (input.protectedKeys.has(key)) continue
    const seen = input.recency.get(key) ?? 0
    // Ties break toward the earlier store position, so eviction is deterministic
    // after a reload, when no recency has been recorded yet.
    if (seen >= victimRecency) continue
    victim = key
    victimRecency = seen
  }
  return victim
}
