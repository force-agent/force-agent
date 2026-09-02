import { base64Encode } from "@opencode-ai/util/encode"
import { useLegacyTabStrip } from "../utils/settings"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// These specs exercise the tab strip, which is no longer the default navigation.
test.beforeEach(async ({ page }) => {
  await useLegacyTabStrip(page)
})

const directory = "C:/OpenCode/FileBrowserSidebar"
const projectID = "proj_file_browser_sidebar"
const sessionID = "ses_file_browser_sidebar"
const title = "File browser sidebar"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const files = Array.from({ length: 80 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`)
// Marks the workspace tree DOM node so a remount (fresh node) is detectable.
const PROBE = "original"

test.use({ viewport: { width: 1440, height: 900 } })

// One tree on screen: the review sidebar is the file browser, and it must
// survive preview/pinned file-tab switches with its node and scroll intact.
test("keeps the workspace file tree mounted when switching file tabs", async ({ page }) => {
  await setup(page)

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await page.locator('[data-slot="session-workspace-tabs-bar"] [data-tab="files"]').click()
  const panel = page.locator("#session-workspace-tabpanel-files")
  await expect(panel).toBeVisible()
  await panel.getByRole("button", { name: "Git changes" }).click()
  await page.getByRole("option", { name: "All files", exact: true }).click()
  const tree = panel.locator('[data-slot="session-review-v2-sidebar"]')
  await expect(tree.getByRole("button", { name: "file-00.ts" })).toBeVisible()

  // FileTreeV2 is virtualized: rows near the end only exist once scrolled to.
  await tree.evaluate((root) => {
    const el = scrollerOf(root)
    if (!el) throw new Error("file tree has no scroll container")
    el.scrollTop = el.scrollHeight
  })
  await tree.getByRole("button", { name: "file-78.ts" }).dblclick()
  await expect(panel.getByRole("tab", { name: "file-78.ts" })).toHaveAttribute("data-selected", "")
  await tree.getByRole("button", { name: "file-79.ts" }).click()
  await expect(panel.getByRole("tab", { name: "file-79.ts" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("contents:file-79.ts", { exact: true })).toBeVisible()

  // Clicking scrolls the tree to the file; pin a position of our own after
  // that, close enough that the selected row stays in the virtual window (the
  // tree scrolls a selected row back into view otherwise).
  const pinned = await tree.evaluate((root) => {
    const el = scrollerOf(root)
    if (!el) throw new Error("file tree has no scroll container")
    el.scrollTop = el.scrollTop - 80
    return el.scrollTop
  })
  const scrolled = await tree.evaluate((root) => scrollerOf(root)?.scrollTop)
  expect(scrolled).toBe(pinned)
  await writeProbe(page)

  await panel.getByRole("tab", { name: "file-78.ts" }).click()
  await expect(panel.getByRole("tab", { name: "file-78.ts" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("contents:file-78.ts", { exact: true })).toBeVisible()
  expect(await readProbe(page)).toBe(PROBE)
  await expect.poll(() => tree.evaluate((root) => scrollerOf(root)?.scrollTop)).toBe(scrolled)

  await panel.getByRole("tab", { name: "file-79.ts" }).click()
  await expect(panel.getByRole("tab", { name: "file-79.ts" })).toHaveAttribute("data-selected", "")
  expect(await readProbe(page)).toBe(PROBE)
  await expect.poll(() => tree.evaluate((root) => scrollerOf(root)?.scrollTop)).toBe(scrolled)
})

// Runs in the page: the first element inside `root` that actually scrolls.
declare function scrollerOf(root: Element): HTMLElement | undefined
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { scrollerOf: (root: Element) => HTMLElement | undefined }).scrollerOf = (root) =>
      [root, ...root.querySelectorAll("*")].find((el) => {
        const style = getComputedStyle(el)
        return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight
      }) as HTMLElement | undefined
  })
})

type Probed = HTMLElement & { __e2eProbe?: string }

async function writeProbe(page: Page) {
  await page
    .locator('#session-workspace-tabpanel-files [data-slot="session-review-v2-sidebar"]')
    .evaluate((el, probe) => {
      ;(el as Probed).__e2eProbe = probe
    }, PROBE)
}

async function readProbe(page: Page) {
  return page
    .locator('#session-workspace-tabpanel-files [data-slot="session-review-v2-sidebar"]')
    .evaluate((el) => (el as Probed).__e2eProbe)
}

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "file-browser-sidebar",
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
      return files.map((name) => ({
        name,
        path: name,
        absolute: `${directory}/${name}`,
        type: "file" as const,
        ignored: false,
      }))
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
