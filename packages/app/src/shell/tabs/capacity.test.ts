import { describe, expect, test } from "bun:test"
import { OPEN_SESSION_TAB_LIMIT, selectTabToEvict } from "./capacity"
import { tabKey, type Tab } from "@/shell/tabs/tabs"
import type { ServerConnection } from "@/runtime/server/registry"

const server = "http://localhost:1" as ServerConnection.Key
const session = (id: string): Tab => ({ type: "session", server, sessionId: id })
const draft = (id: string): Tab => ({ type: "draft", draftID: id, server, directory: "C:/dev/one" })
const sessions = (count: number) => Array.from({ length: count }, (_, index) => session(`s${index}`))

const noProtection = new Set<string>()
const noRecency = new Map<string, number>()

describe("selectTabToEvict", () => {
  test("returns undefined at or under the limit", () => {
    expect(
      selectTabToEvict({ tabs: sessions(20), protectedKeys: noProtection, recency: noRecency, limit: 20 }),
    ).toBeUndefined()
  })

  test("evicts once over the limit", () => {
    const tabs = sessions(21)
    expect(
      selectTabToEvict({ tabs, protectedKeys: noProtection, recency: noRecency, limit: 20 }),
    ).toBe(tabKey(tabs[0]))
  })

  test("drafts do not count toward the limit and are never evicted", () => {
    const tabs = [...sessions(20), draft("d1"), draft("d2")]
    expect(selectTabToEvict({ tabs, protectedKeys: noProtection, recency: noRecency, limit: 20 })).toBeUndefined()
  })

  test("never evicts a protected tab", () => {
    const tabs = sessions(21)
    const victim = selectTabToEvict({
      tabs,
      protectedKeys: new Set([tabKey(tabs[0]), tabKey(tabs[1])]),
      recency: noRecency,
      limit: 20,
    })
    expect(victim).toBe(tabKey(tabs[2]))
  })

  test("evicts the least recently activated", () => {
    const tabs = sessions(21)
    const recency = new Map(tabs.map((tab, index) => [tabKey(tab), 100 - index]))
    // tabs[20] has the lowest counter
    expect(selectTabToEvict({ tabs, protectedKeys: noProtection, recency, limit: 20 })).toBe(tabKey(tabs[20]))
  })

  test("ties break toward the earliest store position", () => {
    const tabs = sessions(21)
    const recency = new Map([[tabKey(tabs[5]), 7]])
    // everything except tabs[5] is 0; the earliest of those is tabs[0]
    expect(selectTabToEvict({ tabs, protectedKeys: noProtection, recency, limit: 20 })).toBe(tabKey(tabs[0]))
  })

  test("returns undefined when every over-limit tab is protected", () => {
    const tabs = sessions(21)
    const victim = selectTabToEvict({
      tabs,
      protectedKeys: new Set(tabs.map(tabKey)),
      recency: noRecency,
      limit: 20,
    })
    expect(victim).toBeUndefined()
  })

  test("the shipped limit sits below the reopen-stack cap", () => {
    expect(OPEN_SESSION_TAB_LIMIT).toBe(20)
  })
})
