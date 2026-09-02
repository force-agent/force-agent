import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

// The nav sidebar already lists servers, projects and sessions. The home used to
// repeat that in a 280px "Projects" column next to the session list; on desktop
// the home is now a single centered column — the nav on the left is the only
// project navigation.
test("the home renders a single column next to the nav sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)

  await page.goto("/")
  const main = page.locator("main")
  await expect(main.locator('[data-action="home-new-session"]')).toBeVisible()
  await expect(main.locator('[data-component="home-session-search"]')).toBeVisible()
  await expect(page.locator('[data-slot="nav-sidebar"]')).toBeVisible()

  await expect(main.locator('[data-slot="home-projects-scroll"]')).toHaveCount(0)
  await expect(main.locator('aside[aria-label="Projects"]')).toHaveCount(0)
  await expect(main.getByText("Projects", { exact: true })).toHaveCount(0)

  // The session list is centered in the main area, not pushed right by an empty
  // 280px column: with the old grid its center sat ~156px right of main's center.
  const mainBox = await main.boundingBox()
  const listBox = await main.getByRole("region", { name: "Recent sessions", exact: true }).boundingBox()
  expect(mainBox).not.toBeNull()
  expect(listBox).not.toBeNull()
  const mainCenter = mainBox!.x + mainBox!.width / 2
  const listCenter = listBox!.x + listBox!.width / 2
  expect(Math.abs(listCenter - mainCenter)).toBeLessThan(24)
  expect(listBox!.x - mainBox!.x).toBeLessThan(280)
})
