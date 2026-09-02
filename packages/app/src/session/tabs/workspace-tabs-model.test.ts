import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

import { createWorkspaceTabsModel } from "@/session/tabs/workspace-tabs-model"
import {
  WORKSPACE_PANELS_ID,
  WORKSPACE_TABS,
  isWorkspaceTab,
  workspaceTabID,
  workspaceTabPanelID,
} from "@/session/tabs/workspace-tab"
import type { WorkspaceTabID } from "@/session/tabs/workspace-tab"

/**
 * Note on shape: each case builds its own model with the state it wants, instead
 * of mutating a shared one and re-reading. Under `bun test` there is no Solid
 * scheduler, so a `createMemo` never recomputes after its sources change — the
 * same reason the sibling suites (composer/comments.test.ts) assert against
 * store writes rather than derived signals. The store-backed parts of this model
 * (`mounted`) do propagate, so those are exercised with mutation.
 */
function build(overrides?: { isDesktop?: boolean; stored?: WorkspaceTabID; sessionKey?: string }) {
  const [sessionKey, setSessionKey] = createSignal(overrides?.sessionKey ?? "server/ses_a")
  const [stored, setStored] = createSignal<WorkspaceTabID>(overrides?.stored ?? "chat")

  const model = createWorkspaceTabsModel({
    sessionKey,
    view: () => ({ current: stored, set: setStored }),
    isDesktop: () => overrides?.isDesktop ?? true,
  })

  return { model, stored, setSessionKey }
}

describe("workspace tab ids", () => {
  test("keeps the legacy review-panel wrapper id and avoids the old side-panel ids", () => {
    expect(WORKSPACE_PANELS_ID).toBe("review-panel")
    const taken = [
      "session-side-panel-review-tab",
      "session-side-panel-review-tabpanel",
      "session-side-panel-file-browser-tabpanel",
      "file-tree-panel",
    ]
    for (const tab of WORKSPACE_TABS) {
      expect(taken).not.toContain(workspaceTabID(tab))
      expect(taken).not.toContain(workspaceTabPanelID(tab))
    }
  })

  test("gives every tab a distinct trigger and panel id", () => {
    const ids = WORKSPACE_TABS.flatMap((tab) => [workspaceTabID(tab), workspaceTabPanelID(tab)])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("rejects anything that is not a known tab", () => {
    expect(isWorkspaceTab("chat")).toBe(true)
    expect(isWorkspaceTab("review")).toBe(false)
    // Retired with the Files tab absorbing the review.
    expect(isWorkspaceTab("diffs")).toBe(false)
    expect(isWorkspaceTab(undefined)).toBe(false)
    expect(isWorkspaceTab(3)).toBe(false)
  })
})

describe("visible tabs", () => {
  test("offers the four desktop tabs, with no Diffs tab", () => {
    createRoot((dispose) => {
      expect(build().model.all()).toEqual(["chat", "context", "files", "browser"])
      dispose()
    })
  })

  test("collapses to chat on mobile, which keeps its own strip", () => {
    createRoot((dispose) => {
      expect(build({ isDesktop: false }).model.all()).toEqual(["chat"])
      dispose()
    })
  })
})

describe("active tab", () => {
  test("restores the persisted tab when it is still available", () => {
    createRoot((dispose) => {
      const { model } = build({ stored: "files" })
      expect(model.active()).toBe("files")
      expect(model.is("files")).toBe(true)
      dispose()
    })
  })

  test("falls back to chat when the persisted tab is no longer offered", () => {
    createRoot((dispose) => {
      // Session had the retired Diffs tab persisted from an older build.
      expect(build({ stored: "diffs" as WorkspaceTabID }).model.active()).toBe("chat")
      dispose()
    })
  })

  test("falls back to chat on mobile even with a desktop tab persisted", () => {
    createRoot((dispose) => {
      expect(build({ stored: "files", isDesktop: false }).model.active()).toBe("chat")
      dispose()
    })
  })

  test("ignores a persisted value that is not a tab at all", () => {
    createRoot((dispose) => {
      expect(build({ stored: "review" as WorkspaceTabID }).model.active()).toBe("chat")
      dispose()
    })
  })
})

describe("sticky mounting", () => {
  test("chat is mounted before anything is opened", () => {
    createRoot((dispose) => {
      const { model } = build()
      expect(model.mounted("chat")).toBe(true)
      expect(model.mounted("context")).toBe(false)
      expect(model.mounted("files")).toBe(false)
      dispose()
    })
  })

  test("a visited tab stays mounted after being left, so its scroll survives", () => {
    createRoot((dispose) => {
      const { model } = build()
      model.set("files")
      model.set("context")

      expect(model.mounted("files")).toBe(true)
      expect(model.mounted("context")).toBe(true)
      expect(model.mounted("chat")).toBe(true)
      // Never visited, so never paid for.
      expect(model.mounted("browser")).toBe(false)
      dispose()
    })
  })

  test("persists the tab through the view it was given", () => {
    createRoot((dispose) => {
      const { model, stored } = build()
      model.set("files")
      expect(stored()).toBe("files")
      dispose()
    })
  })

  test("refuses to activate or mount a tab that is not offered", () => {
    createRoot((dispose) => {
      const { model, stored } = build({ isDesktop: false })
      model.set("files")

      expect(stored()).toBe("chat")
      expect(model.mounted("files")).toBe(false)
      dispose()
    })
  })
})
