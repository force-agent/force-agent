import { describe, expect, test } from "bun:test"
import {
  EXTENSIONS_WIDTH_MAX,
  EXTENSIONS_WIDTH_MIN,
  MAIN_COLUMN_WIDTH_MIN,
  clampExtensionsWidth,
  extensionsFitsRow,
  extensionsWidthMax,
} from "./session-extensions-width"
const REVIEW_PANE_WIDTH_MIN = 480
const REVIEW_PANE_WIDTH_MIN_SPLIT = 800

describe("extensionsWidthMax", () => {
  test("caps at the design maximum when there is plenty of room", () => {
    expect(extensionsWidthMax({ available: 1600 })).toBe(EXTENSIONS_WIDTH_MAX)
  })

  test("gives the chat column its minimum before the strip grows", () => {
    // 700 of row: 450 must stay with the chat, so the strip may take 250.
    expect(extensionsWidthMax({ available: 700 })).toBe(250)
  })

  test("never shrinks the strip below its own minimum, even in a cramped row", () => {
    // The chat would rather overflow than have the strip become unreadable.
    expect(extensionsWidthMax({ available: MAIN_COLUMN_WIDTH_MIN })).toBe(EXTENSIONS_WIDTH_MIN)
    expect(extensionsWidthMax({ available: 100 })).toBe(EXTENSIONS_WIDTH_MIN)
  })

  test("assumes the full maximum before the row has been measured", () => {
    // First frame: returning the min here would snap the panel narrow and then widen.
    expect(extensionsWidthMax({ available: undefined })).toBe(EXTENSIONS_WIDTH_MAX)
  })
})

describe("clampExtensionsWidth", () => {
  test("keeps a width that already fits", () => {
    expect(clampExtensionsWidth({ width: 300, available: 1600 })).toBe(300)
  })

  test("pulls a stored width down when the window shrinks", () => {
    // Stored 360 from a wide window, now in a 700px row: 250 is all that is left.
    expect(clampExtensionsWidth({ width: 360, available: 700 })).toBe(250)
  })

  test("holds the minimum against a drag past it", () => {
    expect(clampExtensionsWidth({ width: 40, available: 1600 })).toBe(EXTENSIONS_WIDTH_MIN)
  })

  test("holds the maximum against a drag past it", () => {
    expect(clampExtensionsWidth({ width: 900, available: 1600 })).toBe(EXTENSIONS_WIDTH_MAX)
  })

  test("does not clamp before the row is measured", () => {
    expect(clampExtensionsWidth({ width: 320, available: undefined })).toBe(320)
  })

  test("leaves the chat at or above its minimum for any row width", () => {
    for (const available of [500, 700, 900, 1200, 1920, 2560]) {
      const width = clampExtensionsWidth({ width: EXTENSIONS_WIDTH_MAX, available })
      const chat = available - width
      if (available - EXTENSIONS_WIDTH_MIN >= MAIN_COLUMN_WIDTH_MIN) {
        expect(chat).toBeGreaterThanOrEqual(MAIN_COLUMN_WIDTH_MIN)
      } else {
        // Row too narrow for both: the strip stops shrinking and the chat gives.
        expect(width).toBe(EXTENSIONS_WIDTH_MIN)
      }
    }
  })
})

describe("extensionsFitsRow", () => {
  test("fits when the chat is the only thing sharing the row", () => {
    expect(extensionsFitsRow({ available: 700, reserved: 0 })).toBe(true)
  })

  test("does not fit a 960px window with the review pane open", () => {
    // The case that shipped broken: viewport 960 leaves ~684 in the row, and
    // 684 - 208 - 450 = 26 is nowhere near the review pane's 480.
    expect(extensionsFitsRow({ available: 684, reserved: REVIEW_PANE_WIDTH_MIN })).toBe(false)
  })

  test("fits a wide window with the review pane open", () => {
    expect(extensionsFitsRow({ available: 1600, reserved: REVIEW_PANE_WIDTH_MIN })).toBe(true)
  })

  test("split review needs much more room before the strip may show", () => {
    // Unified needs 1138 of row; split needs 1458.
    expect(extensionsFitsRow({ available: 1200, reserved: REVIEW_PANE_WIDTH_MIN })).toBe(true)
    expect(extensionsFitsRow({ available: 1200, reserved: REVIEW_PANE_WIDTH_MIN_SPLIT })).toBe(false)
    expect(extensionsFitsRow({ available: 1500, reserved: REVIEW_PANE_WIDTH_MIN_SPLIT })).toBe(true)
  })

  test("stays out until the row has been measured", () => {
    expect(extensionsFitsRow({ available: undefined, reserved: 0 })).toBe(false)
  })

  test("refuses exactly at the boundary and accepts one pixel past it", () => {
    const need = EXTENSIONS_WIDTH_MIN + 8 + MAIN_COLUMN_WIDTH_MIN + REVIEW_PANE_WIDTH_MIN
    expect(extensionsFitsRow({ available: need - 1, reserved: REVIEW_PANE_WIDTH_MIN })).toBe(false)
    expect(extensionsFitsRow({ available: need, reserved: REVIEW_PANE_WIDTH_MIN })).toBe(true)
  })
})

import { extensionsModeFor } from "./session-extensions-width"

describe("extensionsModeFor", () => {
  test("unmeasured rows stay full so the first frame does not flash", () => {
    expect(extensionsModeFor({ available: undefined, reserved: 0 })).toBe("full")
  })
  test("full when the chat keeps a comfortable width, rail otherwise", () => {
    // 1280px window minus nav sidebar ≈ 1004px row → full
    expect(extensionsModeFor({ available: 1004, reserved: 0 })).toBe("full")
    // 1100px window ≈ 816px row → rail
    expect(extensionsModeFor({ available: 816, reserved: 0 })).toBe("rail")
  })
})

import { extensionsPresence } from "./session-extensions-width"

describe("extensionsPresence", () => {
  test("a row too narrow for the full strip gets the rail, never nothing", () => {
    // 864px window minus the nav sidebar ≈ 600px row: extensionsFitsRow says no.
    expect(extensionsFitsRow({ available: 600, reserved: 0 })).toBe(false)
    expect(extensionsPresence({ available: 600, reserved: 0, desktop: true, session: true })).toBe("rail")
    // Even absurdly narrow, still the rail: width is not a reason to hide.
    expect(extensionsPresence({ available: 300, reserved: 0, desktop: true, session: true })).toBe("rail")
  })
  test("a comfortable row gets the full strip", () => {
    expect(extensionsPresence({ available: 1004, reserved: 0, desktop: true, session: true })).toBe("full")
  })
  test("hidden only for structural reasons", () => {
    expect(extensionsPresence({ available: 1004, reserved: 0, desktop: false, session: true })).toBe("hidden")
    expect(extensionsPresence({ available: 1004, reserved: 0, desktop: true, session: false })).toBe("hidden")
    expect(extensionsPresence({ available: undefined, reserved: 0, desktop: true, session: true })).toBe("hidden")
  })
})
