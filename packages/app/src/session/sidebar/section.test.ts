import { describe, expect, test } from "bun:test"
import { SIDEBAR_SECTION_ORDER, sectionFallback } from "./section"
import en from "@/runtime/i18n/en"

// `SidebarSection` stamps `data-section={props.id}` on every entry of
// SIDEBAR_SECTION_ORDER, so this list is the panel's DOM contract:
// [data-section="browser"|"skills"|"tools"|"routines"]. Subagents are not a
// section: the parent's timeline already shows them.
describe("sidebar sections", () => {
  test("the panel declares the four sections, in order", () => {
    expect([...SIDEBAR_SECTION_ORDER]).toEqual(["browser", "skills", "tools", "routines"])
    expect(SIDEBAR_SECTION_ORDER).not.toContain("agents")
  })

  test("an empty section still renders, showing what it would list", () => {
    const copy: Record<string, string | undefined> = {
      browser: en["session.sidebar.browser.empty"],
      skills: en["session.sidebar.skills.empty"],
      tools: en["session.sidebar.tools.empty"],
      routines: en["session.sidebar.routines.empty"],
    }
    for (const id of SIDEBAR_SECTION_ORDER) {
      const empty = copy[id]
      expect(empty).toBeTruthy()
      expect(sectionFallback({ count: 0, empty })).toBe(empty!)
    }
  })

  test("a populated section shows its list, not the empty line", () => {
    expect(sectionFallback({ count: 3, empty: "nothing here" })).toBeUndefined()
    // The browser section has no count: its body is always worth rendering.
    expect(sectionFallback({ count: undefined, empty: "nothing here" })).toBeUndefined()
  })

  test("a failed load is not an empty list", () => {
    const error = en["session.sidebar.tools.error"]
    const empty = en["session.sidebar.tools.empty"]
    expect(error).not.toBe(empty)
    expect(sectionFallback({ count: 0, empty, error })).toBe(error)
    expect(sectionFallback({ count: 0, empty })).toBe(empty)
  })
})
