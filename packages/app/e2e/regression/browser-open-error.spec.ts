import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/BrowserOpenError"
const sessionID = "ses_browser_open_error"
const title = "Browser open error"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

// browser-panel.spec.ts covers the empty state itself: the button exists and a 503 from the
// provider is reported as an error. This file covers what the error says and what happens when
// the server answers off-contract — the two ways the button used to go silent.
//
// The message the core throws when no Chromium can be started; the panel has to show it whole,
// including the variable that points at another binary.
const unavailable =
  "Could not start a browser at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome: ENOENT. " +
  "Set LABHARNESS_BROWSER_PATH to a Chrome/Chromium binary, install Chrome/Chromium, or run `labharness browser install`."

test.use({ viewport: { width: 1600, height: 1000 } })

function config() {
  return {
    directory,
    project: {
      id: "proj_browser_open_error",
      worktree: directory,
      vcs: "git",
      name: "browser-open-error",
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
        slug: "browser-open-error",
        version: "1",
        projectID: "proj_browser_open_error",
        directory,
        title,
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  }
}

async function openBrowserTab(page: import("@playwright/test").Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.locator('[data-slot="session-workspace-tabs-bar"] [data-tab="browser"]').click()
  const panel = page.locator('[data-slot="session-workspace-panel"][data-tab="browser"]')
  await expect(panel).toBeVisible()
  return panel
}

// A provider that cannot launch anything: the button reports why, and the reason names the
// variable that overrides the browser path.
test("open button surfaces the provider failure with the browser path variable", async ({ page }) => {
  await mockOpenCodeServer(page, config())
  await page.route(/\/api\/browser\/tabs(\?|$)/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ _tag: "BrowserUnavailableError", message: unavailable }),
    }),
  )

  const panel = await openBrowserTab(page)
  const open = panel.locator('[data-slot="session-browser-open"]')
  await expect(open).toBeEnabled()
  await open.click()

  await expect(panel.getByText(unavailable, { exact: false })).toBeVisible()
  await expect(panel.getByText("LABHARNESS_BROWSER_PATH", { exact: false })).toBeVisible()
  // The button comes back: a failed open must not leave a dead control behind.
  await expect(open).toBeEnabled()
})

// An undeclared status is the silent case: nothing in the contract describes it, so the store has
// to still land on `error()` rather than swallow the rejection.
test("open button still shows an error when the server answers off-contract", async ({ page }) => {
  await mockOpenCodeServer(page, config())
  await page.route(/\/api\/browser\/tabs(\?|$)/, (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "boom" }),
  )

  const panel = await openBrowserTab(page)
  const open = panel.locator('[data-slot="session-browser-open"]')
  await open.click()

  await expect(panel.getByText(/Browser error:/)).toBeVisible()
  await expect(open).toBeEnabled()
})
