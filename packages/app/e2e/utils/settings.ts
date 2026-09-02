import type { Page } from "@playwright/test"

/**
 * Pins the legacy horizontal tab strip for a spec.
 *
 * The nav sidebar is the default navigation, so at the Playwright viewport
 * (1280x720, above the 767px mobile breakpoint) the strip is not rendered and
 * every `[data-titlebar-tab-slot]` / `[data-slot="titlebar-tabs"]` selector fails
 * to resolve. Specs that exercise tab behaviour opt into the strip explicitly.
 *
 * Must be called before `page.goto`.
 */
export async function useLegacyTabStrip(page: Page) {
  await seedSettings(page, { appearance: { tabLayout: "horizontal" } })
}

/** Merges a partial settings object into the persisted `settings.v3` payload. */
export async function seedSettings(page: Page, settings: Record<string, unknown>) {
  await page.addInitScript((value) => {
    const key = "settings.v3"
    let current: Record<string, unknown> = {}
    try {
      current = JSON.parse(localStorage.getItem(key) ?? "{}")
    } catch {
      current = {}
    }
    const merged = { ...current }
    for (const [namespace, entries] of Object.entries(value)) {
      merged[namespace] = { ...((current[namespace] as object) ?? {}), ...(entries as object) }
    }
    localStorage.setItem(key, JSON.stringify(merged))
  }, settings)
}
