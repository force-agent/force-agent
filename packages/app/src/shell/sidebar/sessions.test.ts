import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { activeServerKey, filterProjectSessions, serverSectionCollapsed, sessionsForProject } from "./sessions"
import type { ServerConnection } from "@/runtime/server/registry"

function session(id: string, directory: string, updated: number): SessionInfo {
  return { id, title: id, location: { directory }, time: { created: updated, updated } } as SessionInfo
}

describe("sessionsForProject", () => {
  test("filters by worktree and sandboxes, newest first", () => {
    const sessions = [
      session("a", "C:/dev/one", 1),
      session("b", "C:/dev/two", 5),
      session("c", "C:/dev/one/sandbox", 3),
      session("d", "C:/dev/one", 9),
    ]
    const result = sessionsForProject(sessions, {
      worktree: "C:/dev/one",
      sandboxes: ["C:/dev/one/sandbox"],
      expanded: true,
    })
    expect(result.map((item) => item.id)).toEqual(["d", "c", "a"])
  })

  test("path keys normalize separators", () => {
    const sessions = [session("a", "C:\\dev\\one", 1)]
    const result = sessionsForProject(sessions, { worktree: "C:/dev/one", expanded: true })
    expect(result.map((item) => item.id)).toEqual(["a"])
  })
})

describe("serverSectionCollapsed", () => {
  test("honours the persisted flag in multi-server mode", () => {
    expect(serverSectionCollapsed({ a: true }, "a", true)).toBe(true)
    expect(serverSectionCollapsed({ a: false }, "a", true)).toBe(false)
  })

  test("ignores a stale persisted collapse when only one server remains", () => {
    // The collapse toggle only renders in multi-server mode, so honouring this
    // would leave the sidebar empty with no way to expand it again.
    expect(serverSectionCollapsed({ a: true }, "a", false)).toBe(false)
  })
})

describe("filterProjectSessions", () => {
  const project = { worktree: "C:/dev/one", name: "labharness", expanded: true }
  const list = [session("a", "C:/dev/one", 2), session("b", "C:/dev/one", 1)]

  test("empty filter passes everything through", () => {
    const result = filterProjectSessions({ sessions: list, project, filter: "" })
    expect(result.visible).toBe(true)
    expect(result.sessions).toHaveLength(2)
  })

  test("a project-name match keeps the full session list", () => {
    const result = filterProjectSessions({ sessions: list, project, filter: "labharn" })
    expect(result.visible).toBe(true)
    expect(result.sessions).toHaveLength(2)
  })

  test("no match anywhere hides the project", () => {
    const result = filterProjectSessions({ sessions: list, project, filter: "zzz" })
    expect(result.visible).toBe(false)
    expect(result.sessions).toHaveLength(0)
  })
})

describe("activeServerKey", () => {
  const server = "http://localhost:1" as ServerConnection.Key

  test("session route resolves to its server", () => {
    expect(activeServerKey({ type: "session", sessionId: "s1", server }, [])).toBe(server)
  })

  test("draft route resolves through the tabs store", () => {
    const tabs = [{ type: "draft" as const, draftID: "d1", server, directory: "C:/dev/one" }]
    expect(activeServerKey({ type: "draft", draftID: "d1" }, tabs)).toBe(server)
  })

  test("draft with no matching tab is undefined", () => {
    expect(activeServerKey({ type: "draft", draftID: "gone" }, [])).toBeUndefined()
  })

  test("home route is undefined", () => {
    expect(activeServerKey({ type: "home" }, [])).toBeUndefined()
  })
})
