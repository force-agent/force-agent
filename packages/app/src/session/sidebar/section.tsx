import { Icon } from "@opencode-ai/ui/icon"
import { Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/runtime/persistence/storage"

export type SidebarSectionID = "browser" | "skills" | "tools" | "mcps" | "routines"

/**
 * The sections the panel renders, in order. Nothing here is conditional: a
 * section with nothing to list still shows its header and a line saying what it
 * would list, so "empty" never reads as "missing".
 */
export const SIDEBAR_SECTION_ORDER = ["browser", "skills", "tools", "routines"] as const

export type SidebarPanelSectionID = (typeof SIDEBAR_SECTION_ORDER)[number]

/**
 * The line a section shows instead of its list, or `undefined` when the list is
 * worth rendering. A load failure wins over emptiness: "could not load" and
 * "nothing here" are different facts and must not collapse into one another.
 */
export function sectionFallback(input: { count?: number; empty?: string; error?: string }): string | undefined {
  if (input.error) return input.error
  if (input.count === undefined || input.count > 0) return undefined
  return input.empty
}

/**
 * Open/closed state of every sidebar section, persisted globally (not per
 * session): a user who collapses Skills wants it collapsed in every session.
 */
export function createSidebarSections() {
  const [store, setStore] = persisted(
    Persist.global("session-extensions-sections-v1"),
    createStore<Partial<Record<SidebarSectionID, boolean>>>({}),
  )
  return {
    open: (id: SidebarSectionID) => store[id] ?? true,
    toggle: (id: SidebarSectionID) => setStore(id, !(store[id] ?? true)),
  }
}

export type SidebarSections = ReturnType<typeof createSidebarSections>

/**
 * Collapsible section with a sticky 26px header, a count and an optional
 * action slot. The count matters when collapsed, and collapsing matters at all
 * because a workspace with dozens of skills would otherwise push everything
 * below it a full screen down — the panel exists to be read at a glance.
 *
 * A section whose body is a `session-sidebar-list` shrinks with the panel
 * (see sidebar.css): the list scrolls, the panel never does.
 */
export function SidebarSection(props: {
  id: SidebarSectionID
  sections: SidebarSections
  title: string
  icon?: JSX.Element
  count?: number
  empty?: string
  error?: string
  actions?: JSX.Element
  children: JSX.Element
}) {
  const open = () => props.sections.open(props.id)
  const fallback = () => sectionFallback({ count: props.count, empty: props.empty, error: props.error })
  return (
    <section class="flex flex-col" data-section={props.id} data-open={open() ? "" : undefined}>
      <div
        data-slot="session-extensions-section"
        class="sticky top-0 z-10 flex h-[26px] shrink-0 items-center gap-1 rounded-[6px] bg-v2-background-bg-base px-1 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint"
      >
        <button
          type="button"
          class="flex h-full min-w-0 flex-1 items-center gap-1 text-left hover:text-v2-text-text-muted"
          aria-expanded={open()}
          onClick={() => props.sections.toggle(props.id)}
        >
          <Icon
            name="chevron-down"
            size="small"
            class="shrink-0 transition-transform duration-150"
            style={{ transform: `rotate(${open() ? 0 : -90}deg)` }}
          />
          <Show when={props.icon}>{props.icon}</Show>
          <span class="min-w-0 flex-1 truncate">{props.title}</span>
          <Show when={props.count !== undefined}>
            <span class="shrink-0 tabular-nums">{props.count}</span>
          </Show>
        </button>
        <Show when={props.actions}>
          <div class="flex shrink-0 items-center gap-0.5 normal-case tracking-normal">{props.actions}</div>
        </Show>
      </div>
      <Show when={open()}>
        <Show when={fallback()} fallback={<div class="flex min-h-0 flex-auto flex-col pb-1">{props.children}</div>}>
          {(text) => (
            <div
              data-slot="session-extensions-section-fallback"
              data-tone={props.error ? "error" : undefined}
              class="px-2 pb-1 text-[12px] leading-4"
              classList={{
                "text-v2-text-text-muted": !props.error,
                "text-v2-text-text-danger": !!props.error,
              }}
            >
              {text()}
            </div>
          )}
        </Show>
      </Show>
    </section>
  )
}
