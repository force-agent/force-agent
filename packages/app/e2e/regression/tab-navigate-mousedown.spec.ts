import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/util/encode"
import { currentSession } from "../utils/mock-server"
import { useLegacyTabStrip } from "../utils/settings"
import pkg from "../../package.json" with { type: "json" }

const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const sessionA = session("ses_tab_a", "Tab A session")
const sessionB = session("ses_tab_b", "Tab B session")
const sessionC = session("ses_tab_c", "Tab C session")
const unresolvedSessionID = "ses_tab_unresolved"

test("pressing mouse down on a tab navigates before mouse up", async ({ page }) => {
  await useLegacyTabStrip(page)
  await mockServer(page)
  await page.addInitScript(
    ({ server, sessionA, sessionB }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "session", server, sessionId: sessionA },
          { type: "session", server, sessionId: sessionB },
        ]),
      )
    },
    { server, sessionA: sessionA.id, sessionB: sessionB.id },
  )

  const hrefA = `/server/${base64Encode(server)}/session/${sessionA.id}`
  const hrefB = `/server/${base64Encode(server)}/session/${sessionB.id}`
  await page.goto(hrefA)
  await expect(page.getByText(sessionA.title).first()).toBeVisible()

  const linkB = page.locator(`a[data-titlebar-tab-link][href="${hrefB}"]`)
  await expect(linkB).toBeVisible()
  const box = await linkB.boundingBox()
  if (!box) throw new Error("tab link has no bounding box")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()

  // Navigation must happen on mousedown, before the button is released.
  await expect(page).toHaveURL((url) => url.pathname === hrefB)
  await page.mouse.up()
  await expect(page).toHaveURL((url) => url.pathname === hrefB)
})

test("keyboard navigation follows the visible tab order", async ({ page }) => {
  await useLegacyTabStrip(page)
  await mockServer(page)
  await page.addInitScript(
    ({ server, sessionA, unresolved, sessionC }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "session", server, sessionId: sessionA },
          { type: "session", server, sessionId: unresolved },
          { type: "session", server, sessionId: sessionC },
        ]),
      )
    },
    { server, sessionA: sessionA.id, unresolved: unresolvedSessionID, sessionC: sessionC.id },
  )

  const hrefA = `/server/${base64Encode(server)}/session/${sessionA.id}`
  const hrefC = `/server/${base64Encode(server)}/session/${sessionC.id}`
  await page.goto(hrefA)
  await expect(page.locator("[data-titlebar-tab-slot]:visible")).toHaveCount(2)
  await expect(page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefC}"])`)).toBeVisible()

  await page.keyboard.press("Control+Alt+ArrowRight")

  await expect(page).toHaveURL(new RegExp(`${hrefC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
})

test("cramped tabs only show the close button for the active tab", async ({ page }) => {
  // 320 px: with the Home button gone from the topbar, 360 px no longer cramps three tabs to <= 64 px each.
  await page.setViewportSize({ width: 320, height: 720 })
  await mockServer(page)
  await page.addInitScript(
    ({ server, sessionA, sessionB, sessionC }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "session", server, sessionId: sessionA },
          { type: "session", server, sessionId: sessionB },
          { type: "session", server, sessionId: sessionC },
        ]),
      )
    },
    { server, sessionA: sessionA.id, sessionB: sessionB.id, sessionC: sessionC.id },
  )

  const hrefA = `/server/${base64Encode(server)}/session/${sessionA.id}`
  const hrefB = `/server/${base64Encode(server)}/session/${sessionB.id}`
  await page.goto(hrefA)

  const tabA = page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefA}"])`)
  const tabB = page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefB}"])`)
  await expect(tabA).toHaveAttribute("data-active", "true")
  await expect(tabB).toBeVisible()
  await expect(tabA.locator('[data-slot="tab-close"]')).toBeVisible()
  await expect(tabB.locator('[data-slot="tab-close"]')).toBeHidden()

  await tabB.locator(`a[href="${hrefB}"]`).click()

  await expect(page).toHaveURL((url) => url.pathname === hrefB)
  await expect(tabA.locator('[data-slot="tab-close"]')).toBeHidden()
  await expect(tabB.locator('[data-slot="tab-close"]')).toBeVisible()
})

test("nav sidebar lists sessions, resizes, and navigates", async ({ page }) => {
  await mockServer(page)

  const hrefA = `/server/${base64Encode(server)}/session/${sessionA.id}`
  const hrefB = `/server/${base64Encode(server)}/session/${sessionB.id}`
  await page.goto(hrefA)

  // The nav sidebar is the default navigation and lists every session from the
  // server index, not just open tabs.
  const sidebar = page.locator('[data-slot="nav-sidebar"]')
  await expect(sidebar).toHaveCSS("width", "260px")
  await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)
  await expect(sidebar.locator('[data-action="nav-sidebar-new-session"]')).toHaveCount(0)

  const rowA = sidebar.locator('[data-slot="nav-sidebar-session-row"]', { hasText: sessionA.title })
  const rowB = sidebar.locator('[data-slot="nav-sidebar-session-row"]', { hasText: sessionB.title })
  await expect(rowA).toBeVisible()
  await expect(rowB).toBeVisible()
  await expect(rowA).toHaveAttribute("data-active", "")

  const handle = sidebar.locator('[data-component="resize-handle"]')
  await expect(handle).toHaveCSS("cursor", "col-resize")
  const box = await handle.boundingBox()
  if (!box) throw new Error("nav sidebar resize handle has no bounding box")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2)
  await page.mouse.up()
  await expect(sidebar).toHaveCSS("width", "220px")

  // Dragging past the minimum clamps instead of collapsing the sidebar.
  const resized = await handle.boundingBox()
  if (!resized) throw new Error("resized nav sidebar handle has no bounding box")
  await page.mouse.move(resized.x + resized.width / 2, resized.y + resized.height / 2)
  await page.mouse.down()
  await page.mouse.move(resized.x - 300, resized.y + resized.height / 2)
  await page.mouse.up()
  await expect(sidebar).toHaveCSS("width", "200px")

  await rowB.locator("button").first().click()
  await expect(page).toHaveURL((url) => url.pathname === hrefB)
  await expect(rowB).toHaveAttribute("data-active", "")
})

test("appearance setting switches between the sidebar and the legacy tab strip", async ({ page }) => {
  await mockServer(page)
  await page.addInitScript(
    ({ server, sessionA }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionA }]),
      )
    },
    { server, sessionA: sessionA.id },
  )

  await page.goto("/")
  // Sidebar is the default; the strip is the opt-in escape hatch.
  await expect(page.locator('[data-slot="nav-sidebar"]')).toBeVisible()
  await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)
  await page.keyboard.press("Control+,")

  const settings = page.getByTestId("settings-screen")
  await expect(settings).toBeVisible()
  const version = settings.getByRole("tablist").getByText(`v${pkg.version}`, { exact: true })
  await settings.getByRole("tab", { name: "Appearance" }).click()
  await expect(settings.getByRole("heading", { name: "Experimental" })).toBeVisible()

  const layout = settings.locator('[data-action="settings-tab-layout"]')
  await expect(layout).toContainText("Sidebar")

  // Settings chrome stays responsive. Checked with the sidebar present, since it is
  // the default and the tablist width follows the width left to <main>.
  await expect(settings.getByRole("tablist")).toHaveCSS("width", "240px")
  await page.setViewportSize({ width: 920, height: 720 })
  await expect(settings.getByRole("tablist")).toHaveCSS("width", "160px")
  await page.setViewportSize({ width: 390, height: 720 })
  await expect(version).toBeInViewport()
  await settings.evaluate((element) => element.setAttribute("dir", "rtl"))
  await expect(version).toBeInViewport()
  await expect(version).toHaveCSS("direction", "ltr")
  await settings.evaluate((element) => element.removeAttribute("dir"))

  await page.setViewportSize({ width: 1280, height: 720 })
  await layout.click()
  await page.getByRole("option", { name: "Horizontal tabs (legacy)" }).click()

  await expect(layout).toContainText("Horizontal tabs (legacy)")
  await expect(page.locator('[data-slot="titlebar-tabs"]')).toBeVisible()
  await expect(page.locator('[data-slot="nav-sidebar"]')).toHaveCount(0)

  // Reload the UI-selected preference without seeding settings storage.
  await page.reload()
  const href = `/server/${base64Encode(server)}/session/${sessionA.id}`
  await expect(
    page
      .locator('[data-slot="titlebar-tabs"]')
      .locator(`[data-titlebar-tab-link][href="${href}"]`)
      .getByText(sessionA.title, { exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-slot="nav-sidebar"]')).toHaveCount(0)

  await page.keyboard.press("Control+,")
  await settings.getByRole("tab", { name: "Appearance" }).click()
  await expect(layout).toContainText("Horizontal tabs (legacy)")
  await layout.click()
  await page.getByRole("option", { name: "Sidebar" }).click()
  await expect(page.locator('[data-slot="nav-sidebar"]')).toBeVisible()
})

test("the sidebar falls back to the horizontal strip on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await mockServer(page)
  await page.addInitScript(
    ({ server, sessionA }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionA }]),
      )
    },
    { server, sessionA: sessionA.id },
  )

  const href = `/server/${base64Encode(server)}/session/${sessionA.id}`
  await page.goto(href)

  const tabs = page.locator('[data-slot="titlebar-tabs"]')
  await expect(tabs.locator(`[data-titlebar-tab-link][href="${href}"]`)).toContainText(sessionA.title)
  await expect(page.locator('[data-slot="nav-sidebar"]')).toHaveCount(0)

  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(page.locator('[data-slot="nav-sidebar"]')).toBeVisible()
  await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)
})

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID: "project-tabs",
    directory: "C:/tab-project",
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

async function mockServer(page: Page) {
  const sessions = [sessionA, sessionB, sessionC]
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== server) return route.fallback()
    if (url.pathname === `/api/session/${unresolvedSessionID}`) return new Promise(() => {})
    if (url.pathname === "/api/event") return sse(route)
    if (url.pathname === "/api/session")
      return json(route, { data: sessions.map((session) => currentSession(session)), cursor: {} })
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
    const currentSessionInfo = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
    if (currentSessionInfo) return json(route, { data: currentSession(currentSessionInfo) })
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/message`))
      return json(route, { data: [], cursor: {} })
    if (["/api/agent", "/api/provider", "/api/model", "/api/command", "/api/reference"].includes(url.pathname))
      return json(route, { location: { directory: sessionA.directory }, data: [] })
    if (url.pathname === "/api/model/default")
      return json(route, { location: { directory: sessionA.directory }, data: null })
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/question/request")
      return json(route, { location: { directory: sessionA.directory }, data: [] })
    if (url.pathname === "/api/mcp") return json(route, { location: { directory: sessionA.directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory: sessionA.directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/project" || url.pathname === "/api/project/current") {
      const project = {
        id: sessionA.projectID,
        canonical: sessionA.directory,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }
      return json(
        route,
        url.pathname === "/api/project" ? [project] : { id: project.id, directory: sessionA.directory },
      )
    }
    if (url.pathname === "/api/location") return json(route, { directory: sessionA.directory })
    if (url.pathname === "/api/vcs")
      return json(route, {
        location: { directory: sessionA.directory },
        data: { branch: "main", defaultBranch: "main" },
      })
    return json(route, {})
  })
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
