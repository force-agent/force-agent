import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { createComputed, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { OpenCodeEventStream } from "@/runtime/server/client"
import {
  collectSessionUsage,
  createUsageCache,
  emptyUsage,
  type SessionUsage,
  type ToolCatalogEntry,
  type ToolUsage,
  type UsageLevel,
} from "./usage-domain"

function sameUsage(a: SessionUsage, b: SessionUsage) {
  const sameRecord = (x: Record<string, string>, y: Record<string, string>) => {
    const keys = Object.keys(x)
    if (keys.length !== Object.keys(y).length) return false
    return keys.every((key) => x[key] === y[key])
  }
  const sameTools = (x: Record<string, ToolUsage>, y: Record<string, ToolUsage>) => {
    const keys = Object.keys(x)
    if (keys.length !== Object.keys(y).length) return false
    return keys.every((key) => x[key]?.api === y[key]?.api && x[key]?.cli === y[key]?.cli)
  }
  return (
    sameRecord(a.skills, b.skills) &&
    sameRecord(a.mcps, b.mcps) &&
    sameRecord(a.mcpActiveTools, b.mcpActiveTools) &&
    sameTools(a.tools, b.tools)
  )
}

const EMPTY: SessionUsage = emptyUsage()

/** How long an item stays lit as "active" after its tool call ended. Sub-second calls are invisible otherwise. */
export const ACTIVE_HOLD_MS = 1500
/** How long the last MCP tool name stays visible after the session goes idle. */
const MCP_TOOL_TTL_MS = 5000

/**
 * Reactive per-session usage of skills and MCP servers.
 *
 * The core is a memo over the already-reduced message store, which gives
 * reset-on-session-switch, mid-history hydration, SSE-reconnect recovery and
 * abort degradation for free. Settled messages are memoized per id so a
 * streaming delta only re-folds the tail, not the whole history.
 *
 * The only extra input is `session.skill.activated` (path B: slash-command
 * activation) which has no reducer case in the client store — those marks live
 * in a small session-scoped store until refetch materializes the skill message.
 */
export function createSessionUsageTracker(input: {
  sessionID: Accessor<string | undefined>
  messages: Accessor<readonly SessionMessageInfo[]>
  servers: Accessor<readonly string[]>
  running: Accessor<boolean>
  revertMessageID: Accessor<string | undefined>
  event: OpenCodeEventStream
  /** Products (from the capability list) whose CLI/API use should be attributed. */
  catalog?: Accessor<readonly ToolCatalogEntry[]>
}) {
  const [activated, setActivated] = createStore<Record<string, true>>({})
  const [ttlActiveTools, setTtlActiveTools] = createStore<Record<string, string>>({})
  let ttlTimer: ReturnType<typeof setTimeout> | undefined
  let cache = createUsageCache()
  // Keys are `skill:<id>` / `mcp:<name>` → timestamp the item first went active.
  const activeSince = new Map<string, number>()

  const clearTtl = () => {
    if (ttlTimer) clearTimeout(ttlTimer)
    ttlTimer = undefined
  }

  // Reset session-scoped state whenever the viewed session changes: path-B
  // marks, the per-message memo and the MCP tool TTL (otherwise session B shows
  // session A's last tool for up to 5s).
  createComputed((previous: string | undefined) => {
    const current = input.sessionID()
    if (previous !== current) {
      setActivated(reconcile({}))
      cache = createUsageCache()
      clearTtl()
      setTtlActiveTools(reconcile({}))
      activeSince.clear()
    }
    return current
  })

  const dispose = input.event.on("session.skill.activated", (event) => {
    if (event.data.sessionID !== input.sessionID()) return
    setActivated(event.data.id, true)
  })

  const baseUsage = createMemo<SessionUsage>(
    () => {
      const base = collectSessionUsage({
        messages: input.messages(),
        servers: input.servers(),
        running: input.running(),
        revertMessageID: input.revertMessageID(),
        cache,
        catalog: input.catalog?.(),
      })
      for (const id of Object.keys(activated)) {
        if (!base.skills[id]) base.skills[id] = "used"
      }
      return base
    },
    EMPTY,
    { equals: sameUsage },
  )

  // TTL for mcpActiveTools: after status !== running, keep visible for a while
  // then clear. Prevents a stuck "active" if abort fails to update the tool part
  // before the session goes idle.
  createComputed(() => {
    const running = input.running()
    const baseActive = baseUsage().mcpActiveTools

    if (running) {
      clearTtl()
      const same = (() => {
        const keys = Object.keys(ttlActiveTools)
        if (keys.length !== Object.keys(baseActive).length) return false
        return keys.every((k) => ttlActiveTools[k] === baseActive[k])
      })()
      if (!same) setTtlActiveTools(reconcile({ ...baseActive }))
      return
    }

    const ttlKeys = Object.keys(ttlActiveTools)
    const baseKeys = Object.keys(baseActive)
    if (ttlKeys.length === 0 && baseKeys.length === 0) return
    if (ttlKeys.length === 0 && baseKeys.length > 0) setTtlActiveTools(reconcile({ ...baseActive }))
    if (ttlTimer) return
    ttlTimer = setTimeout(() => {
      setTtlActiveTools(reconcile({}))
      ttlTimer = undefined
    }, MCP_TOOL_TTL_MS)
  })

  // Minimum visible duration for "active": a tool call that finishes in 300ms
  // would otherwise never show the neon ring.
  const [holdTick, setHoldTick] = createSignal(0)
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleHold = (ms: number) => {
    if (holdTimer) return
    holdTimer = setTimeout(() => {
      holdTimer = undefined
      setHoldTick((n) => n + 1)
    }, ms)
  }

  onCleanup(() => {
    dispose()
    clearTtl()
    if (holdTimer) clearTimeout(holdTimer)
  })

  const withHold = (record: Record<string, UsageLevel>, prefix: string, now: number, out: Record<string, UsageLevel>) => {
    let changed = false
    for (const [key, level] of Object.entries(record)) {
      const holdKey = `${prefix}:${key}`
      if (level === "active") {
        if (!activeSince.has(holdKey)) activeSince.set(holdKey, now)
        out[key] = "active"
        continue
      }
      const since = activeSince.get(holdKey)
      if (since !== undefined) {
        const remaining = ACTIVE_HOLD_MS - (now - since)
        if (remaining > 0) {
          out[key] = "active"
          changed = true
          scheduleHold(remaining)
          continue
        }
        activeSince.delete(holdKey)
      }
      out[key] = level
    }
    return changed
  }

  const usage = createMemo<SessionUsage>(
    () => {
      holdTick()
      const base = baseUsage()
      const now = Date.now()
      const skills: Record<string, UsageLevel> = {}
      const mcps: Record<string, UsageLevel> = {}
      const heldSkills = withHold(base.skills, "skill", now, skills)
      const heldMcps = withHold(base.mcps, "mcp", now, mcps)

      // While not running, expose the TTL snapshot of MCP tool names until it expires.
      let mcpActiveTools = base.mcpActiveTools
      if (!input.running() && Object.keys(ttlActiveTools).length > 0) {
        const ttl = ttlActiveTools as Record<string, string>
        const same =
          Object.keys(ttl).length === Object.keys(mcpActiveTools).length &&
          Object.keys(ttl).every((k) => ttl[k] === mcpActiveTools[k])
        if (!same) mcpActiveTools = { ...ttl }
      }

      if (!heldSkills && !heldMcps && mcpActiveTools === base.mcpActiveTools) return base
      return { skills, mcps, mcpActiveTools, tools: base.tools }
    },
    EMPTY,
    { equals: sameUsage },
  )

  return {
    usage,
    skill: (id: string): UsageLevel | undefined => usage().skills[id],
    mcp: (name: string): UsageLevel | undefined => usage().mcps[name],
    mcpActiveTool: (name: string): string | undefined => usage().mcpActiveTools[name],
    tool: (id: string): ToolUsage | undefined => usage().tools[id],
  }
}
