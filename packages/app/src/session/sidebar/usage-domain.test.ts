import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import {
  collectSessionUsage,
  messagesBeforeRevert,
  mcpServerForCodemodePath,
  mcpServerForToolName,
  sanitizeMcpName,
} from "./usage-domain"

const time = { created: 0 }

function assistant(content: any[]): SessionMessageInfo {
  return { id: "a1", type: "assistant", time, agent: "x", model: {} as any, content } as SessionMessageInfo
}

function toolPart(name: string, status: string, extra: Record<string, unknown> = {}) {
  const state =
    status === "streaming"
      ? { status, input: (extra.input as string) ?? "" }
      : { status, input: extra.input ?? {}, metadata: extra.metadata ?? {}, content: extra.content ?? [{}] }
  return { type: "tool", id: "t1", name, state, time }
}

describe("sanitizeMcpName", () => {
  test("replaces disallowed characters with underscores", () => {
    expect(sanitizeMcpName("my server.io")).toBe("my_server_io")
    expect(sanitizeMcpName("ok_name-1")).toBe("ok_name-1")
  })
})

describe("mcpServerForToolName", () => {
  test("maps a direct tool name back to its server", () => {
    expect(mcpServerForToolName("context7_query-docs", ["context7"])).toBe("context7")
  })

  test("longest sanitized prefix wins for underscore-ambiguous names", () => {
    expect(mcpServerForToolName("my_server_foo", ["my", "my_server"])).toBe("my_server")
    expect(mcpServerForToolName("my_other_foo", ["my", "my_server"])).toBe("my")
  })

  test("requires an underscore boundary after the prefix", () => {
    expect(mcpServerForToolName("context7extra_tool", ["context7"])).toBeUndefined()
  })

  test("sanitizes the server name before matching", () => {
    expect(mcpServerForToolName("my_server_io_fetch", ["my server.io"])).toBe("my server.io")
  })
})

describe("mcpServerForCodemodePath", () => {
  test("maps a dotted code-mode path back to its server", () => {
    expect(mcpServerForCodemodePath("context7.query-docs", ["context7"])).toBe("context7")
  })

  test("bare server name matches", () => {
    expect(mcpServerForCodemodePath("context7", ["context7"])).toBe("context7")
  })

  test("no match returns undefined", () => {
    expect(mcpServerForCodemodePath("other.tool", ["context7"])).toBeUndefined()
  })
})

describe("collectSessionUsage", () => {
  test("skill tool part running while session runs is active", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("skill", "running", { input: { id: "devops" } })])],
      servers: [],
      running: true,
    })
    expect(usage.skills["devops"]).toBe("active")
  })

  test("running gate: orphaned running part degrades to used when idle", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("skill", "running", { input: { id: "devops" } })])],
      servers: [],
      running: false,
    })
    expect(usage.skills["devops"]).toBe("used")
  })

  test("completed skill tool is used", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("skill", "completed", { input: { id: "devops" } })])],
      servers: [],
      running: true,
    })
    expect(usage.skills["devops"]).toBe("used")
  })

  test("streaming skill input parses the id from the partial JSON string", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("skill", "streaming", { input: '{"id":"devops"}' })])],
      servers: [],
      running: true,
    })
    expect(usage.skills["devops"]).toBe("active")
  })

  test("user message skill attachments are used", () => {
    const user = { id: "u1", type: "user", time, text: "go", skills: [{ id: "seo", name: "seo" }] }
    const usage = collectSessionUsage({
      messages: [user as SessionMessageInfo],
      servers: [],
      running: false,
    })
    expect(usage.skills["seo"]).toBe("used")
  })

  test("skill transcript message (slash activation) is used", () => {
    const skillMessage = { id: "s1", type: "skill", time, skill: "research", name: "research" }
    const usage = collectSessionUsage({
      messages: [skillMessage as SessionMessageInfo],
      servers: [],
      running: false,
    })
    expect(usage.skills["research"]).toBe("used")
  })

  test("direct MCP tool part maps to its server", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("context7_query-docs", "running", { input: {} })])],
      servers: ["context7"],
      running: true,
    })
    expect(usage.mcps["context7"]).toBe("active")
  })

  test("code-mode toolCalls inside a running execute part", () => {
    const part = toolPart("execute", "running", {
      input: {},
      metadata: {
        toolCalls: [
          { tool: "context7.query-docs", status: "running" },
          { tool: "trigger.list_runs", status: "completed" },
        ],
      },
    })
    const usage = collectSessionUsage({
      messages: [assistant([part])],
      servers: ["context7", "trigger"],
      running: true,
    })
    expect(usage.mcps["context7"]).toBe("active")
    expect(usage.mcps["trigger"]).toBe("used")
  })

  test("code-mode toolCalls in a completed execute part are all used", () => {
    const part = toolPart("execute", "completed", {
      input: {},
      metadata: { toolCalls: [{ tool: "context7.query-docs", status: "running" }] },
    })
    const usage = collectSessionUsage({
      messages: [assistant([part])],
      servers: ["context7"],
      running: true,
    })
    expect(usage.mcps["context7"]).toBe("used")
  })

  test("active wins over used across messages", () => {
    const usage = collectSessionUsage({
      messages: [
        assistant([toolPart("context7_query-docs", "completed", { input: {} })]),
        assistant([toolPart("context7_query-docs", "running", { input: {} })]),
      ],
      servers: ["context7"],
      running: true,
    })
    expect(usage.mcps["context7"]).toBe("active")
  })

  test("non-MCP tools do not mark any server", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("bash", "running", { input: {} })])],
      servers: ["context7"],
      running: true,
    })
    expect(Object.keys(usage.mcps)).toHaveLength(0)
  })

  test("direct active tool exposes the running tool name", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("context7_query-docs", "running", { input: {} })])],
      servers: ["context7"],
      running: true,
    })
    expect(usage.mcpActiveTools["context7"]).toBe("context7_query-docs")
  })

  test("direct active tool gated by running flag clears on abort", () => {
    const msg = assistant([toolPart("context7_query-docs", "running", { input: {} })])
    const active = collectSessionUsage({ messages: [msg], servers: ["context7"], running: true })
    expect(active.mcpActiveTools["context7"]).toBe("context7_query-docs")
    const aborted = collectSessionUsage({ messages: [msg], servers: ["context7"], running: false })
    expect(aborted.mcps["context7"]).toBe("used")
    expect(aborted.mcpActiveTools["context7"]).toBeUndefined()
  })

  test("direct non-active tool does not expose active tool name", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("context7_query-docs", "completed", { input: {} })])],
      servers: ["context7"],
      running: true,
    })
    expect(usage.mcpActiveTools["context7"]).toBeUndefined()
  })

  test("code-mode active tool exposes the running dotted name", () => {
    const part = toolPart("execute", "running", {
      input: {},
      metadata: {
        toolCalls: [
          { tool: "context7.query-docs", status: "running" },
          { tool: "trigger.list_runs", status: "completed" },
        ],
      },
    })
    const usage = collectSessionUsage({
      messages: [assistant([part])],
      servers: ["context7", "trigger"],
      running: true,
    })
    expect(usage.mcpActiveTools["context7"]).toBe("context7.query-docs")
    expect(usage.mcpActiveTools["trigger"]).toBeUndefined()
  })

  test("code-mode active tool gated: name disappears when session aborts", () => {
    const part = toolPart("execute", "running", {
      input: {},
      metadata: { toolCalls: [{ tool: "context7.query-docs", status: "running" }] },
    })
    const msg = assistant([part])
    const active = collectSessionUsage({ messages: [msg], servers: ["context7"], running: true })
    expect(active.mcpActiveTools["context7"]).toBe("context7.query-docs")
    const aborted = collectSessionUsage({ messages: [msg], servers: ["context7"], running: false })
    expect(aborted.mcps["context7"]).toBe("used")
    expect(aborted.mcpActiveTools["context7"]).toBeUndefined()
  })

  test("code-mode tool in completed execute part does not expose active tool", () => {
    const part = toolPart("execute", "completed", {
      input: {},
      metadata: { toolCalls: [{ tool: "context7.query-docs", status: "running" }] },
    })
    const usage = collectSessionUsage({
      messages: [assistant([part])],
      servers: ["context7"],
      running: true,
    })
    expect(usage.mcpActiveTools["context7"]).toBeUndefined()
  })

  test("direct sanitized server prefix still exposes active tool", () => {
    const usage = collectSessionUsage({
      messages: [assistant([toolPart("my_server_io_fetch", "running", { input: {} })])],
      servers: ["my server.io"],
      running: true,
    })
    expect(usage.mcps["my server.io"]).toBe("active")
    expect(usage.mcpActiveTools["my server.io"]).toBe("my_server_io_fetch")
  })
})

describe("messagesBeforeRevert", () => {
  const list = [{ id: "m1" }, { id: "m2" }, { id: "m3" }]

  test("undefined boundary is the identity", () => {
    expect(messagesBeforeRevert(list, undefined)).toBe(list)
  })

  test("excludes the boundary message and everything after it", () => {
    expect(messagesBeforeRevert(list, "m2").map((m) => m.id)).toEqual(["m1"])
  })
})

describe("collectSessionUsage with a revert boundary", () => {
  test("a reverted turn no longer marks its MCP server", () => {
    const messages = [
      { id: "m1", type: "assistant", time, agent: "x", model: {} as any, content: [toolPart("context7_query-docs", "completed", { input: {} })] },
    ] as SessionMessageInfo[]
    expect(collectSessionUsage({ messages, servers: ["context7"], running: false }).mcps["context7"]).toBe("used")
    expect(
      collectSessionUsage({ messages, servers: ["context7"], running: false, revertMessageID: "m1" }).mcps["context7"],
    ).toBeUndefined()
  })

  test("work before the boundary still counts", () => {
    const messages = [
      { id: "m1", type: "assistant", time, agent: "x", model: {} as any, content: [toolPart("skill", "completed", { input: { id: "devops" } })] },
      { id: "m2", type: "assistant", time, agent: "x", model: {} as any, content: [toolPart("skill", "completed", { input: { id: "seo" } })] },
    ] as SessionMessageInfo[]
    const usage = collectSessionUsage({ messages, servers: [], running: false, revertMessageID: "m2" })
    expect(usage.skills["devops"]).toBe("used")
    expect(usage.skills["seo"]).toBeUndefined()
  })
})
