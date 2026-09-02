import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { RoutineInfo } from "@opencode-ai/client/promise"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { useWorkspaceLocation } from "@/workspaces/location"
import { showToast } from "@/shell/notifications/toast"
import { formatServerError } from "@/runtime/server/errors"
import { RoutineDialog } from "./routine-dialog"
import { formatNextRun } from "./routine-presets"

/** Reactive routines of the current directory, kept fresh by `routine.*` events through the client store. */
export function useRoutines() {
  const data = useData()
  const location = useWorkspaceLocation()
  return createMemo(() => data.location.routine.list({ directory: location().directory }) ?? [])
}

/** Section body: one 26px row per routine. Fits both the list-of-sections sidebar and the rail popover. */
export function RoutinesList(props: { routines: readonly RoutineInfo[] }) {
  const sdk = useServerSDK()
  const location = useWorkspaceLocation()
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal<string | undefined>(undefined)

  const open = (routine: RoutineInfo) => dialog.show(() => <RoutineDialog routine={routine} />)

  const fail = (key: "routine.error.save" | "routine.error.run", error: unknown) =>
    showToast({ variant: "error", title: language.t(key), description: formatServerError(error, language.t) })

  const toggle = async (routine: RoutineInfo, enabled: boolean) => {
    setBusy(routine.id)
    await sdk.api.routine
      .update({ id: routine.id, location: { directory: location().directory }, enabled })
      .catch((error) => fail("routine.error.save", error))
      .finally(() => setBusy(undefined))
  }

  const run = async (routine: RoutineInfo) => {
    setBusy(routine.id)
    await sdk.api.routine
      .run({ id: routine.id, location: { directory: location().directory } })
      .catch((error) => fail("routine.error.run", error))
      .finally(() => setBusy(undefined))
  }

  const next = (routine: RoutineInfo) => {
    if (!routine.enabled) return language.t("session.sidebar.routines.paused")
    if (routine.nextRunAt === undefined) return undefined
    return language.t("session.sidebar.routines.next", {
      time: formatNextRun(routine.nextRunAt, language.locale(), routine.timezone),
    })
  }

  return (
    <div data-slot="session-sidebar-list">
      <For each={props.routines}>
        {(routine) => (
          <div
            class="session-sidebar-item session-sidebar-routine"
            data-enabled={routine.enabled ? "" : undefined}
            data-status={routine.lastRunStatus}
            role="button"
            tabIndex={0}
            title={routine.prompt ?? routine.commandID}
            onClick={() => open(routine)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                open(routine)
              }
            }}
          >
            <Icon name="reset" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <span class="min-w-0 flex-1 truncate">{routine.name}</span>
            <span class="session-sidebar-routine-next shrink-0 text-[10px] tabular-nums text-v2-text-text-faint">
              {next(routine)}
            </span>
            <Show when={routine.lastRunStatus}>
              <span
                class="session-sidebar-routine-dot"
                data-status={routine.lastRunStatus}
                title={language.t(`routine.status.${routine.lastRunStatus!}`)}
              />
            </Show>
            <span class="session-sidebar-routine-actions" onClick={(event) => event.stopPropagation()}>
              <Switch
                checked={routine.enabled}
                disabled={busy() === routine.id}
                onChange={(checked) => void toggle(routine, checked)}
                hideLabel
              >
                {language.t("session.sidebar.routines.toggle")}
              </Switch>
              <IconButton
                type="button"
                variant="ghost-muted"
                size="small"
                icon={<Icon name="arrow-right" size="small" />}
                aria-label={language.t("session.sidebar.routines.run")}
                title={language.t("session.sidebar.routines.run")}
                disabled={busy() === routine.id || routine.lastRunStatus === "running"}
                onClick={() => void run(routine)}
              />
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

/** Header action: opens the create dialog. Lives outside the list so an empty section can still add. */
export function RoutinesActions() {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <IconButton
      type="button"
      variant="ghost-muted"
      size="small"
      icon={<Icon name="plus" size="small" />}
      aria-label={language.t("session.sidebar.routines.new")}
      title={language.t("session.sidebar.routines.new")}
      onClick={() => dialog.show(() => <RoutineDialog />)}
    />
  )
}

/**
 * Self-contained section (sticky 26px header with count and "+", collapsible)
 * for a sidebar that does not yet have a shared section component. Sidebars
 * with `SidebarSection` should mount `RoutinesList` + `RoutinesActions` instead.
 */
export function RoutinesSection() {
  const language = useLanguage()
  const routines = useRoutines()
  const [open, setOpen] = createSignal(true)
  return (
    <section class="flex flex-col" data-section="routines">
      <div
        data-slot="session-extensions-section"
        class="sticky top-0 z-10 flex h-[26px] shrink-0 items-center gap-1 rounded-[6px] bg-v2-background-bg-base px-1 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint"
      >
        <button
          type="button"
          class="flex h-full min-w-0 flex-1 items-center gap-1 text-left hover:text-v2-text-text-muted"
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name="chevron-down"
            size="small"
            class="shrink-0 transition-transform duration-150"
            style={{ transform: `rotate(${open() ? 0 : -90}deg)` }}
          />
          <Icon name="reset" size="small" />
          <span class="min-w-0 flex-1 truncate">{language.t("session.sidebar.routines")}</span>
          <span class="shrink-0 tabular-nums">{routines().length}</span>
        </button>
        <div class="flex shrink-0 items-center gap-0.5 normal-case tracking-normal">
          <RoutinesActions />
        </div>
      </div>
      <Show when={open()}>
        <Show
          when={routines().length > 0}
          fallback={
            <div class="px-2 pb-1 text-[11px] text-v2-text-text-faint">
              {language.t("session.sidebar.routines.empty")}
            </div>
          }
        >
          <div class="flex flex-col pb-1">
            <RoutinesList routines={routines()} />
          </div>
        </Show>
      </Show>
    </section>
  )
}
