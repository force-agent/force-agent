import { Icon } from "@opencode-ai/ui/icon"
import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { controlLabelKey } from "@/session/browser/store"
import type { SessionModel } from "@/session/model"

/**
 * 16:9 thumbnail of the tab the agent is driving, fed by the browser store
 * (`GET /api/browser/tabs/:id/thumbnail` as an object URL). Clicking opens the
 * Browser tab.
 */
export function BrowserPreview(props: {
  session: SessionModel
  thumbnail?: string
  url?: string
  state?: "idle" | "agent" | "human" | "handoff-login"
}) {
  const language = useLanguage()
  const openTab = () => props.session.layout.view().workspaceTab.set("browser")
  return (
    <button
      type="button"
      data-slot="session-browser-preview"
      class="group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[6px] border border-v2-border-border-weaker-base bg-v2-background-bg-layer-01 text-v2-text-text-faint hover:border-v2-border-border-weak-base"
      title={props.url ?? language.t("session.sidebar.browser.open")}
      onClick={openTab}
    >
      <Show
        when={props.thumbnail}
        fallback={
          <span class="flex flex-col items-center gap-1 text-[11px]">
            <Icon name="monitor" size="small" class="text-v2-icon-icon-faint" />
            <span>{language.t("session.sidebar.browser.empty")}</span>
          </span>
        }
      >
        {(src) => <img src={src()} alt="" class="size-full object-cover" draggable={false} />}
      </Show>
      <Show when={props.url}>
        <span class="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-[color-mix(in_oklab,var(--v2-background-bg-base)_85%,transparent)] px-1.5 py-0.5 text-[10px] text-v2-text-text-muted">
          <Show when={props.state && props.state !== "idle"}>
            <span
              class="shrink-0 rounded-full px-1 text-[9px] uppercase tracking-wide"
              classList={{
                "bg-v2-icon-icon-accent text-white": props.state === "agent",
                "bg-v2-state-border-info text-white": props.state === "human" || props.state === "handoff-login",
              }}
            >
              {language.t(controlLabelKey[props.state!])}
            </span>
          </Show>
          <span class="min-w-0 truncate">{props.url}</span>
        </span>
      </Show>
    </button>
  )
}
