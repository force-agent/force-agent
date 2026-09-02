import { Show, createMemo, type ComponentProps, type JSX } from "solid-js"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"

import { useData } from "@/runtime/server/current"
import { useLanguage } from "@/runtime/i18n/language"
import { useProviders } from "@/providers/catalog/providers"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useSessionLayout } from "@/session/session-layout"
import { focusWorkspaceTab } from "@/session/tabs/workspace-tab-focus"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: ComponentProps<typeof Tooltip>["placement"]
}

function ContextTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const data = useData()
  const language = useLanguage()
  const sdk = useWorkspaceLocation()
  const providers = useProviders(() => sdk().directory)
  const { params, view, sessionKey } = useSessionLayout()

  const variant = createMemo(() => props.variant ?? "button")
  const messages = createMemo(() => (params.id ? data.session.message.list(params.id) : []))
  const info = createMemo(() => (params.id ? data.session.get(params.id) : undefined))

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const context = createMemo(() => {
    const message = messages().findLast((item) => item.type === "assistant" && !!item.tokens)
    if (message?.type !== "assistant" || !message.tokens) return
    const model = providers.all().get(message.model.providerID)?.models[message.model.id]
    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write
    return {
      total,
      usage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })
  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })

  const openContext = () => {
    if (!params.id) return
    const current = view().workspaceTab.current()
    focusWorkspaceTab(sessionKey(), current === "context" ? "chat" : "context")
  }

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        appearance="indicator"
        size={16}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={{
          "--progress-circle-background": "var(--v2-background-bg-layer-04, var(--border-weak-base))",
          "--progress-circle-background-overlay": "var(--v2-overlay-simple-overlay-pressed, transparent)",
          "--progress-circle-progress": "var(--v2-icon-icon-base, var(--icon-base))",
        }}
      />
    </div>
  )
  const compactCircle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle appearance="compact" percentage={context()?.usage ?? 0} />
    </div>
  )

  const tooltipValue = () => (
    <div class="flex w-[120px] flex-col gap-2">
      <ContextTooltipRow name={language.t("context.usage.cost")} value={cost()} />
      <ContextTooltipRow name={language.t("context.usage.usage")} value={`${context()?.usage ?? 0}%`} />
      <ContextTooltipRow
        name={language.t("context.usage.tokens")}
        value={context()?.total.toLocaleString(language.intl()) ?? "0"}
      />
    </div>
  )

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"} shift={-8}>
        <Show
          when={variant() === "indicator"}
          fallback={
            <IconButton
              type="button"
              variant="ghost-muted"
              size="large"
              icon={compactCircle()}
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            />
          }
        >
          {circle()}
        </Show>
      </Tooltip>
    </Show>
  )
}
