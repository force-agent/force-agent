import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/NavTitleHome"
const sessionID = "ses_nav_title_home"
const title = "Nav title home"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

// The topbar lost its Home button. The "Workspaces" title of the nav sidebar is now
// the click path to the home; mod+b keeps toggling between the home and the last tab.
test("the nav sidebar title navigates to the home and mod+b still toggles", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_nav_title_home",
      worktree: directory,
      vcs: "git",
      name: "nav-title-home",
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
        slug: "nav-title-home",
        version: "1",
        projectID: "proj_nav_title_home",
        directory,
        title,
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  // The home only offers "New session" once a project is selected.
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, directory)

  const href = `/server/${base64Encode(server)}/session/${sessionID}`
  await page.goto(href)
  await expectSessionTitle(page, title)

  const nav = page.locator('[data-slot="nav-sidebar"]')
  await expect(nav).toBeVisible()
  // No Home button in the topbar any more.
  await expect(page.locator("header").getByRole("button", { name: "Home" })).toHaveCount(0)

  const navHome = nav.locator('[data-action="nav-home"]')
  await expect(navHome).toHaveAttribute("aria-pressed", "false")
  await navHome.click()
  await expect(page).toHaveURL("/")
  await expect(navHome).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator("main").locator('[data-action="home-new-session"]')).toBeVisible()

  // mod+b from the home returns to the session that was open; again goes home.
  await page.keyboard.press("Control+b")
  await expect(page).toHaveURL(href)
  await expect(navHome).toHaveAttribute("aria-pressed", "false")
  await page.keyboard.press("Control+b")
  await expect(page).toHaveURL("/")
})
