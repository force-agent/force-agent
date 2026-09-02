import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLayout } from "@/shell/state/layout"
import { createSizing } from "./helpers"
import type { SessionModel } from "./model"
import {
  EXTENSIONS_RAIL_WIDTH,
  EXTENSIONS_WIDTH_MIN,
  clampExtensionsWidth,
  extensionsPresence,
  extensionsWidthMax,
} from "./session-extensions-width"

export function createSessionScreenLayout(session: SessionModel) {
  const layout = useLayout()
  const size = createSizing()
  // The Files tab absorbed the review (Diffs tab retired): "review open" is the Files tab.
  const filesOpen = createMemo(() => session.isDesktop() && session.layout.view().workspaceTab.current() === "files")
  const reviewOpen = filesOpen
  const reviewPanelOpen = createMemo(() => reviewOpen() && !!session.identity.params.id)
  const [rowSize, setRowSize] = createStore<{ width?: number; height?: number }>({})
  let row: HTMLDivElement | undefined
  createResizeObserver(
    () => row,
    ({ width, height }) => setRowSize({ width, height }),
  )
  const rowAvailable = createMemo<number | undefined>(() => {
    const width = rowSize.width
    if (width === undefined) return undefined
    return width - 8
  })
  const sideReserved = createMemo(() => 0)
  // The strip never hides for lack of width: when it would starve the chat it
  // becomes a 44px rail. Only structural reasons (no session, phone viewport,
  // unmeasured row) take it off screen — see extensionsPresence.
  const presence = createMemo(() =>
    extensionsPresence({
      available: rowAvailable(),
      reserved: sideReserved(),
      desktop: session.isDesktop(),
      session: !!session.identity.params.id,
    }),
  )
  const extensionsMode = createMemo<"full" | "rail">(() => (presence() === "rail" ? "rail" : "full"))
  const extensionsOpen = createMemo(() => presence() !== "hidden")
  const extensionsMax = createMemo(() => extensionsWidthMax({ available: rowAvailable() }))
  const extensionsWidth = createMemo(() =>
    extensionsMode() === "rail"
      ? EXTENSIONS_RAIL_WIDTH
      : clampExtensionsWidth({ width: layout.extensions.width(), available: rowAvailable() }),
  )
  const extensionsSpan = createMemo(() => (extensionsOpen() ? extensionsWidth() + 8 : 0))
  const available = createMemo<number | undefined>(() => {
    const width = rowAvailable()
    if (width === undefined) return undefined
    return width - extensionsSpan()
  })
  const resizedWidth = createMemo(() => layout.session.width())
  const panelWidth = createMemo(() => (extensionsOpen() ? `calc(100% - ${extensionsSpan()}px)` : "100%"))
  const panelMax = createMemo(() => 1000)
  return {
    centered: createMemo(() => session.isDesktop()),
    extensions: {
      open: extensionsOpen,
      mode: extensionsMode,
      width: extensionsWidth,
      max: extensionsMax,
      min: EXTENSIONS_WIDTH_MIN,
    },
    files: { open: filesOpen },
    panel: {
      max: panelMax,
      ref: (element: HTMLDivElement) => {
        row = element
      },
      resizable: () => false,
      resizedWidth,
      width: panelWidth,
    },
    review: {
      open: reviewOpen,
      panelOpen: reviewPanelOpen,
    },
    size,
  }
}

export type SessionScreenLayout = ReturnType<typeof createSessionScreenLayout>
