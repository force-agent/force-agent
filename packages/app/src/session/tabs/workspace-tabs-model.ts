import { createComputed, createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

import {
  DEFAULT_WORKSPACE_TAB,
  WORKSPACE_TABS,
  isWorkspaceTab,
  type WorkspaceTabID,
} from "@/session/tabs/workspace-tab"

type WorkspaceTabState = {
  current: Accessor<WorkspaceTabID>
  set: (tab: WorkspaceTabID) => void
}

/**
 * Which workspace tab is showing, and which ones stay mounted.
 *
 * Mounting is *sticky*: `chat` is mounted from the start and never unmounts —
 * tearing it down would lose scroll position, in-flight streaming and unsent
 * composer text. The other tabs mount on first activation and then stay.
 * Hiding a mounted tab is `hidden` + `inert`, never `<Show>`: Kobalte briefly
 * selects a neighbouring tab while triggers reconcile, and a `<Show>` would
 * dispose the panel and reset its scroll (the same reason already documented
 * for `fileBrowserMounted` in files/session-side-panel.tsx).
 */
export function createWorkspaceTabsModel(input: {
  sessionKey: Accessor<string>
  view: Accessor<WorkspaceTabState>
  filesVisible?: Accessor<boolean>
  isDesktop: Accessor<boolean>
}) {
  const [mountedTabs, setMountedTabs] = createStore<Record<string, boolean>>({
    [DEFAULT_WORKSPACE_TAB]: true,
  })

  createComputed((previous) => {
    const key = input.sessionKey()
    if (previous !== undefined && previous !== key) {
      for (const tab of WORKSPACE_TABS) {
        if (tab === DEFAULT_WORKSPACE_TAB) continue
        if (mountedTabs[tab]) setMountedTabs(tab, false)
      }
    }
    return key
  })

  const all = createMemo<WorkspaceTabID[]>(() => {
    // Mobile keeps its own tab strip (review/view.tsx); this bar is desktop-only.
    if (!input.isDesktop()) return ["chat"]
    return [...WORKSPACE_TABS]
  })

  const active = createMemo<WorkspaceTabID>(() => {
    const stored = input.view().current()
    // A persisted tab can become invalid: a retired tab (`diffs`), files get
    // hidden in settings, or the viewport drops to mobile. Fall back instead of showing nothing.
    if (isWorkspaceTab(stored) && all().includes(stored)) return stored
    return DEFAULT_WORKSPACE_TAB
  })

  // The active tab is always mounted, whatever selected it: a persisted tab on
  // reload or a programmatic `view.set` (e.g. the sidebar's browser preview)
  // would otherwise show an empty panel until the user clicked the trigger.
  createComputed(() => {
    const tab = active()
    if (!mountedTabs[tab]) setMountedTabs(tab, true)
  })

  const set = (tab: WorkspaceTabID) => {
    if (!all().includes(tab)) return
    if (!mountedTabs[tab]) setMountedTabs(tab, true)
    input.view().set(tab)
  }

  return {
    all,
    active,
    set,
    focus: set,
    mounted: (tab: WorkspaceTabID) => tab === DEFAULT_WORKSPACE_TAB || !!mountedTabs[tab],
    is: (tab: WorkspaceTabID) => active() === tab,
  }
}

export type WorkspaceTabsModel = ReturnType<typeof createWorkspaceTabsModel>
