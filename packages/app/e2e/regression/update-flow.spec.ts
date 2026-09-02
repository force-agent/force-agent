import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/UpdateFlow"
const sessionID = "ses_update_flow"
const title = "Update flow"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

const status = (extra: Record<string, unknown> = {}) => ({
  current: "2.0.0",
  latest: "9.9.9",
  available: true,
  manager: "npm",
  canApply: true,
  command: "npm i -g force-agent@9.9.9",
  checkedAt: 1700000000000,
  phase: { type: "idle" },
  ...extra,
})

function mock(
  page: Parameters<typeof mockOpenCodeServer>[0],
  extra: Partial<Parameters<typeof mockOpenCodeServer>[1]>,
) {
  return mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_update_flow",
      worktree: directory,
      vcs: "git",
      name: "update-flow",
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
        slug: "update-flow",
        version: "1",
        projectID: "proj_update_flow",
        directory,
        title,
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    ...extra,
  })
}

/**
 * The web build gets a self-updater: the nav button reads "Update to X" once the server
 * reports a newer version, applying POSTs `/api/update/apply`, and the page waits for the
 * `restarting` phase plus a healthy answer from a new pid on the target version before it
 * reloads itself — no password prompt, no click needed after the first one.
 */
test("nav update button applies the update and the page reloads on the new server", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = {
    phase: { type: "idle" } as Record<string, unknown>,
    pid: 1,
    version: "2.0.0",
    applied: [] as unknown[],
  }
  await mock(page, {
    update: () => status({ phase: state.phase }),
    health: () => ({ healthy: true, version: state.version, pid: state.pid }),
    onUpdateApply: ({ body }) => {
      state.applied.push(body)
      state.phase = { type: "installing", version: "9.9.9" }
      // The install finishes and the new process comes up on the next polls.
      setTimeout(() => {
        state.phase = { type: "restarting", version: "9.9.9", pid: 1 }
      }, 300)
      setTimeout(() => {
        state.version = "9.9.9"
        state.pid = 2
      }, 900)
      return status({ phase: state.phase })
    },
  })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const button = page.locator('[data-action="nav-sidebar-update"]')
  await expect(button).toBeVisible()
  // The nav checks once on load: the label carries the version without a click.
  await expect(button).toHaveText("Update to 9.9.9")
  await expect(button).toBeEnabled()
  // It sits right above Settings at the bottom of the nav.
  const settings = page.locator('[data-action="nav-sidebar-settings"]')
  const buttonBox = await button.boundingBox()
  const settingsBox = await settings.boundingBox()
  if (!buttonBox || !settingsBox) throw new Error("nav buttons have no bounding box")
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(settingsBox.y + 1)

  const reloaded = page.waitForEvent("load")
  await button.click()
  await expect(button).toHaveAttribute("data-state", /installing|restarting/)
  await expect(page.getByText("Updating to 9.9.9")).toBeVisible()
  await reloaded

  expect(state.applied).toEqual([{ version: "9.9.9" }])
  // Back on the new server: the app boots again against the same mock.
  await expectSessionTitle(page, title)
})

test("nav update button reads 'Check for updates' when nothing is available and checks on click", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  let checks = 0
  await mock(page, {
    update: () => {
      checks += 1
      return status({ available: false, latest: "2.0.0" })
    },
  })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const button = page.locator('[data-action="nav-sidebar-update"]')
  await expect(button).toHaveText("Check for updates")
  await expect.poll(() => checks).toBe(1)
  await button.click()
  await expect(page.getByText("You're up to date")).toBeVisible()
  await expect.poll(() => checks).toBe(2)
})

test("an installation that cannot update itself shows the manual command", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mock(page, { update: () => status({ canApply: false, reason: "local" }) })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const button = page.locator('[data-action="nav-sidebar-update"]')
  await expect(button).toHaveText("Update to 9.9.9")
  await button.click()
  await expect(page.getByText("npm i -g force-agent@9.9.9")).toBeVisible()
})
