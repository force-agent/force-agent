import { describe, expect, test } from "bun:test"
import { sortByUsage, usageRank, type UsageLevel } from "./usage-domain"

type Item = { id: string; name: string }

function makeItem(id: string, name: string): Item {
  return { id, name }
}

describe("usageRank", () => {
  test("active is 0, used is 1, idle/undefined is 2", () => {
    expect(usageRank("active")).toBe(0)
    expect(usageRank("used")).toBe(1)
    expect(usageRank(undefined)).toBe(2)
  })
})

describe("sortByUsage", () => {
  test("sorts by rank active < used < idle", () => {
    const items = [makeItem("c", "Charlie"), makeItem("a", "Alpha"), makeItem("b", "Bravo")]
    const levels: Record<string, UsageLevel | undefined> = {
      a: undefined,
      b: "used",
      c: "active",
    }
    const sorted = sortByUsage(items, (item) => levels[item.id], (item) => item.name)
    expect(sorted.map((i) => i.id)).toEqual(["c", "b", "a"])
  })

  test("within same rank sorts by name pt-BR locale base sensitivity", () => {
    const items = [makeItem("1", "zebra"), makeItem("2", "água"), makeItem("3", "Banana"), makeItem("4", "ábaco")]
    const sorted = sortByUsage(items, () => undefined, (item) => item.name)
    // localeCompare pt-BR base: case and accent insensitive, so á treats as a
    // Expected A-Z ignoring accents/case: ábaco (abaco), água (agua), Banana (banana), zebra
    expect(sorted.map((i) => i.name)).toEqual(["ábaco", "água", "Banana", "zebra"])
  })

  test("active items sorted alphabetically among themselves", () => {
    const items = [makeItem("x", "Zulu"), makeItem("y", "alpha"), makeItem("z", "Mike")]
    const levels: Record<string, UsageLevel | undefined> = {
      x: "active",
      y: "active",
      z: "active",
    }
    const sorted = sortByUsage(items, (item) => levels[item.id], (item) => item.name)
    expect(sorted.map((i) => i.name)).toEqual(["alpha", "Mike", "Zulu"])
  })

  test("mixed ranks with alphabetical tie-break per group", () => {
    const items = [
      makeItem("s1", "Zeta"),
      makeItem("s2", "alpha"),
      makeItem("s3", "Beta"),
      makeItem("s4", "gamma"),
    ]
    const levels: Record<string, UsageLevel | undefined> = {
      s1: "active",
      s2: "active",
      s3: "used",
      s4: undefined,
    }
    const sorted = sortByUsage(items, (item) => levels[item.id], (item) => item.name)
    // active: alpha, Zeta ; used: Beta ; idle: gamma
    expect(sorted.map((i) => i.id)).toEqual(["s2", "s1", "s3", "s4"])
  })

  test("does not mutate original array", () => {
    const items = [makeItem("b", "Bravo"), makeItem("a", "Alpha")]
    const copy = [...items]
    sortByUsage(items, () => undefined, (item) => item.name)
    expect(items.map((i) => i.id)).toEqual(copy.map((i) => i.id))
  })

  test("empty array returns empty", () => {
    expect(sortByUsage([], () => undefined, (item: Item) => item.name)).toEqual([])
  })

  test("servers shape: uses name as level key", () => {
    type Server = { name: string }
    const servers: Server[] = [{ name: "context7" }, { name: "alpha" }, { name: "trigger" }]
    const levels: Record<string, UsageLevel | undefined> = {
      context7: "used",
      alpha: "active",
      trigger: undefined,
    }
    const sorted = sortByUsage(servers, (s) => levels[s.name], (s) => s.name)
    expect(sorted.map((s) => s.name)).toEqual(["alpha", "context7", "trigger"])
  })
})

import { collectSessionUsage, createUsageCache, freezeOrder, isSettled } from "./usage-domain"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"

function userMessage(id: string, skills: string[] = []): SessionMessageInfo {
  return { id, type: "user", skills: skills.map((skill) => ({ id: skill })) } as unknown as SessionMessageInfo
}

function assistantMessage(id: string, input: { completed?: boolean; tools: Array<{ name: string; status: "completed" | "running" }> }) {
  return {
    id,
    type: "assistant",
    time: { created: 1, completed: input.completed ? 2 : undefined },
    content: input.tools.map((tool, index) => ({
      type: "tool",
      id: `${id}-${index}`,
      name: tool.name,
      state:
        tool.status === "running"
          ? { status: "running", input: {} }
          : { status: "completed", input: {}, output: "", metadata: {} },
    })),
  } as unknown as SessionMessageInfo
}

describe("isSettled", () => {
  test("user messages and completed assistants are settled; streaming tails are not", () => {
    expect(isSettled(userMessage("u1"))).toBe(true)
    expect(isSettled(assistantMessage("a1", { completed: true, tools: [{ name: "github_x", status: "completed" }] }))).toBe(true)
    expect(isSettled(assistantMessage("a2", { completed: false, tools: [{ name: "github_x", status: "completed" }] }))).toBe(false)
    expect(isSettled(assistantMessage("a3", { completed: true, tools: [{ name: "github_x", status: "running" }] }))).toBe(false)
  })
})

describe("collectSessionUsage with cache", () => {
  test("memoizes settled messages and re-folds only the tail", () => {
    const cache = createUsageCache()
    const settled = assistantMessage("a1", { completed: true, tools: [{ name: "github_create", status: "completed" }] })
    const tail = assistantMessage("a2", { completed: false, tools: [{ name: "posthog_query", status: "running" }] })
    const first = collectSessionUsage({ messages: [userMessage("u1", ["effect"]), settled, tail], servers: ["github", "posthog"], running: true, cache })
    expect(first.skills.effect).toBe("used")
    expect(first.mcps.github).toBe("used")
    expect(first.mcps.posthog).toBe("active")
    expect(cache.entries.has("u1")).toBe(true)
    expect(cache.entries.has("a1")).toBe(true)
    expect(cache.entries.has("a2")).toBe(false)

    // A poisoned cache entry proves the hit path is taken for settled messages.
    cache.entries.set("a1", { skills: {}, mcps: { github: "used", poisoned: "used" }, mcpActiveTools: {}, tools: {} })
    const second = collectSessionUsage({ messages: [userMessage("u1", ["effect"]), settled, tail], servers: ["github", "posthog"], running: true, cache })
    expect(second.mcps.poisoned).toBe("used")
  })

  test("invalidates when the servers list changes", () => {
    const cache = createUsageCache()
    const settled = assistantMessage("a1", { completed: true, tools: [{ name: "github_create", status: "completed" }] })
    collectSessionUsage({ messages: [settled], servers: ["github"], running: false, cache })
    expect(cache.entries.size).toBe(1)
    const next = collectSessionUsage({ messages: [settled], servers: ["github", "posthog"], running: false, cache })
    expect(next.mcps.github).toBe("used")
    expect(cache.key).not.toBe("github")
  })
})

describe("freezeOrder", () => {
  test("keeps previous positions and appends newcomers in sorted order", () => {
    const sorted = [makeItem("c", "C"), makeItem("a", "A"), makeItem("d", "D"), makeItem("b", "B")]
    const previous = ["a", "b", "c"]
    expect(freezeOrder(sorted, previous, (item) => item.id).map((item) => item.id)).toEqual(["a", "b", "c", "d"])
  })

  test("without a previous order returns the sorted list", () => {
    const sorted = [makeItem("b", "B"), makeItem("a", "A")]
    expect(freezeOrder(sorted, undefined, (item) => item.id).map((item) => item.id)).toEqual(["b", "a"])
  })
})

import { commandBinary, urlHost } from "./usage-domain"

describe("commandBinary", () => {
  test("skips env assignments, sudo and runners; drops the directory", () => {
    expect(commandBinary("posthog query --json")).toBe("posthog")
    expect(commandBinary("FOO=1 sudo /usr/bin/gh pr list | head")).toBe("gh")
    expect(commandBinary("npx wrangler deploy && echo ok")).toBe("wrangler")
    expect(commandBinary("pnpm dlx supabase start")).toBe("supabase")
    expect(commandBinary("   ")).toBeUndefined()
  })
})

describe("tool channels in collectSessionUsage", () => {
  test("shell → cli and webfetch → api light up the catalogued product", () => {
    const catalog = [{ id: "posthog", binaries: ["posthog"], hosts: ["posthog.com"] }]
    const shellPart = { type: "tool", id: "t1", name: "shell", state: { status: "completed", input: { command: "posthog query" }, output: "", metadata: {} } }
    const fetchPart = { type: "tool", id: "t2", name: "webfetch", state: { status: "running", input: { url: "https://us.posthog.com/api/x" } } }
    const message = { id: "a1", type: "assistant", time: { created: 1 }, content: [shellPart, fetchPart] } as unknown as SessionMessageInfo
    const usage = collectSessionUsage({ messages: [message], servers: [], running: true, catalog })
    expect(usage.tools.posthog?.cli).toBe("used")
    expect(usage.tools.posthog?.api).toBe("active")
    expect(urlHost("not a url")).toBeUndefined()
  })
})
