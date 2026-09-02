import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode-ai/client/promise"

export type UsageLevel = "active" | "used"

export type SessionUsage = {
  skills: Record<string, UsageLevel>
  mcps: Record<string, UsageLevel>
  mcpActiveTools: Record<string, string>
  /** Per product (capability id): which non-MCP channels the session touched. MCP usage lives in `mcps` by server. */
  tools: Record<string, ToolUsage>
}

export type ToolUsage = { api?: UsageLevel; cli?: UsageLevel }

/** What the sidebar knows about a product: enough to attribute a shell command or a fetch to it. */
export type ToolCatalogEntry = {
  id: string
  binaries: readonly string[]
  hosts: readonly string[]
}

export function emptyUsage(): SessionUsage {
  return { skills: {}, mcps: {}, mcpActiveTools: {}, tools: {} }
}

/**
 * The executable a shell command line invokes: skips env assignments, `sudo`,
 * `env`, `npx`/`bunx`/`pnpm dlx`, takes only the first command of a pipeline
 * and drops the directory part (`/usr/bin/gh` → `gh`).
 */
export function commandBinary(command: string): string | undefined {
  const first = command.split(/\s*(?:\|\||&&|;|\|)\s*/)[0] ?? ""
  const tokens = first.trim().split(/\s+/).filter(Boolean)
  const wrappers = new Set(["sudo", "env", "npx", "bunx", "time", "nohup"])
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    if (wrappers.has(token) || token.startsWith("-")) continue
    if (token === "pnpm" && tokens[index + 1] === "dlx") {
      index += 1
      continue
    }
    return token.split("/").pop()
  }
  return undefined
}

/** Host of a URL, or undefined when the string is not an absolute URL. */
export function urlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function hostMatches(host: string, pattern: string): boolean {
  const target = pattern.toLowerCase()
  return host === target || host.endsWith(`.${target}`)
}

function markTool(target: Record<string, ToolUsage>, id: string, channel: keyof ToolUsage, level: UsageLevel) {
  const entry = (target[id] ??= {})
  if (level === "active" || entry[channel] !== "active") entry[channel] = level
}

/**
 * Messages the timeline actually shows: everything strictly before the staged
 * revert boundary. Mirrors the `message.id < revertMessageID` rule in
 * visibleTimelineMessages (session/timeline/controller-projection.ts); kept
 * local so this module stays pure and free of timeline/inbox concerns.
 */
export function messagesBeforeRevert<T extends { id: string }>(
  messages: readonly T[],
  revertMessageID?: string,
): readonly T[] {
  if (!revertMessageID) return messages
  return messages.filter((message) => message.id < revertMessageID)
}

/** Same sanitizer the server applies to MCP server/tool names before exposing them as tools. */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Map a direct tool-part name (`${sanitize(server)}_${sanitize(tool)}`, single
 * underscore) back to a server. Longest sanitized prefix wins so a server named
 * `my_server` beats `my` for the tool `my_server_foo`.
 */
export function mcpServerForToolName(tool: string, servers: readonly string[]): string | undefined {
  return matchToolPrefix(tool, sanitizedPrefixes(servers))
}

/** [server, sanitizedPrefix] pairs. Hoisted out of the per-part loop by collectSessionUsage:
 *  sanitizing inside the loop costs one regex per server per tool part, and the memo re-runs
 *  on every streaming delta. */
export type ServerPrefix = readonly [server: string, prefix: string]

function sanitizedPrefixes(servers: readonly string[]): ServerPrefix[] {
  return servers.map((server) => [server, sanitizeMcpName(server)] as const)
}

function matchToolPrefix(tool: string, prefixes: readonly ServerPrefix[]): string | undefined {
  let match: string | undefined
  let matchLength = -1
  for (const [server, prefix] of prefixes) {
    if (prefix.length <= matchLength) continue
    if (tool.startsWith(prefix + "_")) {
      match = server
      matchLength = prefix.length
    }
  }
  return match
}

/**
 * Map a Code Mode qualified call path (`server.tool`, dot-separated — dots in
 * tool names are namespace separators) back to a server. Longest prefix wins.
 */
export function mcpServerForCodemodePath(path: string, servers: readonly string[]): string | undefined {
  return matchCodemodePrefix(path, sanitizedPrefixes(servers))
}

function matchCodemodePrefix(path: string, prefixes: readonly ServerPrefix[]): string | undefined {
  let match: string | undefined
  let matchLength = -1
  for (const [server, prefix] of prefixes) {
    if (prefix.length <= matchLength) continue
    if (path === prefix || path.startsWith(prefix + ".")) {
      match = server
      matchLength = prefix.length
    }
  }
  return match
}

type ExecuteCall = { tool?: unknown; status?: unknown }

function toolInputId(part: SessionMessageAssistantTool): string | undefined {
  const input = part.state.status === "streaming" ? undefined : part.state.input
  if (input && typeof input === "object") {
    const id = (input as Record<string, unknown>).id
    if (typeof id === "string") return id
  }
  if (part.state.status === "streaming") {
    // Best effort while the input is still a streaming JSON string.
    try {
      const parsed = JSON.parse(part.state.input) as unknown
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).id === "string")
        return (parsed as Record<string, unknown>).id as string
    } catch {
      return undefined
    }
  }
  return undefined
}

function mark(target: Record<string, UsageLevel>, key: string | undefined, level: UsageLevel) {
  if (!key) return
  if (level === "active" || target[key] !== "active") target[key] = level
}

function markActiveTool(target: Record<string, string>, key: string | undefined, tool: string | undefined, level: UsageLevel) {
  if (!key || !tool) return
  if (level === "active" && !target[key]) target[key] = tool
}

/**
 * Derive which skills and MCP servers are in use for a session, from the
 * already-reduced message store. Pure: re-running over the current session's
 * messages IS the reset semantics (new session = empty scan).
 *
 * ACTIVE is gated on `running` so aborted runs that leave an orphaned
 * "running" tool part degrade to "used" once the execution status goes idle.
 */
export function collectSessionUsage(input: {
  messages: readonly SessionMessageInfo[]
  servers: readonly string[]
  running: boolean
  /** Staged revert boundary; messages at or after it are not shown by the timeline. */
  revertMessageID?: string
  /**
   * Optional per-message memo. Settled messages (user/skill, or assistant with
   * `time.completed` and no live tool part) never change again, so their fold is
   * reused across re-runs; only the streaming tail is re-scanned.
   */
  cache?: UsageCache
  /** Products whose CLI binaries / API hosts should light up in the Tools section. */
  catalog?: readonly ToolCatalogEntry[]
}): SessionUsage {
  const usage = emptyUsage()
  const prefixes = sanitizedPrefixes(input.servers)
  const catalog = input.catalog ?? []
  const cache = input.cache
  const cacheKey = [
    input.servers.join(" "),
    catalog.map((entry) => `${entry.id}:${entry.binaries.join(",")}:${entry.hosts.join(",")}`).join("|"),
  ].join(" ")
  if (cache && cache.key !== cacheKey) {
    cache.entries.clear()
    cache.key = cacheKey
  }

  const visible = messagesBeforeRevert(input.messages, input.revertMessageID)
  for (const message of visible) {
    const settled = isSettled(message)
    const hit = settled && cache ? cache.entries.get(message.id) : undefined
    if (hit) {
      mergeUsage(usage, hit)
      continue
    }
    const part = foldMessageUsage(message, prefixes, input.running, catalog)
    if (settled && cache) cache.entries.set(message.id, part)
    mergeUsage(usage, part)
  }

  // Cheap sweep so a long-lived cache does not outgrow the session it mirrors.
  if (cache && cache.entries.size > visible.length * 2 + 16) {
    const keep = new Set(visible.map((message) => message.id))
    for (const id of cache.entries.keys()) if (!keep.has(id)) cache.entries.delete(id)
  }

  return usage
}

/** Memo of per-message folds, keyed by message id. `key` guards the servers list it was built for. */
export type UsageCache = { key: string; entries: Map<string, SessionUsage> }

export function createUsageCache(): UsageCache {
  return { key: "", entries: new Map() }
}

/** A message whose usage contribution can never change again. */
export function isSettled(message: SessionMessageInfo): boolean {
  if (message.type !== "assistant") return true
  if (!message.time.completed) return false
  for (const part of message.content) {
    if (part.type !== "tool") continue
    if (part.state.status === "streaming" || part.state.status === "running") return false
  }
  return true
}

/** Merge `source` into `target` with the same precedence rules as `mark`. */
export function mergeUsage(target: SessionUsage, source: SessionUsage) {
  for (const [key, level] of Object.entries(source.skills)) mark(target.skills, key, level)
  for (const [key, level] of Object.entries(source.mcps)) mark(target.mcps, key, level)
  for (const [key, tool] of Object.entries(source.mcpActiveTools)) {
    if (!target.mcpActiveTools[key]) target.mcpActiveTools[key] = tool
  }
  for (const [id, channels] of Object.entries(source.tools)) {
    if (channels.api) markTool(target.tools, id, "api", channels.api)
    if (channels.cli) markTool(target.tools, id, "cli", channels.cli)
  }
}

function toolInputString(part: SessionMessageAssistantTool, key: string): string | undefined {
  const input = part.state.status === "streaming" ? undefined : part.state.input
  if (input && typeof input === "object") {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === "string") return value
  }
  return undefined
}

/** Usage contributed by one message. Pure; the unit the cache memoizes. */
export function foldMessageUsage(
  message: SessionMessageInfo,
  prefixes: readonly ServerPrefix[],
  running: boolean,
  catalog: readonly ToolCatalogEntry[] = [],
): SessionUsage {
  const usage = emptyUsage()
  if (message.type === "user") {
    for (const skill of message.skills ?? []) mark(usage.skills, skill.id, "used")
    return usage
  }
  if (message.type === "skill") {
    mark(usage.skills, message.skill, "used")
    return usage
  }
  if (message.type !== "assistant") return usage

  for (const part of message.content) {
    if (part.type !== "tool") continue
    const live = part.state.status === "streaming" || part.state.status === "running"
    const level: UsageLevel = live && running ? "active" : "used"

    if (part.name === "skill") {
      mark(usage.skills, toolInputId(part), level)
      continue
    }

    // CLI channel: a shell command whose executable belongs to a catalogued product.
    if (part.name === "shell" && catalog.length > 0) {
      const command = toolInputString(part, "command")
      const binary = command ? commandBinary(command) : undefined
      if (binary) {
        for (const entry of catalog) if (entry.binaries.includes(binary)) markTool(usage.tools, entry.id, "cli", level)
      }
      continue
    }

    // API channel: a fetch (plain or in-page) against a catalogued host.
    if ((part.name === "webfetch" || part.name === "browser_fetch" || part.name === "browser_navigate") && catalog.length > 0) {
      const url = toolInputString(part, "url")
      const host = url ? urlHost(url) : undefined
      if (host) {
        for (const entry of catalog) {
          if (entry.hosts.some((pattern) => hostMatches(host, pattern))) markTool(usage.tools, entry.id, "api", level)
        }
      }
      continue
    }

    // Code Mode: inner MCP calls surface as execute-part metadata toolCalls.
    const metadata = part.state.status === "streaming" ? undefined : part.state.metadata
    const toolCalls = metadata?.toolCalls
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls as ExecuteCall[]) {
        if (typeof call?.tool !== "string") continue
        const server = matchCodemodePrefix(call.tool, prefixes)
        const callLive = call.status === "running"
        const callLevel: UsageLevel = callLive && live && running ? "active" : "used"
        mark(usage.mcps, server, callLevel)
        markActiveTool(usage.mcpActiveTools, server, call.tool, callLevel)
      }
    }

    // Direct MCP tool part.
    //
    // Known false positive, unfixable client-side: a non-MCP tool literally named
    // `${sanitizedServer}_something` (e.g. an MCP server "github" plus a plugin tool
    // "github_create_issue") lights that server up. Tool origin lives in
    // `tool.options.namespace` (packages/core/src/tool/runtime.ts), which is server-side
    // only — AssistantTool carries just {id,name,executed,state,time} and mcp.list does not
    // return tool ids. The real fixes are upstream schema changes: put the namespace on the
    // tool part, or have mcp.list return each server's tool ids.
    {
      const server = matchToolPrefix(part.name, prefixes)
      mark(usage.mcps, server, level)
      markActiveTool(usage.mcpActiveTools, server, part.name, level)
    }
  }
  return usage
}

export { sanitizedPrefixes }

/** Rank for ordering the sidebar: active first, then used, then idle. */
export function usageRank(level: UsageLevel | undefined): number {
  if (level === "active") return 0
  if (level === "used") return 1
  return 2
}

/**
 * Sort a copy of `items` by usage rank then by name using pt-BR locale.
 * Pure and stable for the sidebar lists.
 */
export function sortByUsage<T>(
  items: readonly T[],
  getLevel: (item: T) => UsageLevel | undefined,
  getName: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    const diff = usageRank(getLevel(a)) - usageRank(getLevel(b))
    if (diff !== 0) return diff
    return getName(a).localeCompare(getName(b), "pt-BR", { sensitivity: "base" })
  })
}

/**
 * Keep the order of a previous render while the agent is running so items do
 * not jump under the cursor on every tool call. Items already present keep
 * their previous position; newcomers go to the end in `sorted` order.
 * Returns `sorted` itself when there is no previous order to honour.
 */
export function freezeOrder<T>(sorted: readonly T[], previousIDs: readonly string[] | undefined, getID: (item: T) => string): T[] {
  if (!previousIDs || previousIDs.length === 0) return [...sorted]
  const index = new Map(previousIDs.map((id, i) => [id, i] as const))
  const kept: T[] = []
  const added: T[] = []
  for (const item of sorted) (index.has(getID(item)) ? kept : added).push(item)
  kept.sort((a, b) => index.get(getID(a))! - index.get(getID(b))!)
  return [...kept, ...added]
}
