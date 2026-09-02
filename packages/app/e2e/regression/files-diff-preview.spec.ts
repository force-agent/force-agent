import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/FilesDiffPreview"
const projectID = "proj_files_diff_preview"
const sessionID = "ses_files_diff_preview"
const title = "Files diff preview"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

// The Files tab absorbed the review: a changed file opens as a diff (review
// viewer + expand/split toolbar), an unchanged one as plain contents, and the
// turn summary's "Review" row lands here with the first changed file open.
const SIDEBAR = '[data-slot="session-review-v2-sidebar"]'
const FILE_NAME = '[data-slot="session-review-v2-file-name"]'
const TOOLBAR = '[data-slot="session-review-v2-toolbar"]'

async function openSession(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
}

async function openFilesTab(page: Page) {
  await page.locator('[data-slot="session-workspace-tabs-bar"] [data-tab="files"]').click()
  const panel = page.locator("#session-workspace-tabpanel-files")
  await expect(panel).toBeVisible()
  return { panel, sidebar: panel.locator(SIDEBAR) }
}

test("changed file opens as a diff with the review toolbar", async ({ page }) => {
  await setup(page)
  await openSession(page)
  const { panel, sidebar } = await openFilesTab(page)

  await expect(panel.getByRole("button", { name: "Git changes" })).toBeVisible()
  await sidebar.getByRole("button", { name: "review.ts" }).click()
  await expect(panel.getByRole("tab", { name: "review.ts" })).toHaveAttribute("data-selected", "")
  await expect(panel.locator(FILE_NAME)).toHaveText("review.ts")
  await expect(panel.getByText("export const value = 'after'", { exact: true })).toBeVisible()
  await expect(panel.getByText("export const value = 'before'", { exact: true })).toBeVisible()
  await expect(panel.locator(TOOLBAR)).toBeVisible()
  await expect(panel.getByRole("button", { name: "Show all lines" })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Unified diff" })).toBeVisible()
  await expect(panel.getByText("contents:src/review.ts", { exact: true })).toHaveCount(0)
})

test("unchanged file opens as plain contents, without the diff toolbar", async ({ page }) => {
  await setup(page)
  await openSession(page)
  const { panel, sidebar } = await openFilesTab(page)

  await panel.getByRole("button", { name: "Git changes" }).click()
  await page.getByRole("option", { name: "All files", exact: true }).click()
  await sidebar.getByRole("button", { name: "README.md" }).click()
  await expect(panel.getByRole("tab", { name: "README.md" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("contents:README.md", { exact: true })).toBeVisible()
  await expect(panel.locator(FILE_NAME)).toHaveCount(0)
  await expect(panel.locator(TOOLBAR)).toHaveCount(0)

  // Same "All files" mode: the changed file still previews as a diff.
  // The full tree starts collapsed, so expand `src` first.
  const srcRow = sidebar.locator('[data-slot="file-tree-v2-row"][data-path="src"]')
  await expect(srcRow).toHaveAttribute("aria-expanded", "false")
  await srcRow.click()
  await expect(srcRow).toHaveAttribute("aria-expanded", "true")
  await sidebar.getByRole("button", { name: "review.ts" }).click()
  await expect(panel.locator(FILE_NAME)).toHaveText("review.ts")
  await expect(panel.locator(TOOLBAR)).toBeVisible()
})

test("summary 'Review' lands on the Files tab with the changed file open", async ({ page }) => {
  await setup(page)
  await openSession(page)
  await expect(page.locator('[role="tab"][data-tab="chat"]')).toHaveAttribute("aria-selected", "true")

  await page.getByRole("button", { name: "Session details" }).click()
  const summary = page.locator('[data-component="session-summary-panel"]')
  await expect(summary).toBeVisible()
  await summary.getByRole("button", { name: /1 Changed file/ }).click()

  await expect(page.locator('[role="tab"][data-tab="files"]')).toHaveAttribute("aria-selected", "true")
  const panel = page.locator("#session-workspace-tabpanel-files")
  await expect(panel.getByRole("button", { name: "Git changes" })).toBeVisible()
  await expect(panel.getByRole("tab", { name: "review.ts" })).toHaveAttribute("data-selected", "")
  await expect(panel.locator(FILE_NAME)).toHaveText("review.ts")
  await expect(panel.getByText("export const value = 'after'", { exact: true })).toBeVisible()
})

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "files-diff-preview",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    vcsDiff: [
      {
        file: "src/review.ts",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch:
          "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -1,3 +1,3 @@\n export const first = 1\n-export const value = 'before'\n+export const value = 'after'\n export const last = 3\n",
      },
    ],
    fileList: (path) => {
      if (path === "src") return [fileNode("src/review.ts")]
      if (path) return []
      return [fileNode("README.md"), dirNode("src")]
    },
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    pageMessages: () => ({ items: [] }),
  })

  await page.addInitScript(
    ({ directory, server, sessionID }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:review-panel-v2",
        JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { directory, server, sessionID },
  )
}

function fileNode(path: string) {
  return {
    name: path.split("/").pop() ?? path,
    path,
    absolute: `${directory}/${path}`,
    type: "file" as const,
    ignored: false,
  }
}

function dirNode(path: string) {
  return {
    name: path,
    path,
    absolute: `${directory}/${path}`,
    type: "directory" as const,
    ignored: false,
  }
}
