import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/FilesLineClickInert"
const projectID = "proj_files_line_click_inert"
const sessionID = "ses_files_line_click_inert"
const title = "Files line click inert"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

// The Files tab is a viewer. Clicking a line there must not open the line-comment
// editor — that lives in the Review tab, where a comment has somewhere to go
// (review-line-comment.spec.ts covers it). Plain text selection keeps working.
test("clicking a markdown line in the Files tab opens no comment editor", async ({ page }) => {
  await setup(page)

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await page.locator('[data-slot="session-workspace-tabs-bar"] [data-tab="files"]').click()
  const panel = page.locator("#session-workspace-tabpanel-files")
  await expect(panel).toBeVisible()
  await panel.getByRole("button", { name: "Git changes" }).click()
  await page.getByRole("option", { name: "All files", exact: true }).click()
  await panel.locator('[data-slot="session-review-v2-sidebar"]').getByRole("button", { name: "README.md" }).click()
  await expect(panel.getByRole("tab", { name: "README.md" })).toHaveAttribute("data-selected", "")

  const line = panel.getByText("contents:README.md", { exact: true })
  await expect(line).toBeVisible()
  await line.click()

  // What the Review tab would show after the same click, and must not show here.
  await expect(panel.locator('[data-component="line-comment-v2"]')).toHaveCount(0)
  await expect(panel.locator('[data-slot="line-comment-editor-label"]')).toHaveCount(0)
  await expect(panel.getByRole("textbox")).toHaveCount(0)
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // Selection is still a plain text selection.
  await line.dblclick()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("")
  await expect(panel.locator('[data-component="line-comment-v2"]')).toHaveCount(0)
})

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "files-line-click-inert",
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
    vcsDiff: [],
    fileList: (path) => {
      if (path) return []
      return [
        {
          name: "README.md",
          path: "README.md",
          absolute: `${directory}/README.md`,
          type: "file" as const,
          ignored: false,
        },
      ]
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
