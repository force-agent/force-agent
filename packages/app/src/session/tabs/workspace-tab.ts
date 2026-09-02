/**
 * The tabs that sit above the chat column.
 *
 * DOM ids are a test contract. The panels wrapper id (`review-panel`) is
 * scoped by E2E specs and benchmarks; it outlived the Diffs tab it was named
 * after (the Files tab absorbed the review).
 */
export const WORKSPACE_TABS = ["chat", "context", "files", "browser"] as const

export type WorkspaceTabID = (typeof WORKSPACE_TABS)[number]

export const DEFAULT_WORKSPACE_TAB: WorkspaceTabID = "chat"

export function isWorkspaceTab(value: unknown): value is WorkspaceTabID {
  return typeof value === "string" && (WORKSPACE_TABS as readonly string[]).includes(value)
}

/** Wrapper around every non-chat panel. */
export const WORKSPACE_PANELS_ID = "review-panel"

const TRIGGER_IDS: Record<WorkspaceTabID, string> = {
  chat: "session-workspace-tab-chat",
  context: "session-workspace-tab-context",
  files: "session-workspace-tab-files",
  browser: "session-workspace-tab-browser",
}

const PANEL_IDS: Record<WorkspaceTabID, string> = {
  chat: "session-workspace-tabpanel-chat",
  context: "session-workspace-tabpanel-context",
  files: "session-workspace-tabpanel-files",
  browser: "session-workspace-tabpanel-browser",
}

export function workspaceTabID(tab: WorkspaceTabID): string {
  return TRIGGER_IDS[tab]
}

export function workspaceTabPanelID(tab: WorkspaceTabID): string {
  return PANEL_IDS[tab]
}
