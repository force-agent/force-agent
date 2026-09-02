import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/BrowserPanel"
const sessionID = "ses_browser_panel"
const title = "Browser panel"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1600, height: 1000 } })

// The Browser workspace tab with no browser running: the empty state offers to open one, and
// the sidebar preview stays a placeholder.
test("browser tab shows the empty state with an open button when no browser is running", async ({ page }) => {
  const opened: unknown[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_browser_panel",
      worktree: directory,
      vcs: "git",
      name: "browser-panel",
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
      default: { opencode: "test" },
      connected: ["opencode"],
    },
    sessions: [
      {
        id: sessionID,
        slug: "browser-panel",
        version: "1",
        projectID: "proj_browser_panel",
        directory,
        title,
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(/\/api\/browser\/tabs(\?|$)/, async (route) => {
    opened.push(route.request().postDataJSON())
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ _tag: "BrowserUnavailableError", message: "no chromium in e2e" }),
    })
  })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await page.locator('[data-slot="session-workspace-tabs-bar"] [data-tab="browser"]').click()
  const panel = page.locator('[data-slot="session-workspace-panel"][data-tab="browser"]')
  await expect(panel).toBeVisible()
  const open = panel.locator('[data-slot="session-browser-open"]')
  await expect(open).toBeVisible()
  await expect(panel.locator('[data-slot="session-browser-canvas"]')).toHaveCount(0)

  await open.click()
  await expect.poll(() => opened.length).toBe(1)
  await expect(panel.getByText("no chromium in e2e")).toBeVisible()
  await expect(page.locator('[data-slot="session-browser-preview"]')).toBeVisible()
})
