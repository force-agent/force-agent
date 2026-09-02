import { describe, expect, test } from "bun:test"
import { cronToPreset, formatNextRun, isValidCron, presetToCron } from "./routine-presets"

describe("routine presets", () => {
  test("presets map to five-field cron", () => {
    expect(presetToCron({ preset: "hourly", minute: 15, hour: 9, weekday: 1, cron: "" })).toBe("15 * * * *")
    expect(presetToCron({ preset: "daily", minute: 0, hour: 9, weekday: 1, cron: "" })).toBe("0 9 * * *")
    expect(presetToCron({ preset: "weekly", minute: 30, hour: 8, weekday: 1, cron: "" })).toBe("30 8 * * 1")
    expect(presetToCron({ preset: "custom", minute: 0, hour: 0, weekday: 0, cron: " */2 * * * * " })).toBe(
      "*/2 * * * *",
    )
  })

  test("cron round-trips to the preset that produced it", () => {
    expect(cronToPreset("15 * * * *")).toMatchObject({ preset: "hourly", minute: 15 })
    expect(cronToPreset("0 9 * * *")).toMatchObject({ preset: "daily", minute: 0, hour: 9 })
    expect(cronToPreset("30 8 * * 1")).toMatchObject({ preset: "weekly", minute: 30, hour: 8, weekday: 1 })
  })

  test("anything richer than the presets stays custom", () => {
    expect(cronToPreset("*/2 * * * *")).toMatchObject({ preset: "custom", cron: "*/2 * * * *" })
    expect(cronToPreset("0 9 1 * *")).toMatchObject({ preset: "custom" })
    expect(cronToPreset("0 9 * * mon")).toMatchObject({ preset: "custom" })
    expect(cronToPreset("0 9 * *")).toMatchObject({ preset: "custom" })
  })

  test("validation follows the server rule", () => {
    expect(isValidCron("*/5 * * * *")).toBe(true)
    expect(isValidCron("99 * * * *")).toBe(false)
    expect(isValidCron("0 0 0 * * *")).toBe(false)
  })

  test("next run shows only the time when it lands today in the routine's zone", () => {
    const now = Date.parse("2026-09-01T12:00:00Z")
    expect(formatNextRun(Date.parse("2026-09-01T17:30:00Z"), "pt-BR", "America/Sao_Paulo", now)).toBe("14:30")
    expect(formatNextRun(Date.parse("2026-09-02T12:00:00Z"), "pt-BR", "America/Sao_Paulo", now)).toBe("02/09 09:00")
  })
})
