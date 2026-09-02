import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import type { CapabilityInfo, SkillInfo } from "@opencode-ai/client/promise"
import { createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useLocal } from "@/providers/models/selection"
import { useMcpToggle } from "@/providers/connect/mcp"
import type { SessionModel } from "@/session/model"
import { createSessionUsageTracker } from "./usage-tracker"
import { freezeOrder, sortByUsage } from "./usage-domain"
import { AgentHeader } from "./agent-header"
import { BrowserPreview } from "./browser-preview"
import { useBrowserStore } from "@/session/browser/store"
import { SkillsList } from "./skills-section"
import { ToolsList, sortTools, type ToolChannelUsage } from "./tools-section"
import {
  SIDEBAR_SECTION_ORDER,
  SidebarSection,
  createSidebarSections,
  sectionFallback,
  type SidebarPanelSectionID,
  type SidebarSectionID,
} from "./section"
import { SkillDetailDialog } from "./skill-detail-dialog"
import { RoutinesActions, RoutinesList, useRoutines } from "./routines-section"
import "./sidebar.css"

export type SidebarMode = "full" | "rail"

type Section = {
  id: SidebarSectionID
  icon: JSX.Element
  title: () => string
  count?: () => number
  empty?: () => string
  error?: () => string | undefined
  actions?: JSX.Element
  body: () => JSX.Element
}

/**
 * Right-hand panel about the agent driving the session: its browser tab,
 * skills and MCP servers, each lit when active/used. In `rail` mode (narrow
 * windows) it collapses to a 44px column of icons that open the same sections
 * in popovers, so agent activity never hides.
 */
export function SessionSidebar(props: { session: SessionModel; mode?: SidebarMode }) {
  const data = useData()
  const sdk = useServerSDK()
  const location = useWorkspaceLocation()
  const language = useLanguage()
  const sections = createSidebarSections()
  const [selectedSkill, setSelectedSkill] = createSignal<SkillInfo | undefined>(undefined)
  const [skillOpen, setSkillOpen] = createSignal(false)

  const rawSkills = createMemo(() => data.location.skill.list({ directory: location().directory }) ?? [])
  const rawServers = createMemo(() => data.location.mcp.server.list({ directory: location().directory }) ?? [])
  const running = () => props.session.data.working()
  const local = useLocal()

  // Products (MCP / API key / CLI) the current agent can use. Refetched when
  // MCP status or credentials change; the server caches detection for 60s.
  // A failed detection is kept as a flag: an empty list would otherwise read as
  // "this agent has no tools", which is a different and wrong statement.
  const [capabilityFailed, setCapabilityFailed] = createSignal(false)
  const [capabilities, { refetch: refetchCapabilities }] = createResource(
    () => ({ directory: location().directory, agent: local.agent.current()?.name }),
    async (input) => {
      try {
        const result = await sdk.api.capability.list({ location: { directory: input.directory }, agent: input.agent })
        setCapabilityFailed(false)
        return result.data
      } catch {
        setCapabilityFailed(true)
        return [] as CapabilityInfo[]
      }
    },
    { initialValue: [] },
  )
  for (const type of ["capability.updated", "mcp.status.changed"] as const) {
    onCleanup(sdk.event.on(type, () => void refetchCapabilities()))
  }
  const catalog = createMemo(() =>
    capabilities().map((item) => ({
      id: item.id,
      binaries: item.channels.cli ? [item.channels.cli.binary] : [],
      hosts: item.channels.api?.hosts ?? [],
    })),
  )
  const toggleMcp = useMcpToggle(
    () => location().directory,
    () => void refetchCapabilities(),
  )

  const tracker = createSessionUsageTracker({
    sessionID: () => props.session.identity.sessionID(),
    messages: () => props.session.history.messages(),
    servers: createMemo(() => rawServers().map((server) => server.name)),
    running,
    revertMessageID: () => props.session.data.revertMessageID(),
    event: sdk.event,
    catalog,
  })

  const toolUsage = (id: string): ToolChannelUsage | undefined => {
    const item = capabilities().find((entry) => entry.id === id)
    const base = tracker.tool(id)
    const mcpLevels = (item?.channels.mcp ?? []).map((server) => tracker.mcp(server.server))
    const mcp = mcpLevels.includes("active") ? "active" : mcpLevels.includes("used") ? "used" : undefined
    if (!base && !mcp) return undefined
    return { ...base, mcp }
  }
  const tools = createMemo<CapabilityInfo[], undefined>((previous) => {
    const sorted = sortTools(capabilities(), toolUsage)
    if (!running()) return sorted
    return freezeOrder(
      sorted,
      previous?.map((item) => item.id),
      (item) => item.id,
    )
  }, undefined)

  // Order is frozen while the agent runs so rows do not jump under the cursor
  // on every tool call; newly used items still light up in place.
  const skills = createMemo<SkillInfo[], undefined>((previous) => {
    const sorted = sortByUsage(
      rawSkills(),
      (skill) => tracker.skill(skill.id),
      (skill) => skill.name,
    )
    if (!running()) return sorted
    return freezeOrder(
      sorted,
      previous?.map((skill) => skill.id),
      (skill) => skill.id,
    )
  }, undefined)

  const routines = useRoutines()
  const browser = useBrowserStore()

  const openSkill = (skill: SkillInfo) => {
    setSelectedSkill(skill)
    setSkillOpen(true)
  }

  const panels: Record<SidebarPanelSectionID, Section> = {
    browser: {
      id: "browser",
      icon: <Icon name="monitor" size="small" />,
      title: () => language.t("session.sidebar.browser"),
      body: () => (
        <BrowserPreview
          session={props.session}
          thumbnail={browser.thumbnail(browser.active()?.id ?? "")?.url}
          url={browser.active()?.url}
          state={browser.control()}
        />
      ),
    },
    skills: {
      id: "skills",
      icon: <Icon name="brain" size="small" />,
      title: () => language.t("session.sidebar.skills"),
      count: () => skills().length,
      empty: () => language.t("session.sidebar.skills.empty"),
      body: () => <SkillsList skills={skills()} level={tracker.skill} onOpen={openSkill} />,
    },
    tools: {
      id: "tools",
      icon: <Icon name="terminal" size="small" />,
      title: () => language.t("session.sidebar.tools"),
      count: () => tools().length,
      empty: () => language.t("session.sidebar.tools.empty"),
      error: () => (capabilityFailed() ? language.t("session.sidebar.tools.error") : undefined),
      body: () => (
        <ToolsList
          items={tools()}
          usage={toolUsage}
          mcpActiveTool={tracker.mcpActiveTool}
          onToggleMcp={(server) => toggleMcp.mutate(server)}
        />
      ),
    },
    routines: {
      id: "routines",
      icon: <Icon name="reset" size="small" />,
      title: () => language.t("session.sidebar.routines"),
      count: () => routines().length,
      empty: () => language.t("session.sidebar.routines.empty"),
      actions: <RoutinesActions />,
      body: () => <RoutinesList routines={routines()} />,
    },
  }
  const list: Section[] = SIDEBAR_SECTION_ORDER.map((id) => panels[id])

  return (
    <>
      <Show
        when={props.mode !== "rail"}
        fallback={
          <div
            data-slot="session-extensions"
            data-mode="rail"
            class="flex h-full min-h-0 flex-col items-center gap-1 p-1"
          >
            <For each={list}>{(section) => <RailButton section={section} />}</For>
          </div>
        }
      >
        <div data-slot="session-extensions" data-mode="full" class="flex h-full min-h-0 flex-col overflow-hidden p-2">
          <AgentHeader session={props.session} />
          <For each={list}>
            {(section) => (
              <SidebarSection
                id={section.id}
                sections={sections}
                title={section.title()}
                icon={section.icon}
                count={section.count?.()}
                empty={section.empty?.()}
                error={section.error?.()}
                actions={section.actions}
              >
                {section.body()}
              </SidebarSection>
            )}
          </For>
        </div>
      </Show>
      <Show when={selectedSkill()}>
        {(skill) => <SkillDetailDialog skill={skill()} open={skillOpen} onOpenChange={setSkillOpen} />}
      </Show>
    </>
  )
}

function RailButton(props: { section: Section }) {
  const [shown, setShown] = createSignal(false)
  const count = () => props.section.count?.()
  const fallback = () =>
    sectionFallback({ count: count(), empty: props.section.empty?.(), error: props.section.error?.() })
  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs={IconButton}
      triggerProps={{
        variant: "ghost-muted",
        size: "small",
        class: "relative !size-8 shrink-0",
        state: shown() ? "pressed" : undefined,
        "aria-label": props.section.title(),
        title: props.section.title(),
        "data-rail-section": props.section.id,
      }}
      trigger={
        <span class="relative flex items-center justify-center">
          {props.section.icon}
          <Show when={count() !== undefined && count()! > 0}>
            <span class="absolute -right-2.5 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full border border-v2-border-border-weaker-base bg-v2-background-bg-base px-1 text-[10px] leading-none tabular-nums text-v2-text-text-muted">
              {count()! > 99 ? "99+" : count()}
            </span>
          </Show>
        </span>
      }
      class="w-[280px] max-w-[calc(100vw-40px)] [&_[data-slot=popover-body]]:p-1"
      gutter={6}
      placement="left-start"
    >
      <div class="flex max-h-[60vh] flex-col overflow-y-auto">
        <div class="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">
          {props.section.title()}
        </div>
        <Show when={fallback()} fallback={props.section.body()}>
          {(text) => (
            <div
              class="px-2 pb-1 text-[12px] leading-4"
              classList={{
                "text-v2-text-text-muted": !props.section.error?.(),
                "text-v2-text-text-danger": !!props.section.error?.(),
              }}
            >
              {text()}
            </div>
          )}
        </Show>
      </div>
    </Popover>
  )
}
