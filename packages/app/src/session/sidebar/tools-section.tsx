import { Icon } from "@opencode-ai/ui/icon"
import type { CapabilityInfo } from "@opencode-ai/client/promise"
import { createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { ToolPopover } from "./tool-popover"
import type { ToolUsage, UsageLevel } from "./usage-domain"

export type ToolChannelUsage = ToolUsage & { mcp?: UsageLevel }

/** Rank a product for the list: pinned first, then in use, then allowed, then by name. */
export function sortTools(items: readonly CapabilityInfo[], usage: (id: string) => ToolChannelUsage | undefined): CapabilityInfo[] {
  const rank = (item: CapabilityInfo) => {
    const use = usage(item.id)
    const active = use?.mcp === "active" || use?.api === "active" || use?.cli === "active"
    const used = !!(use?.mcp || use?.api || use?.cli)
    return (item.pinned ? 0 : 4) + (active ? 0 : used ? 1 : 2) + (item.allowed ? 0 : 8)
  }
  return [...items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }))
}

/**
 * One 26px row per product with three 14px icon chips — mcp, key (API key),
 * terminal (CLI) — whose fill says "available" and whose glow says "used in
 * this session". Everything else lives in the popover so the row stays scannable.
 */
export function ToolsList(props: {
  items: readonly CapabilityInfo[]
  usage: (id: string) => ToolChannelUsage | undefined
  mcpActiveTool: (server: string) => string | undefined
  onToggleMcp: (server: string) => void
}) {
  const language = useLanguage()
  const [envOpen, setEnvOpen] = createSignal(false)
  // Bare environment keys (`env:*`) are noise next to real products: they get
  // one collapsed row unless they were used in this session.
  const main = () => props.items.filter((item) => !item.id.startsWith("env:") || props.usage(item.id))
  const env = () => props.items.filter((item) => item.id.startsWith("env:") && !props.usage(item.id))
  return (
    <div data-slot="session-sidebar-list">
      <Rows items={main()} usage={props.usage} mcpActiveTool={props.mcpActiveTool} onToggleMcp={props.onToggleMcp} />
      <Show when={env().length > 0}>
        <button
          type="button"
          class="session-sidebar-item w-full text-left text-[11px] text-v2-text-text-faint"
          aria-expanded={envOpen()}
          onClick={() => setEnvOpen((value) => !value)}
        >
          <Icon
            name="chevron-down"
            size="small"
            class="shrink-0 transition-transform duration-150"
            style={{ transform: `rotate(${envOpen() ? 0 : -90}deg)` }}
          />
          <span class="min-w-0 flex-1 truncate">
            {language.t("session.sidebar.tools.envKeys", { count: String(env().length) })}
          </span>
        </button>
        <Show when={envOpen()}>
          <div class="pl-3">
            <Rows items={env()} usage={props.usage} mcpActiveTool={props.mcpActiveTool} onToggleMcp={props.onToggleMcp} />
          </div>
        </Show>
      </Show>
    </div>
  )
}

function Rows(props: {
  items: readonly CapabilityInfo[]
  usage: (id: string) => ToolChannelUsage | undefined
  mcpActiveTool: (server: string) => string | undefined
  onToggleMcp: (server: string) => void
}) {
  return (
    <For each={props.items}>
      {(item) => {
        const [open, setOpen] = createSignal(false)
        return (
          <ToolPopover
            item={item}
            open={open()}
            onOpenChange={setOpen}
            usage={props.usage(item.id)}
            mcpActiveTool={props.mcpActiveTool}
            onToggleMcp={props.onToggleMcp}
          >
            <ToolRow item={item} usage={props.usage(item.id)} pressed={open()} />
          </ToolPopover>
        )
      }}
    </For>
  )
}

function ToolRow(props: { item: CapabilityInfo; usage: ToolChannelUsage | undefined; pressed: boolean }) {
  const language = useLanguage()
  const mcp = () => props.item.channels.mcp ?? []
  const mcpStatus = () => {
    const servers = mcp()
    if (servers.length === 0) return undefined
    if (servers.some((server) => server.status.status === "connected")) return "connected"
    if (servers.some((server) => server.status.status === "needs_auth")) return "needs_auth"
    if (servers.some((server) => server.status.status === "pending")) return "pending"
    return servers[0]!.status.status
  }
  const level = (channel: keyof ToolChannelUsage) => props.usage?.[channel]
  const usageLevel = () => {
    const use = props.usage
    if (!use) return undefined
    if (use.mcp === "active" || use.api === "active" || use.cli === "active") return "active"
    if (use.mcp || use.api || use.cli) return "used"
    return undefined
  }
  const chip = (
    icon: "mcp" | "key" | "terminal",
    status: "on" | "off" | "warn" | "none",
    channel: keyof ToolChannelUsage,
    title: string,
  ) => (
    <span
      class="session-tool-chip"
      data-status={status}
      data-usage={level(channel)}
      data-channel={channel}
      role="img"
      aria-label={language.t(`session.sidebar.tools.chip.${channel}`)}
      title={title}
    >
      <Icon name={icon} size="small" />
    </span>
  )
  return (
    <div
      class="session-sidebar-item w-full cursor-pointer text-left"
      style={{ height: "26px" }}
      data-usage={usageLevel()}
      data-pressed={props.pressed ? "" : undefined}
      data-allowed={props.item.allowed ? "" : undefined}
      title={
        !props.item.allowed
          ? language.t("session.sidebar.tools.denied")
          : props.item.pinned
            ? language.t("session.sidebar.tools.pinned")
            : props.item.name
      }
    >
      <Icon name={mcp().length > 0 ? "mcp" : "terminal"} size="small" class="shrink-0 text-v2-icon-icon-muted" />
      <span class="min-w-0 flex-1 truncate" classList={{ "opacity-60": !props.item.allowed }}>
        {props.item.name}
      </span>
      <Show when={props.item.pinned}>
        <span class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-accent" />
      </Show>
      <span class="flex shrink-0 items-center gap-0.5">
        {chip(
          "mcp",
          mcpStatus() === "connected" ? "on" : mcpStatus() === "needs_auth" || mcpStatus() === "failed" ? "warn" : mcpStatus() ? "off" : "none",
          "mcp",
          `${language.t("session.sidebar.tools.channel.mcp")}: ${mcp().map((server) => server.server).join(", ") || "—"}`,
        )}
        {chip(
          "key",
          props.item.channels.api ? (props.item.channels.api.connected ? "on" : "off") : "none",
          "api",
          `${language.t("session.sidebar.tools.channel.api")}: ${props.item.channels.api ? props.item.channels.api.method : "—"}`,
        )}
        {chip(
          "terminal",
          props.item.channels.cli ? (props.item.channels.cli.found ? "on" : "off") : "none",
          "cli",
          `${language.t("session.sidebar.tools.channel.cli")}: ${props.item.channels.cli?.binary ?? "—"}`,
        )}
      </span>
    </div>
  )
}
