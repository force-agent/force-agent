import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/FilesPanelSingleTree"
const projectID = "proj_files_panel_single_tree"
const sessionID = "ses_files_panel_single_tree"
const title = "Files panel single tree"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

// The Files tab has exactly one tree, whatever the right pane is doing: the
// review sidebar (search box + changes-mode select + FileTreeV2). It browses
// the changed files in the diff modes and the whole workspace in "All files".
const SIDEBAR = '[data-slot="session-review-v2-sidebar"]'
const TREES = '[data-component="filetree"], [data-component="file-tree-v2"]'

async function openFilesTab(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.locator('[data-slot="session-workspace-tabs-bar"] [data-tab="files"]').click()
  const panel = page.locator("#session-workspace-tabpanel-files")
  await expect(panel).toBeVisible()
  const sidebar = panel.locator(SIDEBAR)
  await expect(sidebar).toHaveCount(1)
  return { panel, sidebar }
}

async function selectMode(page: Page, panel: Locator, from: string, to: string) {
  await panel.getByRole("button", { name: from }).click()
  await page.getByRole("option", { name: to, exact: true }).click()
  await expect(panel.getByRole("button", { name: to })).toBeVisible()
}

test("git mode: only changed files, with a badge; filter narrows the list", async ({ page }) => {
  await setup(page)
  const { panel, sidebar } = await openFilesTab(page)

  await expect(panel.getByRole("button", { name: "Git changes" })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "changed.ts" })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "README.md" })).toHaveCount(0)
  await expect(sidebar.locator('[data-slot="file-tree-v2-change"][data-change="added"]')).toHaveCount(1)
  await expect(panel.locator(TREES).locator("visible=true")).toHaveCount(1)

  const filter = panel.getByRole("combobox", { name: "Filter files" })
  await filter.fill("chang")
  await expect(sidebar.getByRole("option", { name: /changed\.ts/ })).toBeVisible()
  await filter.fill("zzz")
  await expect(sidebar.getByRole("option")).toHaveCount(0)
  await expect(sidebar.getByRole("status")).toBeVisible()
})

test("all files mode lists an unchanged file; filter reduces the tree", async ({ page }) => {
  await setup(page)
  const { panel, sidebar } = await openFilesTab(page)

  await selectMode(page, panel, "Git changes", "All files")
  await expect(sidebar.getByRole("button", { name: "README.md" })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "changed.ts" })).toBeVisible()
  await expect(panel.locator(SIDEBAR)).toHaveCount(1)

  const filter = panel.getByRole("combobox", { name: "Filter files" })
  await filter.fill("read")
  await expect(sidebar.getByRole("option", { name: /README\.md/ })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "changed.ts" })).toHaveCount(0)
  await expect(sidebar.getByRole("option", { name: /changed\.ts/ })).toHaveCount(0)
})

test("file open: still one sidebar, and it is the one that opened the file", async ({ page }) => {
  await setup(page)
  const { panel, sidebar } = await openFilesTab(page)

  await selectMode(page, panel, "Git changes", "All files")
  await sidebar.getByRole("button", { name: "README.md" }).click()
  await expect(panel.getByRole("tab", { name: "README.md" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("contents:README.md", { exact: true })).toBeVisible()
  await expect(panel.locator(SIDEBAR)).toHaveCount(1)
  await expect(panel.locator(TREES).locator("visible=true")).toHaveCount(1)
})

test('"Open file" picker active: still one sidebar, browsing the whole tree even in git mode', async ({ page }) => {
  await setup(page)
  const { panel, sidebar } = await openFilesTab(page)

  await expect(panel.getByRole("button", { name: "Git changes" })).toBeVisible()
  await panel.getByRole("button", { name: "Open file" }).click()
  await expect(panel.getByRole("tab", { name: "Open file" })).toHaveAttribute("data-selected", "")
  await expect(panel.locator(SIDEBAR)).toHaveCount(1)
  await expect(panel.locator(TREES).locator("visible=true")).toHaveCount(1)
  // The picker opens any file: an unchanged file is listed without switching the select.
  await expect(sidebar.getByRole("button", { name: "README.md" })).toBeVisible()
})

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "files-panel-single-tree",
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
        file: "changed.ts",
        before: "",
        after: "export const changed = true\n",
        additions: 1,
        deletions: 0,
        status: "added",
      },
    ],
    fileList: (path) => {
      if (path) return []
      return [fileNode("README.md"), fileNode("changed.ts")]
    },
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    findFiles: (input) => (input.query === "read" ? ["README.md"] : []),
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
        "opencode.global.dat:layout",
        JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }),
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
    name: path,
    path,
    absolute: `${directory}/${path}`,
    type: "file" as const,
    ignored: false,
  }
}
