import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Routine } from "@opencode-ai/schema/routine"
import { isDue, isMissed, nextRun } from "@opencode-ai/core/routine/scheduler"

describe("Routine scheduler", () => {
  test("nextRun resolves in the routine's zone, not the process zone", () => {
    // 09:00 in São Paulo (UTC-3, no DST in 2026) is 12:00Z.
    const next = nextRun("0 9 * * 1", "America/Sao_Paulo", new Date("2026-09-01T12:00:00Z"))
    expect(next?.toISOString()).toBe("2026-09-07T12:00:00.000Z")
  })

  test("nextRun crosses the day boundary of the zone, not of UTC", () => {
    // 23:30 local on Sep 1 is 02:30Z on Sep 2; from 03:00Z Sep 1 that slot is still ahead.
    const next = nextRun("30 23 * * *", "America/Sao_Paulo", new Date("2026-09-01T03:00:00Z"))
    expect(next?.toISOString()).toBe("2026-09-02T02:30:00.000Z")
  })

  test("nextRun is strictly after `from`, so rescheduling from a run never repeats it", () => {
    const from = new Date("2026-09-01T12:00:00.000Z")
    expect(nextRun("*/1 * * * *", "UTC", from)?.toISOString()).toBe("2026-09-01T12:01:00.000Z")
  })

  test("nextRun handles a DST gap by moving to the next valid instant", () => {
    // Europe/Berlin springs forward on 2026-03-29: 02:30 local does not exist that day.
    const next = nextRun("30 2 * * *", "Europe/Berlin", new Date("2026-03-28T12:00:00Z"))
    expect(next).toBeInstanceOf(Date)
    expect(next!.getTime()).toBeGreaterThan(new Date("2026-03-29T00:00:00Z").getTime())
  })

  test("nextRun rejects bad input instead of throwing", () => {
    expect(nextRun("99 * * * *", "UTC", new Date())).toBeUndefined()
    expect(nextRun("0 0 0 * * *", "UTC", new Date())).toBeUndefined()
    expect(nextRun("* * * * *", "Not/AZone", new Date())).toBeUndefined()
  })

  test("missed means strictly overdue; due includes the exact slot", () => {
    const now = 1_000_000
    expect(isMissed(now - 1, now)).toBe(true)
    expect(isMissed(now, now)).toBe(false)
    expect(isMissed(undefined, now)).toBe(false)
    expect(isMissed(null, now)).toBe(false)
    expect(isDue(now, now)).toBe(true)
    expect(isDue(now + 1, now)).toBe(false)
  })

  test("schema shape check and strict cron check agree on the valid cases", () => {
    const decode = Schema.decodeUnknownSync(Routine.Schedule)
    expect(decode("*/5 * * * *")).toBe("*/5 * * * *")
    expect(Routine.isSchedule("*/5 * * * *")).toBe(true)
    expect(Routine.isSchedule("0 9 * * mon")).toBe(true)
    expect(() => decode("* * * *")).toThrow()
    expect(() => decode("0 0 0 * * *")).toThrow()
    expect(Routine.isSchedule("99 * * * *")).toBe(false)
    expect(Routine.isTimezone("America/Sao_Paulo")).toBe(true)
    expect(Routine.isTimezone("Not/AZone")).toBe(false)
  })
})
