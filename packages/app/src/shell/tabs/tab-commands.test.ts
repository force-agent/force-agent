import { describe, expect, test } from "bun:test"
import { adjacentTabKey } from "@/shell/titlebar/tab-order"
import { tabKey, type Tab } from "@/shell/tabs/tabs"
import type { ServerConnection } from "@/runtime/server/registry"

const server = "http://localhost:1" as ServerConnection.Key

const tabs: Tab[] = [
  { type: "session", server, sessionId: "s1" },
  { type: "draft", draftID: "d1", server, directory: "C:/dev/one" },
  { type: "session", server, sessionId: "s2" },
]

describe("tab navigation over the full store order", () => {
  test("adjacentTabKey cycles forward and wraps", () => {
    const keys = tabs.map(tabKey)
    expect(adjacentTabKey(keys, keys[0], 1)).toBe(keys[1])
    expect(adjacentTabKey(keys, keys[2], 1)).toBe(keys[0])
  })

  test("adjacentTabKey cycles backward and wraps", () => {
    const keys = tabs.map(tabKey)
    expect(adjacentTabKey(keys, keys[0], -1)).toBe(keys[2])
  })

  test("nth-tab jump targets store order", () => {
    expect(tabs.slice(0, 9).map((tab, index) => ({ index: index + 1, key: tabKey(tab) }))).toHaveLength(3)
  })
})
