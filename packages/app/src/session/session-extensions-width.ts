/**
 * Width arbitration between the chat column and the always-on Skills/MCP strip.
 *
 * There is exactly one degree of freedom in this layout: the chat column is
 * `flex-1` and the strip has an explicit width, so dragging the strip's leading
 * edge *is* "resize the chat against Skills". Storing a width for both sides
 * instead would make them fight over the same pixels on every window resize —
 * which is why this module replaces session-panel-width.ts rather than joining it.
 */

/** Below this the chat stops being usable. */
export const MAIN_COLUMN_WIDTH_MIN = 450
/** Below this the chat is usable but cramped: the strip steps down to an icon rail. */
export const MAIN_COLUMN_WIDTH_COMFORT = 700
export const EXTENSIONS_WIDTH_MIN = 200
export const EXTENSIONS_WIDTH_MAX = 360
/** Icon-only column shown when the full strip would starve the chat. */
export const EXTENSIONS_RAIL_WIDTH = 44

/**
 * Largest width the strip may take without starving the chat column.
 *
 * `available === undefined` means the row has not been measured yet (first
 * frame). Returning the hard maximum there keeps the panel from visibly
 * snapping narrow and then widening once the ResizeObserver reports.
 */
export function extensionsWidthMax(input: { available: number | undefined }): number {
  if (input.available === undefined) return EXTENSIONS_WIDTH_MAX
  const room = input.available - MAIN_COLUMN_WIDTH_MIN
  if (room <= EXTENSIONS_WIDTH_MIN) return EXTENSIONS_WIDTH_MIN
  return Math.min(EXTENSIONS_WIDTH_MAX, room)
}

/** Clamp a stored or dragged width into what currently fits. */
export function clampExtensionsWidth(input: { width: number; available: number | undefined }): number {
  const max = extensionsWidthMax({ available: input.available })
  if (input.width < EXTENSIONS_WIDTH_MIN) return EXTENSIONS_WIDTH_MIN
  if (input.width > max) return max
  return input.width
}

/**
 * Whether the strip can be shown without starving what shares the row.
 *
 * `reserved` is what must survive *besides* the chat column — the review pane's
 * minimum, the file tree's width, or 0 when the chat is alone.
 *
 * Unmeasured rows answer `false`. Appearing one frame late is invisible; showing
 * up and then retreating squeezes the review pane to nothing for that frame.
 */
export function extensionsFitsRow(input: { available: number | undefined; reserved: number }): boolean {
  if (input.available === undefined) return false
  const room = input.available - (EXTENSIONS_WIDTH_MIN + 8)
  return room - MAIN_COLUMN_WIDTH_MIN >= input.reserved
}

/**
 * Full strip when the chat keeps a comfortable width beside it, icon rail
 * otherwise. Unmeasured rows answer "full" so the first frame does not flash.
 */
export function extensionsModeFor(input: { available: number | undefined; reserved: number }): "full" | "rail" {
  if (input.available === undefined) return "full"
  const room = input.available - (EXTENSIONS_WIDTH_MIN + 8) - input.reserved
  return room >= MAIN_COLUMN_WIDTH_COMFORT ? "full" : "rail"
}

export type ExtensionsPresence = "full" | "rail" | "hidden"

/**
 * Whether the strip is on screen at all, and how. The only reasons for
 * "hidden" are structural — no session to describe, a phone-sized viewport,
 * a row not yet measured. Width alone never hides it: when the full strip
 * would starve the chat, the answer is the icon rail, because the strip
 * exists so that agent activity never disappears from view.
 */
export function extensionsPresence(input: {
  available: number | undefined
  reserved: number
  desktop: boolean
  session: boolean
}): ExtensionsPresence {
  if (!input.desktop || !input.session || input.available === undefined) return "hidden"
  if (!extensionsFitsRow({ available: input.available, reserved: input.reserved })) return "rail"
  return extensionsModeFor({ available: input.available, reserved: input.reserved })
}
