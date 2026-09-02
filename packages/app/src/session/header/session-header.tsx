import { createMemo } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { StatusPopover } from "@/shell/status/status-popover"
import { TitlebarRight } from "@/shell/titlebar/right-slot"
import { SessionHeaderActions, type SessionHeaderActionsState } from "./session-header-actions"

export function SessionHeader() {
  const language = useLanguage()
  const settings = useSettings()

  const status = settings.visibility.status

  const actions = createMemo<SessionHeaderActionsState>(() => ({
    status: status() ? { label: language.t("status.popover.trigger"), content: () => <StatusPopover /> } : undefined,
  }))

  return (
    <TitlebarRight>
      <SessionHeaderActions state={actions()} />
    </TitlebarRight>
  )
}
