import { Icon } from "@opencode-ai/ui/icon"
import type { SkillInfo } from "@opencode-ai/client/promise"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { UsageLevel } from "./usage-domain"

/** Above this many skills a filter box is worth its 26px. */
const SEARCH_THRESHOLD = 12

export function SkillsList(props: {
  skills: readonly SkillInfo[]
  level: (id: string) => UsageLevel | undefined
  onOpen: (skill: SkillInfo) => void
}) {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const filtered = createMemo(() => {
    const q = query().trim().toLocaleLowerCase("pt-BR")
    if (!q) return props.skills
    return props.skills.filter((skill) => skill.name.toLocaleLowerCase("pt-BR").includes(q))
  })
  const usageTitle = (level: UsageLevel | undefined) =>
    level === "active"
      ? language.t("session.sidebar.usage.active")
      : level === "used"
        ? language.t("session.sidebar.usage.used")
        : undefined

  return (
    <>
      <Show when={props.skills.length > SEARCH_THRESHOLD}>
        <label class="mx-1 mb-1 flex h-6 items-center gap-1 rounded-[6px] border border-v2-border-border-weaker-base bg-v2-background-bg-base px-1.5 text-v2-text-text-faint focus-within:border-v2-border-border-weak-base">
          <Icon name="magnifying-glass" size="small" class="shrink-0" />
          <input
            type="search"
            class="min-w-0 flex-1 bg-transparent text-[11px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            placeholder={language.t("session.sidebar.skills.search")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </Show>
      {/*
        The list scrolls on its own (3 to 10 rows, sidebar.css). A workspace
        with 85 skills is ~2000px of rows; letting them flow into the panel
        pushed Tools and Routines three screens down, and with the section
        header sticky the panel read as "Skills only".
      */}
      <div data-slot="session-sidebar-list">
        <For each={filtered()}>
          {(skill) => (
            <button
              type="button"
              class="session-sidebar-item w-full text-left"
              data-usage={props.level(skill.id)}
              title={usageTitle(props.level(skill.id)) ?? skill.description}
              onClick={() => props.onOpen(skill)}
            >
              <Icon name="brain" size="small" class="shrink-0 text-v2-icon-icon-muted" />
              <span class="min-w-0 flex-1 truncate">{skill.name}</span>
              <Show when={props.level(skill.id)}>
                <span class="session-sidebar-dot" data-usage={props.level(skill.id)} />
              </Show>
            </button>
          )}
        </For>
        <Show when={filtered().length === 0 && props.skills.length > 0}>
          <div class="px-2 pb-1 text-[11px] text-v2-text-text-faint">
            {language.t("session.sidebar.skills.noMatch")}
          </div>
        </Show>
      </div>
    </>
  )
}
