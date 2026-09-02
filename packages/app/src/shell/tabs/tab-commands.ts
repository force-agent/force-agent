import { tabKey, type Tab } from "@/shell/tabs/tabs"
import { useCommand } from "@/shell/commands/command"
import { adjacentTabKey } from "@/shell/titlebar/tab-order"

/**
 * Tab navigation keybinds (cycle + jump-to-nth), registered independently of the
 * tab strip so they keep working when the strip is hidden (nav sidebar mode).
 * Command IDs match the previous in-strip registrations, so the palette,
 * keybind settings and the native menu are unaffected.
 */
/** The strip already emits data-tab-key on each slot; that attribute is the DOM contract. */
export const tabSlotSelector = (key: string) => `[data-titlebar-tab-slot][data-tab-key="${CSS.escape(key)}"]`

/** Scrolls a tab into view in the legacy strip. No-op when the strip is not rendered. */
export function scrollTabIntoView(key: string) {
  if (typeof document === "undefined") return
  const element = document.querySelector(tabSlotSelector(key))
  element?.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" })
}

export function useTabNavigationCommands(input: {
  tabs: () => readonly Tab[]
  currentTab: () => Tab | undefined
  onNavigate: (tab: Tab) => void
}) {
  const command = useCommand()

  function selectAdjacentTab(offset: -1 | 1) {
    const keys = input.tabs().map(tabKey)
    const current = input.currentTab()
    const key = adjacentTabKey(keys, current ? tabKey(current) : undefined, offset)
    const next = input.tabs().find((tab) => tabKey(tab) === key)
    if (next) input.onNavigate(next)
  }

  command.register("tab-navigation-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
  ])

  command.register("tab-navigation-jump", () =>
    input
      .tabs()
      .slice(0, 9)
      .map((tab, index) => ({
        id: `tab.${index + 1}`,
        category: "tab" as const,
        title: "",
        keybind: `mod+${index + 1}`,
        hidden: true,
        onSelect: () => input.onNavigate(tab),
      })),
  )
}
