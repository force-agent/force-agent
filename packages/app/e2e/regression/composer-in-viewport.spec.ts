import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, textPart, userMessage } from "../performance/timeline-stability/fixture"

/**
 * Regression for the v0.5 layout: an empty `#review-panel` sibling with `h-full`
 * split the workspace column 50/50 and parked the composer mid-screen. Pixel
 * gates catch what typecheck and unit tests cannot.
 */
test("composer stays docked at the bottom with a long history", async ({ page }) => {
  await setupTimeline(page, {
    messages: Array.from({ length: 6 }, (_, index) => [
      userMessage(undefined, { id: `msg_${1000 + index * 2}_composer_user`, created: 1700000000000 + index * 2_000 }),
      assistantMessage([textPart(`prt_long_${index}`, `Paragraph ${index}. `.repeat(120))], {
        id: `msg_${1001 + index * 2}_composer_assistant`,
        parentID: `msg_${1000 + index * 2}_composer_user`,
        created: 1700000001000 + index * 2_000,
      }),
    ]).flat(),
    reducedMotion: true,
    seedHistory: true,
  })

  const viewport = page.viewportSize()
  if (!viewport) throw new Error("viewport size unavailable")

  const dock = page.locator('[data-component="session-composer-dock"]')
  await expect(dock).toBeVisible()
  const dockBox = await dock.boundingBox()
  if (!dockBox) throw new Error("composer has no bounding box")
  expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(viewport.height)
  expect(dockBox.y).toBeGreaterThan(viewport.height * 0.6)

  const chat = await page.locator("#session-workspace-tabpanel-chat").boundingBox()
  const body = await page.locator('[data-slot="session-workspace-body"]').boundingBox()
  if (!chat || !body) throw new Error("workspace panels have no bounding box")
  expect(chat.height).toBeGreaterThan(body.height * 0.9)

  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(100)
})

/**
 * The single-viewport check above passed while the real app parked the composer
 * off-screen, so the contract is measured as a matrix: the dock's bottom edge
 * must stay inside the viewport and sit at the same distance from the window
 * floor no matter how long the conversation is.
 */
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
] as const
const MESSAGE_COUNTS = [0, 5, 50] as const
const DOCK_GAP_TOLERANCE = 4

function conversation(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const value = String(index).padStart(3, "0")
    if (index % 2 === 0)
      return userMessage(undefined, { id: `msg_${value}_matrix_user`, created: 1700000000000 + index * 1_000 })
    return assistantMessage([textPart(`prt_matrix_${value}`, `Paragraph ${index}. `.repeat(60))], {
      id: `msg_${value}_matrix_assistant`,
      parentID: `msg_${String(index - 1).padStart(3, "0")}_matrix_user`,
      created: 1700000000000 + index * 1_000,
    })
  })
}

for (const viewport of VIEWPORTS) {
  test(`composer dock keeps its distance to the window floor at ${viewport.name}`, async ({ browser, baseURL }) => {
    // Three full session loads in one test: the budget is the sum, not one load.
    test.slow()
    const gaps: { count: number; gap: number }[] = []
    for (const count of MESSAGE_COUNTS) {
      const context = await browser.newContext({ baseURL, viewport: { ...viewport } })
      const page = await context.newPage()
      try {
        await setupTimeline(page, {
          messages: conversation(count),
          viewport: { width: viewport.width, height: viewport.height },
          reducedMotion: true,
        })
        const dock = page.locator('[data-component="session-composer-dock"]')
        await expect(dock).toBeVisible()
        const box = await dock.boundingBox()
        if (!box) throw new Error(`composer has no bounding box (${count} messages, ${viewport.name})`)
        expect(box.y + box.height, `dock bottom with ${count} messages at ${viewport.name}`).toBeLessThanOrEqual(
          viewport.height,
        )
        gaps.push({ count, gap: viewport.height - (box.y + box.height) })
      } finally {
        await context.close()
      }
    }
    const measured = gaps.map((entry) => entry.gap)
    const spread = Math.max(...measured) - Math.min(...measured)
    expect(spread, `dock gaps at ${viewport.name}: ${JSON.stringify(gaps)}`).toBeLessThanOrEqual(DOCK_GAP_TOLERANCE)
  })
}
