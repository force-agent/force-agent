import { base64Encode } from "@opencode-ai/util/encode"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/AgentStrip"
const projectID = "proj_agent_strip"
const sessionID = "ses_agent_strip"
const title = "Agent strip never hides"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
// A workspace with as many skills as the owner's machine: enough that an
// uncapped list would push every other section a few screens down.
const SKILLS = Array.from({ length: 85 }, (_, i) => ({
  id: `skill-${String(i).padStart(2, "0")}`,
  name: `skill-${String(i).padStart(2, "0")}`,
  description: `Skill number ${i}`,
}))
// Tools and routines seeded past the 10-row cap of a section list, so all three
// lists have to share the panel instead of each getting its full height.
const TOOLS = Array.from({ length: 30 }, (_, i) => ({
  id: `tool-${String(i).padStart(2, "0")}`,
  name: `tool-${String(i).padStart(2, "0")}`,
  channels: { cli: { binary: `tool-${String(i).padStart(2, "0")}`, found: true } },
  pinned: false,
  allowed: true,
}))
const ROUTINES = Array.from({ length: 30 }, (_, i) => ({
  id: `rtn_${String(i).padStart(2, "0")}`,
  projectID,
  directory,
  agent: "build",
  name: `routine-${String(i).padStart(2, "0")}`,
  schedule: "0 * * * *",
  timezone: "UTC",
  enabled: true,
  time: { created: 1700000000000, updated: 1700000000000 },
}))
const SECTIONS = ["browser", "skills", "tools", "routines"] as const
const STRIP = '[data-slot="session-extensions"]'
const LIST = '[data-slot="session-sidebar-list"]'
// Rows are 24px (skills, routines) or 26px (tools, with chips); measure the
// first row of each list instead of assuming one height for all of them.
const ROW = ".session-sidebar-item"

// The mode follows a ResizeObserver on the session row, which can still flip
// rail→full right after the title renders; read it once it stops changing.
async function settledMode(strip: Locator) {
  let last = await strip.getAttribute("data-mode")
  for (let i = 0; i < 20; i++) {
    await strip.page().waitForTimeout(100)
    const next = await strip.getAttribute("data-mode")
    if (next && next === last) return next
    last = next
  }
  return last
}

// The strip is about the agent driving the session, and the point of it is
// that agent activity never hides. Narrow rows get the icon rail, never nothing.
for (const width of [1440, 1100, 864]) {
  test(`the agent strip is in the DOM at ${width}px and every section is reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await setup(page)
    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await expectSessionTitle(page, title)

    const strip = page.locator(STRIP)
    await expect(strip).toHaveCount(1)
    await expect(strip).toBeVisible()
    const mode = await settledMode(strip)
    expect(mode === "full" || mode === "rail").toBe(true)

    if (mode === "rail") {
      // Icon rail: one button per section, each opening the section in a popover.
      for (const id of SECTIONS) await expect(strip.locator(`[data-rail-section="${id}"]`)).toBeVisible()
      return
    }

    // Full strip: with 85 skills listed, the sections after Skills must still sit
    // inside the panel — a section three screens down is a section that hides.
    await expect(strip.locator('[data-section="skills"] button', { hasText: "skill-00" })).toBeVisible()
    const panel = await strip.boundingBox()
    if (!panel) throw new Error("strip has no box")
    for (const id of SECTIONS) {
      const header = strip.locator(`[data-section="${id}"] [data-slot="session-extensions-section"]`)
      await expect(header).toBeVisible()
      const box = await header.boundingBox()
      if (!box) throw new Error(`${id} header has no box`)
      expect(box.y + box.height, `${id} header inside the panel`).toBeLessThanOrEqual(panel.y + panel.height)
    }
  })
}

// The panel never scrolls: its lists do. With 85 skills, 30 tools and 30
// routines on a short window, the three lists shrink together (never under 3
// rows each) and the panel's own scrollHeight equals its clientHeight — a
// section below the fold would be a section that hides.
test("on a short window the lists shrink together and the strip itself never scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 778 })
  await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const strip = page.locator(STRIP)
  await expect(strip).toHaveAttribute("data-mode", "full")
  await expect(strip.locator('[data-section="skills"] button', { hasText: "skill-00" })).toBeVisible()
  await expect(strip.locator('[data-section="tools"] .session-sidebar-item', { hasText: "tool-00" })).toBeVisible()
  await expect(strip.locator('[data-section="routines"]').getByText("routine-00")).toBeVisible()

  const panel = await strip.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
  expect(panel.scroll, "strip has no external scroll").toBe(panel.client)

  for (const id of ["skills", "tools", "routines"] as const) {
    const list = strip.locator(`[data-section="${id}"] ${LIST}`)
    await expect(list).toHaveCount(1)
    const box = await list.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
    const row = await list
      .locator(ROW)
      .first()
      .evaluate((el) => el.getBoundingClientRect().height)
    expect(box.scroll, `${id} list scrolls on its own`).toBeGreaterThan(box.client)
    expect(box.client, `${id} list shows at least 3 rows`).toBeGreaterThanOrEqual(3 * row)
  }
  const bar = await strip.boundingBox()
  const routines = await strip
    .locator('[data-section="routines"] [data-slot="session-extensions-section"]')
    .boundingBox()
  if (!bar || !routines) throw new Error("no box")
  expect(routines.y + routines.height, "routines header inside the panel").toBeLessThanOrEqual(bar.y + bar.height)
})

// With room to spare a list stops at 10 rows: the cap is what keeps the other
// sections in reach, so it must hold even when nothing forces a shrink.
test("with room to spare the skills list shows exactly 10 rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 })
  await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const strip = page.locator(STRIP)
  await expect(strip).toHaveAttribute("data-mode", "full")
  await expect(strip.locator('[data-section="skills"] button', { hasText: "skill-00" })).toBeVisible()
  const skills = strip.locator(`[data-section="skills"] ${LIST}`)
  const row = await skills
    .locator(ROW)
    .first()
    .evaluate((el) => el.getBoundingClientRect().height)
  expect(row).toBe(24)
  expect(await skills.evaluate((el) => el.clientHeight)).toBe(10 * row)
  const panel = await strip.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
  expect(panel.scroll, "strip has no external scroll").toBe(panel.client)
})

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "agent-strip",
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
    skills: SKILLS,
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

  // The mock server serves no capability catalog and no routines; these routes
  // are registered after it, so they take precedence (Playwright runs the last
  // registered matching route first).
  const location = { directory, project: { id: projectID, directory, canonical: directory } }
  await page.route(/\/api\/capability(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ location, data: TOOLS }) }),
  )
  await page.route(/\/api\/routine(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ location, data: ROUTINES }) }),
  )

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
