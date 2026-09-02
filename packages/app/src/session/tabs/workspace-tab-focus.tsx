import { createEffect, onCleanup, type Accessor } from "solid-js"

/**
 * Lets chrome that lives outside `SessionScreen` (the header's review toggle,
 * commands, the context-usage button) activate a workspace tab through the
 * *model* that owns it.
 *
 * Writing `view().workspaceTab` directly is not enough: the model marks a tab
 * mounted inside `set()`, and only that mark makes the panel exist. A direct
 * write moves the selection without ever mounting the panel — the tab reads as
 * selected and the panel area stays empty.
 *
 * This registry is process-global and keyed by the session key so portals
 * (the titlebar lives outside the session provider tree) still resolve.
 */
export type WorkspaceTabFocus = (tab: string) => void

const focusers: Record<string, WorkspaceTabFocus | undefined> = {}

export function registerWorkspaceTabFocus(key: Accessor<string>, focus: WorkspaceTabFocus) {
  createEffect(() => {
    const k = key()
    focusers[k] = focus
    onCleanup(() => delete focusers[k])
  })
}

export function focusWorkspaceTab(key: string, tab: string) {
  focusers[key]?.(tab)
}

// Back-compat for the earlier context-based API — no longer used, but keep the
// export so stray imports don't break.
export const WorkspaceTabFocusProvider = ({ children }: { children: unknown }) => children as unknown as never
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const useWorkspaceTabFocus = () => undefined
