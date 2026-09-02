import { Routine } from "@opencode-ai/schema/routine"

export type RoutinePreset = Routine.SchedulePreset

/** Form-level view of a five-field cron: preset + the few knobs each preset exposes. */
export type RoutineScheduleForm = {
  preset: RoutinePreset
  /** 0–59 (hourly, daily, weekly). */
  minute: number
  /** 0–23 (daily, weekly). */
  hour: number
  /** 0–6, Sunday = 0 (weekly). */
  weekday: number
  /** Raw expression (custom). */
  cron: string
}

export const DEFAULT_SCHEDULE_FORM: RoutineScheduleForm = {
  preset: "daily",
  minute: 0,
  hour: 9,
  weekday: 1,
  cron: "0 9 * * *",
}

export function presetToCron(form: RoutineScheduleForm): string {
  switch (form.preset) {
    case "hourly":
      return `${form.minute} * * * *`
    case "daily":
      return `${form.minute} ${form.hour} * * *`
    case "weekly":
      return `${form.minute} ${form.hour} * * ${form.weekday}`
    case "custom":
      return form.cron.trim()
  }
}

/** Recovers the preset knobs from a stored expression; anything richer stays `custom`. */
export function cronToPreset(cron: string): RoutineScheduleForm {
  const fields = cron.trim().split(/\s+/)
  const form: RoutineScheduleForm = { ...DEFAULT_SCHEDULE_FORM, preset: "custom", cron: cron.trim() }
  if (fields.length !== 5) return form
  const [minute, hour, day, month, weekday] = fields
  const num = (value: string, max: number) => {
    if (!/^\d{1,2}$/.test(value)) return undefined
    const parsed = Number(value)
    return parsed <= max ? parsed : undefined
  }
  const m = num(minute!, 59)
  if (m === undefined || day !== "*" || month !== "*") return form
  if (hour === "*" && weekday === "*") return { ...form, preset: "hourly", minute: m }
  const h = num(hour!, 23)
  if (h === undefined) return form
  if (weekday === "*") return { ...form, preset: "daily", minute: m, hour: h }
  const w = num(weekday!, 6)
  if (w === undefined) return form
  return { ...form, preset: "weekly", minute: m, hour: h, weekday: w }
}

export const isValidCron = Routine.isSchedule
export const isValidTimezone = Routine.isTimezone

export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** "14:30" when the instant falls today in the given zone, otherwise "12/09 14:30". */
export function formatNextRun(at: number, locale: string, timezone: string, now = Date.now()) {
  const date = new Date(at)
  const opts = { timeZone: timezone }
  const day = (value: Date) => new Intl.DateTimeFormat("en-CA", { ...opts, dateStyle: "short" }).format(value)
  const time = new Intl.DateTimeFormat(locale, { ...opts, hour: "2-digit", minute: "2-digit" }).format(date)
  if (day(date) === day(new Date(now))) return time
  const dayLabel = new Intl.DateTimeFormat(locale, { ...opts, day: "2-digit", month: "2-digit" }).format(date)
  return `${dayLabel} ${time}`
}
