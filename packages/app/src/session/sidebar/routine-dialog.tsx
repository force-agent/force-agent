import { Button } from "@opencode-ai/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextInput } from "@opencode-ai/ui/text-input"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { RoutineInfo, RoutineRun } from "@opencode-ai/client/promise"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData, useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { formatServerError } from "@/runtime/server/errors"
import { useLocal } from "@/providers/models/selection"
import { useWorkspaceLocation } from "@/workspaces/location"
import { sessionHref } from "@/shell/routes/session"
import { showToast } from "@/shell/notifications/toast"
import {
  DEFAULT_SCHEDULE_FORM,
  cronToPreset,
  isValidCron,
  isValidTimezone,
  localTimezone,
  presetToCron,
  type RoutinePreset,
  type RoutineScheduleForm,
} from "./routine-presets"

const PRESETS: RoutinePreset[] = ["hourly", "daily", "weekly", "custom"]
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]
const HISTORY = 10

type ModelChoice = { id: string; providerID: string; label: string } | { id: ""; providerID: ""; label: string }

/**
 * Create/edit form for one routine plus its last runs. Runs refresh on
 * `routine.run.*` events so a "run now" from the list is visible here at once.
 */
export function RoutineDialog(props: { routine?: RoutineInfo }) {
  const dialog = useDialog()
  const language = useLanguage()
  const data = useData()
  const sdk = useServerSDK()
  const server = useServer()
  const location = useWorkspaceLocation()
  const local = useLocal()
  const navigate = useNavigate()
  const directory = () => location().directory

  const editing = () => props.routine !== undefined
  const initialSchedule = props.routine ? cronToPreset(props.routine.schedule) : DEFAULT_SCHEDULE_FORM

  const [form, setForm] = createStore({
    name: props.routine?.name ?? "",
    agent: props.routine?.agent ?? local.agent.current()?.name ?? "build",
    schedule: { ...initialSchedule } as RoutineScheduleForm,
    timezone: props.routine?.timezone ?? localTimezone(),
    task: (props.routine?.commandID ? "command" : "prompt") as "prompt" | "command",
    prompt: props.routine?.prompt ?? "",
    commandID: props.routine?.commandID ?? "",
    model: props.routine?.model
      ? { id: props.routine.model.id, providerID: props.routine.model.providerID }
      : undefined,
    enabled: props.routine?.enabled ?? true,
  })
  const [busy, setBusy] = createSignal(false)

  const agents = createMemo(() => local.agent.list().filter((agent) => agent.mode !== "subagent" && !agent.hidden))
  const commands = createMemo(() => data.location.command.list({ directory: directory() }) ?? [])
  const models = createMemo<ModelChoice[]>(() => [
    { id: "", providerID: "", label: language.t("routine.field.model.default") },
    ...(data.location.model.list({ directory: directory() }) ?? []).map((model) => ({
      id: model.modelID,
      providerID: model.providerID,
      label: `${model.providerID}/${model.name}`,
    })),
  ])
  const modelKey = (choice: ModelChoice) => `${choice.providerID}/${choice.id}`
  const currentModel = () =>
    models().find(
      (choice) => form.model && choice.id === form.model.id && choice.providerID === form.model.providerID,
    ) ?? models()[0]!

  const cron = () => presetToCron(form.schedule)
  const cronValid = () => isValidCron(cron())
  const minuteValid = () =>
    Number.isInteger(form.schedule.minute) && form.schedule.minute >= 0 && form.schedule.minute <= 59
  const timezoneValid = () => isValidTimezone(form.timezone.trim())
  const taskValid = () => (form.task === "prompt" ? form.prompt.trim().length > 0 : form.commandID.length > 0)
  const valid = () => form.name.trim().length > 0 && cronValid() && timezoneValid() && taskValid()

  const weekdayLabel = (day: number) =>
    new Intl.DateTimeFormat(language.locale(), { weekday: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2024, 0, 7 + day)),
    )
  const time = () => `${String(form.schedule.hour).padStart(2, "0")}:${String(form.schedule.minute).padStart(2, "0")}`
  const setTime = (value: string) => {
    const [hour, minute] = value.split(":").map(Number)
    if (Number.isFinite(hour)) setForm("schedule", "hour", hour!)
    if (Number.isFinite(minute)) setForm("schedule", "minute", minute!)
  }

  // History: last runs, refreshed on routine.run.* events for this routine.
  const [runs, { refetch }] = createResource(
    () => props.routine?.id,
    (id) =>
      sdk.api.routine.runs({ id, limit: HISTORY, location: { directory: directory() } }).then((result) => result.data),
    { initialValue: [] as RoutineRun[] },
  )
  const unsubscribe = [
    sdk.event.on("routine.run.started", (event) => {
      if (event.data.routineID === props.routine?.id) void refetch()
    }),
    sdk.event.on("routine.run.finished", (event) => {
      if (event.data.routineID === props.routine?.id) void refetch()
    }),
  ]
  onCleanup(() => unsubscribe.forEach((dispose) => dispose()))

  const payload = () => ({
    name: form.name.trim(),
    agent: form.agent,
    schedule: cron(),
    timezone: form.timezone.trim(),
    enabled: form.enabled,
  })
  const task = () => ({
    prompt: form.task === "prompt" ? form.prompt.trim() : undefined,
    commandID: form.task === "command" ? form.commandID : undefined,
    model: form.model,
  })

  const submit = async () => {
    if (!valid() || busy()) return
    setBusy(true)
    try {
      const location = { directory: directory() }
      if (props.routine) {
        // An update treats an absent key as "keep": a command, model or prompt the
        // form no longer has must be sent as null or the old one keeps running.
        const { prompt, commandID, model } = task()
        await sdk.api.routine.update({
          id: props.routine.id,
          location,
          ...payload(),
          prompt: prompt ?? null,
          commandID: commandID ?? null,
          model: model ?? null,
        })
      } else await sdk.api.routine.create({ location, ...payload(), ...task() })
      dialog.close()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("routine.error.save"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!props.routine || busy()) return
    setBusy(true)
    try {
      await sdk.api.routine.remove({ id: props.routine.id, location: { directory: directory() } })
      dialog.close()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("routine.error.save"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setBusy(false)
    }
  }

  const openSession = (run: RoutineRun) => {
    if (!run.sessionID) return
    dialog.close()
    navigate(sessionHref(server.key, run.sessionID))
  }

  const when = (at: number) =>
    new Intl.DateTimeFormat(language.locale(), {
      timeZone: form.timezone.trim() && timezoneValid() ? form.timezone.trim() : undefined,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(at))

  return (
    <Dialog fit class="w-[480px] max-w-[calc(100vw-32px)]">
      <DialogHeader>
        <DialogTitle>
          {editing() ? language.t("routine.dialog.edit.title") : language.t("routine.dialog.create.title")}
        </DialogTitle>
      </DialogHeader>
      <DialogBody class="flex w-full min-w-0 flex-col gap-4 px-4 pt-3 pb-2 text-[12px]">
        <Field label={language.t("routine.field.name")}>
          <TextInput
            type="text"
            class="!w-full"
            placeholder={language.t("routine.field.name.placeholder")}
            value={form.name}
            onInput={(event) => setForm("name", event.currentTarget.value)}
          />
        </Field>

        <div class="grid grid-cols-2 gap-3">
          <Field label={language.t("routine.field.agent")}>
            <Select
              options={agents().map((agent) => agent.name)}
              current={form.agent}
              onSelect={(value) => value && setForm("agent", value)}
              placement="bottom-start"
              gutter={6}
            />
          </Field>
          <Field label={language.t("routine.field.model")}>
            <Select
              options={models()}
              current={currentModel()}
              value={modelKey}
              label={(choice) => choice.label}
              onSelect={(choice) =>
                setForm("model", choice && choice.id ? { id: choice.id, providerID: choice.providerID } : undefined)
              }
              placement="bottom-start"
              gutter={6}
            />
          </Field>
        </div>

        <Field label={language.t("routine.field.schedule")}>
          <div class="flex flex-col gap-2">
            <Select
              options={PRESETS}
              current={form.schedule.preset}
              label={(preset) => language.t(`routine.preset.${preset}`)}
              onSelect={(preset) => {
                if (!preset) return
                setForm("schedule", "preset", preset)
                if (preset === "custom" && !form.schedule.cron) setForm("schedule", "cron", cron())
              }}
              placement="bottom-start"
              gutter={6}
            />
            <Show when={form.schedule.preset !== "custom"}>
              <div class="grid grid-cols-2 gap-3">
                <Show
                  when={form.schedule.preset !== "hourly"}
                  fallback={
                    <Field label={language.t("routine.field.time")}>
                      <TextInput
                        type="number"
                        class="!w-full"
                        min={0}
                        max={59}
                        value={form.schedule.minute}
                        onInput={(event) => setForm("schedule", "minute", Number(event.currentTarget.value) || 0)}
                      />
                      <Show when={!minuteValid()}>
                        <span class="text-[11px] text-v2-text-text-danger">
                          {language.t("routine.field.minute.invalid")}
                        </span>
                      </Show>
                    </Field>
                  }
                >
                  <Field label={language.t("routine.field.time")}>
                    <TextInput
                      type="time"
                      class="!w-full"
                      value={time()}
                      onInput={(event) => setTime(event.currentTarget.value)}
                    />
                  </Field>
                </Show>
                <Show when={form.schedule.preset === "weekly"}>
                  <Field label={language.t("routine.field.weekday")}>
                    <Select
                      options={WEEKDAYS}
                      current={form.schedule.weekday}
                      value={(day) => String(day)}
                      label={weekdayLabel}
                      onSelect={(day) => day !== null && setForm("schedule", "weekday", day)}
                      placement="bottom-start"
                      gutter={6}
                    />
                  </Field>
                </Show>
              </div>
            </Show>
            <Show when={form.schedule.preset === "custom"}>
              <Field label={language.t("routine.field.cron")} hint={language.t("routine.field.cron.hint")}>
                <TextInput
                  type="text"
                  class="!w-full font-mono"
                  value={form.schedule.cron}
                  onInput={(event) => setForm("schedule", "cron", event.currentTarget.value)}
                />
              </Field>
              <Show when={!cronValid()}>
                <span class="text-[11px] text-v2-text-text-danger">{language.t("routine.field.cron.invalid")}</span>
              </Show>
            </Show>
            <Field label={language.t("routine.field.timezone")}>
              <TextInput
                type="text"
                class="!w-full"
                value={form.timezone}
                onInput={(event) => setForm("timezone", event.currentTarget.value)}
              />
              <Show when={!timezoneValid()}>
                <span class="text-[11px] text-v2-text-text-danger">{language.t("routine.field.timezone.invalid")}</span>
              </Show>
            </Field>
          </div>
        </Field>

        <Field label={language.t("routine.field.task")}>
          <div class="flex gap-1">
            <Button
              type="button"
              size="small"
              variant={form.task === "prompt" ? "neutral" : "ghost"}
              onClick={() => setForm("task", "prompt")}
            >
              {language.t("routine.field.task.prompt")}
            </Button>
            <Button
              type="button"
              size="small"
              variant={form.task === "command" ? "neutral" : "ghost"}
              onClick={() => setForm("task", "command")}
            >
              {language.t("routine.field.task.command")}
            </Button>
          </div>
          <Show
            when={form.task === "prompt"}
            fallback={
              <Show
                when={commands().length > 0}
                fallback={
                  <span class="text-[11px] text-v2-text-text-faint">{language.t("routine.field.command.none")}</span>
                }
              >
                <Select
                  options={commands().map((command) => command.name)}
                  current={form.commandID || undefined}
                  onSelect={(value) => setForm("commandID", value ?? "")}
                  placement="bottom-start"
                  gutter={6}
                />
              </Show>
            }
          >
            <textarea
              class="min-h-[80px] w-full resize-y rounded-[6px] border border-v2-border-border-weaker-base bg-v2-background-bg-base px-2 py-1.5 text-[12px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint focus:border-v2-border-border-weak-base"
              placeholder={language.t("routine.field.prompt.placeholder")}
              value={form.prompt}
              onInput={(event) => setForm("prompt", event.currentTarget.value)}
            />
          </Show>
        </Field>

        <Switch checked={form.enabled} onChange={(checked) => setForm("enabled", checked)}>
          {language.t("routine.field.enabled")}
        </Switch>

        <Show when={editing()}>
          <Field label={language.t("routine.history.title")}>
            <Show
              when={runs().length > 0}
              fallback={<span class="text-[11px] text-v2-text-text-faint">{language.t("routine.history.empty")}</span>}
            >
              <ul class="flex flex-col">
                <For each={runs()}>
                  {(run) => (
                    <li class="flex h-6 items-center gap-2 text-[11px]">
                      <span class="session-sidebar-routine-dot" data-status={run.status} />
                      <span class="w-[80px] shrink-0 text-v2-text-text-muted">
                        {language.t(`routine.status.${run.status}`)}
                      </span>
                      <span class="min-w-0 flex-1 truncate tabular-nums text-v2-text-text-faint" title={run.error}>
                        {when(run.startedAt)}
                        <Show when={run.error}> · {run.error}</Show>
                      </span>
                      <Show when={run.sessionID}>
                        <button
                          type="button"
                          class="flex shrink-0 items-center gap-1 text-v2-text-text-muted hover:text-v2-text-text-base"
                          onClick={() => openSession(run)}
                        >
                          {language.t("routine.history.open")}
                          <Icon name="arrow-right" size="small" />
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Field>
        </Show>
      </DialogBody>
      <DialogFooter>
        <div class="flex w-full items-center gap-2">
          <Show when={editing()}>
            <Button type="button" variant="danger" size="small" disabled={busy()} onClick={() => void remove()}>
              {language.t("common.delete")}
            </Button>
          </Show>
          <span class="flex-1" />
          <Button type="button" variant="ghost" size="small" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="button" size="small" disabled={!valid() || busy()} onClick={() => void submit()}>
            {language.t("common.save")}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  )
}

function Field(props: { label: string; hint?: string; children: any }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="flex items-baseline gap-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">
        {props.label}
        <Show when={props.hint}>
          <span class="font-normal normal-case tracking-normal">{props.hint}</span>
        </Show>
      </span>
      {props.children}
    </label>
  )
}
