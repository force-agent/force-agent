import { Icon } from "@opencode-ai/ui/icon"
import { Menu } from "@opencode-ai/ui/menu"
import { createSignal, For } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useLocal } from "@/providers/models/selection"
import type { SessionModel } from "@/session/model"

function modelLabel(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined
  const record = model as { name?: unknown; id?: unknown }
  if (typeof record.name === "string") return record.name
  if (typeof record.id === "string") return record.id
  return undefined
}

/**
 * Who this panel is about: the agent driving the session, its model and a
 * running dot. The name is a menu so switching agent never leaves the panel.
 */
export function AgentHeader(props: { session: SessionModel }) {
  const local = useLocal()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const agent = () => local.agent.current()
  const running = () => props.session.data.working()

  return (
    <div data-slot="session-agent-header" class="flex h-8 shrink-0 items-center gap-1.5 px-1">
      <span class="relative flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-v2-background-bg-layer-01 text-v2-icon-icon-muted">
        <Icon name="workspace" size="small" />
        <span
          class="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-v2-background-bg-base"
          classList={{
            "bg-v2-icon-icon-accent session-agent-dot-running": running(),
            "bg-v2-icon-icon-faint": !running(),
          }}
          title={running() ? language.t("session.sidebar.usage.active") : undefined}
        />
      </span>
      <Menu gutter={4} modal={false} placement="bottom-start" open={open()} onOpenChange={setOpen}>
        <Menu.Trigger
          class="flex h-full min-w-0 flex-1 flex-col items-start justify-center rounded-[6px] px-1 text-left hover:bg-v2-overlay-simple-overlay-hover"
          aria-label={language.t("session.sidebar.agent.switch")}
        >
          <span class="w-full truncate text-[12px] font-medium leading-4 text-v2-text-text-base">
            {agent()?.name ?? "build"}
          </span>
          <span class="w-full truncate text-[10px] leading-3 text-v2-text-text-faint">
            {modelLabel(local.model.current()) ?? language.t("session.sidebar.agent.label")}
          </span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <For each={local.agent.list()}>
              {(item) => (
                <Menu.Item onSelect={() => local.agent.set(item.name)}>
                  <span classList={{ "font-medium": item.name === agent()?.name }}>{item.name}</span>
                </Menu.Item>
              )}
            </For>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}
