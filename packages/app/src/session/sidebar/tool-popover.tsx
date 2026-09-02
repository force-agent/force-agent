import { Popover } from "@opencode-ai/ui/popover"
import type { CapabilityInfo } from "@opencode-ai/client/promise"
import { createResource, For, Show, type JSX } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import type { ToolChannelUsage } from "./tools-section"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  disabled: "mcp.status.disabled",
  pending: "mcp.status.pending",
} as const

/**
 * Detail card for a product: each MCP server with status, tool count, the
 * tool running now and a connect/disconnect action; the API method and hosts;
 * the CLI binary and where it was found. Tool names are fetched lazily.
 */
export function ToolPopover(props: {
  item: CapabilityInfo
  open: boolean
  onOpenChange: (open: boolean) => void
  usage: ToolChannelUsage | undefined
  mcpActiveTool: (server: string) => string | undefined
  onToggleMcp: (server: string) => void
  children: JSX.Element
}) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const location = useWorkspaceLocation()
  const servers = () => props.item.channels.mcp ?? []

  const [tools] = createResource(
    () => (props.open ? servers().filter((server) => server.status.status === "connected").map((server) => server.server) : []),
    async (names) => {
      const entries = await Promise.all(
        names.map(async (server) => {
          try {
            const result = await sdk.api.mcp.tools({ server, location: { directory: location().directory } })
            return [server, result.data.map((tool) => tool.name)] as const
          } catch {
            return [server, []] as const
          }
        }),
      )
      return Object.fromEntries(entries) as Record<string, string[]>
    },
  )

  const statusLabel = (status: string) => {
    const key = statusLabels[status as keyof typeof statusLabels]
    return key ? language.t(key) : status
  }

  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      triggerAs="div"
      triggerProps={{ class: "block w-full" }}
      trigger={props.children}
      class="w-[300px] max-w-[calc(100vw-40px)] [&_[data-slot=popover-body]]:p-2"
      gutter={6}
      placement="left-start"
    >
      <div class="flex flex-col gap-2 text-[12px]">
        <div class="flex items-baseline justify-between gap-2">
          <span class="font-medium text-v2-text-text-base">{props.item.name}</span>
          <Show when={!props.item.allowed}>
            <span class="text-[10px] text-v2-text-text-faint">{language.t("session.sidebar.tools.denied")}</span>
          </Show>
        </div>

        <Show when={servers().length > 0}>
          <section class="flex flex-col gap-1">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">
              {language.t("session.sidebar.tools.channel.mcp")}
            </div>
            <For each={servers()}>
              {(server) => (
                <div class="flex flex-col gap-0.5 rounded-[6px] border border-v2-border-border-weaker-base px-2 py-1">
                  <div class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 truncate text-v2-text-text-base" data-usage={props.usage?.mcp}>
                      {server.server}
                    </span>
                    <span class="shrink-0 text-[10px] text-v2-text-text-faint">{statusLabel(server.status.status)}</span>
                    <Show when={server.status.status !== "pending"}>
                      <button
                        type="button"
                        class="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"
                        onClick={() => props.onToggleMcp(server.server)}
                      >
                        {server.status.status === "connected"
                          ? language.t("session.sidebar.tools.disconnect")
                          : language.t("session.sidebar.tools.connect")}
                      </button>
                    </Show>
                  </div>
                  <Show when={props.mcpActiveTool(server.server)}>
                    {(tool) => <div class="truncate text-[10px] text-v2-icon-icon-accent">{tool()}</div>}
                  </Show>
                  <Show when={server.status.status === "connected"}>
                    <div class="text-[10px] text-v2-text-text-faint">
                      {language.t("session.sidebar.tools.tools", { count: String(server.tools) })}
                      <Show when={tools()?.[server.server]?.length}>
                        <span class="ml-1 text-v2-text-text-faint">· {tools()![server.server]!.slice(0, 8).join(", ")}</span>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </section>
        </Show>

        <Show when={props.item.channels.api}>
          {(api) => (
            <section class="flex flex-col gap-0.5">
              <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">
                {language.t("session.sidebar.tools.channel.api")}
              </div>
              <div class="flex items-center gap-2" data-usage={props.usage?.api}>
                <span class="text-v2-text-text-base">{api().method}</span>
                <span class="text-[10px] text-v2-text-text-faint">
                  {api().connected ? "✓" : language.t("session.sidebar.tools.notConnected")}
                </span>
              </div>
              <Show when={api().hosts.length > 0}>
                <div class="truncate text-[10px] text-v2-text-text-faint">{api().hosts.join(", ")}</div>
              </Show>
            </section>
          )}
        </Show>

        <Show when={props.item.channels.cli}>
          {(cli) => (
            <section class="flex flex-col gap-0.5">
              <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">
                {language.t("session.sidebar.tools.channel.cli")}
              </div>
              <div class="flex items-center gap-2" data-usage={props.usage?.cli}>
                <code class="text-v2-text-text-base">{cli().binary}</code>
                <span class="min-w-0 truncate text-[10px] text-v2-text-text-faint">
                  {cli().found ? (cli().path ?? "✓") : language.t("session.sidebar.tools.notFound")}
                </span>
              </div>
            </section>
          )}
        </Show>
      </div>
    </Popover>
  )
}
