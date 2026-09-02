import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previous = Object.fromEntries(Env.passwordKeys.map((key) => [key, process.env[key]]))
  const previousValue = process.env.OPENCODE_SESSION_ENV_TEST
  for (const key of Env.passwordKeys) process.env[key] = key
  process.env.OPENCODE_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  for (const key of Env.passwordKeys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  if (previousValue === undefined) delete process.env.OPENCODE_SESSION_ENV_TEST
  else process.env.OPENCODE_SESSION_ENV_TEST = previousValue

  for (const key of Env.passwordKeys) expect(environment[key]).toBeUndefined()
  expect(environment.OPENCODE_SESSION_ENV_TEST).toBe("included")
})

test("password keys cover the branded, every previous and the upstream spellings, in precedence order", () => {
  expect(Env.passwordKeys).toEqual([
    "FORCE_AGENT_PASSWORD",
    "FORCE_AGENT_SERVER_PASSWORD",
    "LABHARNESS_PASSWORD",
    "LABHARNESS_SERVER_PASSWORD",
    "LABFY_PASSWORD",
    "LABFY_SERVER_PASSWORD",
    "POWER_PASSWORD",
    "POWER_SERVER_PASSWORD",
    "OPENCODE_PASSWORD",
    "OPENCODE_SERVER_PASSWORD",
  ])
})
