import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TopbarCollapsed"
const sessionID = "ses_topbar_collapsed"
const title = "Topbar collapsed"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 864, height: 778 },
] as const

/**
 * In the web build with the nav sidebar on, the 36px topbar has nothing left to
 * show (no tab strip, no Home button, no review toggle) so it is not rendered at
 * all. What used to live on its right edge — the StatusPopover trigger — now sits
 * at the right end of the workspace tab bar; the DEV/BETA badge moves to the nav
 * title row (not asserted: release builds render no badge).
 */
for (const viewport of VIEWPORTS) {
  test(`topbar is gone and status lives in the tab bar at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize({ ...viewport })
    // The status trigger only renders when the "Show status" preference is on.
    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { showStatus: true } }))
    })
    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: "proj_topbar_collapsed",
        worktree: directory,
        vcs: "git",
        name: "topbar-collapsed",
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
          slug: "topbar-collapsed",
          version: "1",
          projectID: "proj_topbar_collapsed",
          directory,
          title,
          time: { created: 1700000000000, updated: 1700000000000 },
        },
      ],
      pageMessages: () => ({ items: [] }),
    })

    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await expectSessionTitle(page, title)

    // No drag-region header in the web build.
    await expect(page.locator("header[data-tauri-drag-region]")).toHaveCount(0)
    await expect(page.locator('[data-slot="titlebar-v2"]')).toHaveCount(0)

    // The nav sidebar starts at the top of the window (only --shell-top-inset above it).
    const nav = page.locator('[data-slot="nav-sidebar"]')
    await expect(nav).toBeVisible()
    const navBox = await nav.boundingBox()
    if (!navBox) throw new Error("nav sidebar has no bounding box")
    expect(navBox.y).toBeLessThanOrEqual(8)

    // The workspace tab bar took the topbar's place: inset + panel padding only.
    const bar = page.locator('[data-slot="session-workspace-tabs-bar"]')
    await expect(bar).toBeVisible()
    const barBox = await bar.boundingBox()
    if (!barBox) throw new Error("workspace tab bar has no bounding box")
    expect(barBox.y).toBeLessThanOrEqual(16)

    // The status trigger is inside the bar, on its right half, and still opens the popover.
    const status = bar.getByRole("button", { name: "Status" })
    await expect(status).toBeVisible()
    const statusBox = await status.boundingBox()
    if (!statusBox) throw new Error("status trigger has no bounding box")
    expect(statusBox.x).toBeGreaterThan(barBox.x + barBox.width / 2)
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(barBox.x + barBox.width + 1)
    await expect(page.locator("header").getByRole("button", { name: "Status" })).toHaveCount(0)
    await status.click()
    await expect(page.locator('[data-slot="popover-body"]')).toBeVisible()
  })
}

/**
 * The draft (new-session) page has no workspace tab bar, so it cannot borrow the
 * TitlebarRight mount: the status trigger renders in place at the page's
 * top-right corner instead. Regression guard for the mount move in task-05.
 */
test("new-session page keeps the status trigger without a topbar", async ({ page }) => {
  const draftID = "draft_topbar_collapsed"
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { showStatus: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_topbar_collapsed",
      worktree: directory,
      vcs: "git",
      name: "topbar-collapsed",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })

  await page.goto(`/new-session?draftId=${draftID}`)
  await expectAppVisible(page.locator('[data-component="composer-editor"]'))

  await expect(page.locator("header[data-tauri-drag-region]")).toHaveCount(0)
  await expect(page.locator('[data-slot="session-workspace-tabs-bar"]')).toHaveCount(0)

  const slot = page.locator('[data-slot="new-session-status"]')
  const status = slot.getByRole("button", { name: "Status", exact: true })
  await expect(status).toBeVisible()
  const viewport = page.viewportSize()
  if (!viewport) throw new Error("viewport size is unavailable")
  const statusBox = await status.boundingBox()
  if (!statusBox) throw new Error("status trigger has no bounding box")
  expect(statusBox.x).toBeGreaterThan(viewport.width / 2)
  expect(statusBox.y).toBeLessThanOrEqual(24)
  await status.click()
  await expect(page.locator('[data-slot="popover-body"]')).toBeVisible()
})
