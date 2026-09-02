import { Cron, DateTime, Option, Result } from "effect"

/**
 * Pure scheduling math: no clock, no database. `from` is exclusive, so
 * calling this with "now" right after a run never yields the run just made.
 */
export function nextRun(schedule: string, timezone: string, from: Date): Date | undefined {
  const zone = DateTime.zoneMakeNamed(timezone)
  if (Option.isNone(zone)) return undefined
  const trimmed = schedule.trim()
  if (trimmed.split(/\s+/).length !== 5) return undefined
  const parsed = Cron.parse(trimmed, zone.value)
  if (Result.isFailure(parsed)) return undefined
  return Cron.next(parsed.success, from)
}

/** A due time strictly in the past means the server was not around to run it. */
export function isMissed(nextRunAt: number | null | undefined, now: number): boolean {
  return typeof nextRunAt === "number" && nextRunAt < now
}

/** Due when the tick lands on or after the scheduled minute. */
export function isDue(nextRunAt: number | null | undefined, now: number): boolean {
  return typeof nextRunAt === "number" && nextRunAt <= now
}
