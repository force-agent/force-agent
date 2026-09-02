import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/WorkspaceTabs"
const projectID = "proj_workspace_tabs"
const sessionID = "ses_workspace_tabs"
const title = "Workspace tabs"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

// Wide on purpose: the strip and a split diff preview share the row, and a
// split review reserves 800px.
test.use({ viewport: { width: 1920, height: 1000 } })

const BAR = '[data-slot="session-workspace-tabs-bar"]'
const BODY = '[data-slot="session-workspace-body"]'
const STRIP = '[data-slot="session-extensions"]'

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "workspace-tabs",
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
    skills: [
      { id: "review", name: "review", description: "Review changes" },
      { id: "plan", name: "plan", description: "Plan the work" },
    ],
    mcps: [
      { name: "github", status: { status: "connected" } },
      { name: "postgres", status: { status: "failed" } },
    ],
    vcsDiff: [{ file: "src/changed.ts", status: "modified", additions: 3, deletions: 1 }],
    fileList: (path: string) =>
      path
        ? []
        : [{ name: "README.md", path: "README.md", absolute: `${directory}/README.md`, type: "file", ignored: false }],
    fileContent: (path: string) => ({ type: "text", content: `contents:${path}` }),
    pageMessages: () => ({ items: [] }),
  })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  // The strip only renders once the row has been measured; wait for it before
  // asserting anything about the layout it takes part in.
  await expect(page.locator(STRIP)).toBeVisible()
}

// One walk through the reworked session screen: the tab bar, every tab, the
// always-on Skills/MCP strip, and the alignment between them.
test("walks the workspace tabs with the Skills strip pinned beside them", async ({ page }) => {
  await setup(page)

  const tabs = page.locator(`${BAR} [role="tab"][data-tab]`)
  const names = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("data-tab") ?? ""))
  expect(names[0]).toBe("chat")
  // Files is conditional (file-tree setting); these three are always offered.
  // Diffs is retired: the Files tab absorbed the review.
  expect(names).toEqual(expect.arrayContaining(["chat", "context", "browser"]))

  // The requirement in words: the strip sits beside the chat, below the tab bar.
  // Measure the strip's card, not its wrapper — the wrapper spans the whole row
  // and uses padding to push the card down.
  const top = (selector: string) => page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().top))
  expect(Math.abs((await top(STRIP)) - (await top(BODY)))).toBeLessThanOrEqual(1)
  expect(await top(STRIP)).toBeGreaterThan(await top(BAR))

  const strip = page.locator(STRIP)
  await expect(strip.getByText("review", { exact: true })).toBeVisible()
  await expect(strip.getByText("plan", { exact: true })).toBeVisible()
  // MCP servers are no longer listed by name: the strip's Tools section groups
  // them by product (capability catalog). The mock serves no catalog, so the
  // section is present with its status line rather than a list.
  await expect(strip.locator('[data-section="tools"] [data-slot="session-extensions-section"]')).toBeVisible()

  const chatPanel = page.locator('[data-slot="session-workspace-panel"][data-tab="chat"]')
  await expect(chatPanel).toBeVisible()

  for (const name of names.filter((tab) => tab !== "chat")) {
    await page.locator(`${BAR} [data-tab="${name}"]`).click()
    await expect(page.locator(`${BAR} [data-tab="${name}"]`)).toHaveAttribute("aria-selected", "true")
    // Hidden, still mounted: scroll, streaming and composer text survive.
    await expect(chatPanel).toHaveCount(1)
    await expect(chatPanel).toBeHidden()
    // No toggle took the strip away.
    await expect(strip).toBeVisible()
  }

  await page.locator(`${BAR} [data-tab="chat"]`).click()
  await expect(chatPanel).toBeVisible()

  // Sections collapse from their header; the count stays visible while collapsed.
  // Skills is the one with a count here (two seeded skills); Browser comes first
  // in the strip and has none.
  const skillsHeader = strip.locator('[data-section="skills"] [data-slot="session-extensions-section"]')
  const toggle = skillsHeader.locator("button[aria-expanded]")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(skillsHeader).toContainText("2")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
})


// The bar is exactly WORKSPACE_TABS_BAR_HEIGHT tall (the strip aligns to that
// number through --session-tabs-bar-height) and its tab list never scrolls
// sideways at the widths people actually use.
for (const width of [1440, 864]) {
  test(`tab bar keeps its height and does not overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await setup(page)
    const bar = page.locator(BAR)
    const height = await bar.evaluate((el) => Math.round(el.getBoundingClientRect().height))
    expect(height).toBe(36)
    const list = bar.locator('[data-slot="tabs-list"]')
    const overflow = await list.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow, "tab list scrolls sideways").toBeLessThanOrEqual(0)
  })
}
