export * as Capability from "./capability.js"

import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Context, Duration, Effect, Layer, Stream } from "effect"
import { Capability } from "@opencode-ai/schema/capability"
import type { Mcp as McpSchema } from "@opencode-ai/schema/mcp"
import { CapabilityEvent } from "@opencode-ai/schema/capability-event"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { Agent } from "./agent.js"
import { Bus } from "./bus.js"
import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import { Mcp } from "./mcp/index.js"
import { Permission } from "./permission.js"
import { McpTool } from "./tool/mcp.js"
import { CapabilityCatalog } from "./capability/catalog.js"
import { which } from "./util/which.js"

export const Info = Capability.Info
export type Info = Capability.Info
export const Event = { Updated: CapabilityEvent.Updated }

export interface ServerInput {
  readonly name: string
  readonly status: Mcp.Status
  readonly config?: McpSchema.ServerConfig | undefined
  readonly tools: number
}

export interface DetectInput {
  readonly servers: readonly ServerInput[]
  readonly integrations: readonly Integration.Info[]
  readonly env: Record<string, string | undefined>
  /** Catalog binaries only: `binary -> resolved path` (undefined when not found). */
  readonly binaries: ReadonlyMap<string, string | undefined>
}

/** Agent-independent detection result; `pinned`/`allowed` are resolved per agent in `resolve`. */
export interface Base {
  readonly id: string
  readonly name: string
  readonly channels: Capability.Channels
}

export interface Pin {
  readonly id: string
  readonly mcp?: string
}

// `*_API_KEY` / `*_TOKEN` (also stripping API_/ACCESS_ so CLOUDFLARE_R2_API_TOKEN reads env:cloudflare_r2).
const ENV_KEY = /_(API_KEY|API_TOKEN|ACCESS_TOKEN|TOKEN)$/

export function parsePin(item: string): Pin {
  const [id, rest] = item.split("=", 2)
  const trimmed = id.trim()
  if (rest === undefined) return { id: trimmed }
  const value = rest.trim()
  if (value.startsWith("mcp:")) return { id: trimmed, mcp: value.slice(4) }
  return { id: trimmed }
}

function host(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function candidates(server: ServerInput) {
  const out = [server.name]
  if (server.config?.type === "local") out.push(...server.config.command)
  if (server.config?.type === "remote") {
    const name = host(server.config.url)
    if (name) out.push(name)
  }
  return out
}

function present(env: DetectInput["env"], name: string) {
  const value = env[name]
  return value !== undefined && value !== ""
}

function api(
  product: CapabilityCatalog.Product,
  integrations: DetectInput["integrations"],
  env: DetectInput["env"],
): Capability.ApiChannel | undefined {
  const integration = product.integrationID ? integrations.find((item) => item.id === product.integrationID) : undefined
  const hosts = [...product.hosts]
  const connection = integration?.connections[0]
  if (integration && connection) {
    const method: Capability.ApiMethod =
      connection.type === "env" ? "env" : integration.methods.some((item) => item.type === "key") ? "key" : "oauth"
    return { integrationID: integration.id, method, connected: true, hosts }
  }
  if (product.envKeys.some((name) => present(env, name))) return { method: "env", connected: true, hosts }
  if (integration) {
    const method: Capability.ApiMethod = integration.methods.some((item) => item.type === "key")
      ? "key"
      : integration.methods.some((item) => item.type === "oauth")
        ? "oauth"
        : "env"
    return { integrationID: integration.id, method, connected: false, hosts }
  }
  return undefined
}

function cli(product: CapabilityCatalog.Product, binaries: DetectInput["binaries"]): Capability.CliChannel | undefined {
  if (product.binaries.length === 0) return undefined
  const found = product.binaries.find((binary) => binaries.get(binary) !== undefined)
  const binary = found ?? product.binaries[0]
  const path = binaries.get(binary)
  return path === undefined ? { binary, found: false } : { binary, path, found: true }
}

export function detect(input: DetectInput): Base[] {
  const matched = new Set<string>()
  const consumed = new Set<string>()
  const products: Base[] = []
  for (const product of CapabilityCatalog.products) {
    for (const name of product.envKeys) consumed.add(name)
    const mcp = input.servers
      .filter((server) => CapabilityCatalog.matchesMcp(product, candidates(server)))
      .map((server) => ({ server: server.name, status: server.status, tools: server.tools }))
    for (const channel of mcp) matched.add(channel.server)
    const apiChannel = api(product, input.integrations, input.env)
    const cliChannel = cli(product, input.binaries)
    if (mcp.length === 0 && apiChannel === undefined && !cliChannel?.found) continue
    products.push({
      id: product.id,
      name: product.name,
      channels: {
        ...(mcp.length ? { mcp } : {}),
        ...(apiChannel ? { api: apiChannel } : {}),
        ...(cliChannel ? { cli: cliChannel } : {}),
      },
    })
  }
  const servers = input.servers
    .filter((server) => !matched.has(server.name))
    .map(
      (server): Base => ({
        id: `mcp:${server.name}`,
        name: server.name,
        channels: { mcp: [{ server: server.name, status: server.status, tools: server.tools }] },
      }),
    )
  const env = new Map<string, Base>()
  for (const name of Object.keys(input.env).toSorted()) {
    if (consumed.has(name) || !ENV_KEY.test(name) || !present(input.env, name)) continue
    const prefix = name.replace(ENV_KEY, "").toLowerCase()
    const id = `env:${prefix}`
    if (env.has(id)) continue
    env.set(id, { id, name: prefix, channels: { api: { method: "env", connected: true, hosts: [] } } })
  }
  return [
    ...products.toSorted((a, b) => a.name.localeCompare(b.name)),
    ...servers.toSorted((a, b) => a.name.localeCompare(b.name)),
    ...env.values(),
  ]
}

type Mutable = {
  id: string
  name: string
  channels: { mcp?: Capability.McpChannel[]; api?: Capability.ApiChannel; cli?: Capability.CliChannel }
}

function allowed(channels: Capability.Channels, rules: Permission.Ruleset) {
  const ok = (action: string, resource: string) => Permission.evaluate(action, resource, rules).effect !== "deny"
  // Only usable channels count: a missing binary or an unconnected credential cannot grant access.
  const checks: boolean[] = []
  if (channels.mcp?.length) checks.push(channels.mcp.some((item) => ok(`${McpTool.namespace(item.server)}_*`, "*")))
  if (channels.api?.connected)
    checks.push(channels.api.hosts.length ? channels.api.hosts.some((h) => ok("webfetch", h)) : ok("webfetch", "*"))
  if (channels.cli?.found) checks.push(ok("shell", `${channels.cli.binary} *`))
  return checks.length === 0 || checks.some(Boolean)
}

export function resolve(base: readonly Base[], agent?: Agent.Info): Capability.Info[] {
  const items: Mutable[] = base.map((item) => {
    const channels: Mutable["channels"] = {}
    if (item.channels.mcp) channels.mcp = [...item.channels.mcp]
    if (item.channels.api) channels.api = item.channels.api
    if (item.channels.cli) channels.cli = item.channels.cli
    return { id: item.id, name: item.name, channels }
  })
  const pins = (agent?.capabilities ?? []).map(parsePin)
  const get = (id: string) => {
    const existing = items.find((item) => item.id === id)
    if (existing) return existing
    const created: Mutable = { id, name: CapabilityCatalog.byID.get(id)?.name ?? id, channels: {} }
    items.push(created)
    return created
  }
  for (const pin of pins) {
    const target = get(pin.id)
    if (pin.mcp === undefined) continue
    const source = items.find((item) => item !== target && item.channels.mcp?.some((c) => c.server === pin.mcp))
    if (!source) continue
    const channel = source.channels.mcp!.find((c) => c.server === pin.mcp)!
    source.channels.mcp = source.channels.mcp!.filter((c) => c.server !== pin.mcp)
    if (source.channels.mcp.length === 0) delete source.channels.mcp
    target.channels.mcp = [channel, ...(target.channels.mcp ?? [])]
  }
  const pinned = new Set(pins.map((pin) => pin.id))
  const rank = (item: Mutable) => {
    const index = pins.findIndex((pin) => pin.id === item.id)
    if (index !== -1) return index
    if (item.id.startsWith("mcp:")) return pins.length + 1
    if (item.id.startsWith("env:")) return pins.length + 2
    return pins.length
  }
  return items
    .filter((item) => Object.keys(item.channels).length > 0 || pinned.has(item.id))
    .toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((item) => ({
      id: item.id,
      name: item.name,
      channels: item.channels,
      pinned: pinned.has(item.id),
      allowed: agent ? allowed(item.channels, agent.permissions) : true,
    }))
}

export interface Interface {
  readonly list: (input?: { readonly agent?: string }) => Effect.Effect<Info[]>
  /** Drops every cache (including the `which` probe) and republishes `capability.updated`. */
  readonly refresh: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Capability") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const mcp = yield* Mcp.Service
    const integration = yield* Integration.Service
    const agents = yield* Agent.Service

    const probe = Effect.sync(
      () =>
        new Map(
          CapabilityCatalog.products
            .flatMap((product) => product.binaries)
            .map((binary) => [binary, which(binary) ?? undefined] as const),
        ),
    )
    const [binaries, invalidateBinaries] = yield* Effect.cachedInvalidateWithTTL(probe, Duration.minutes(5))

    const compute = Effect.gen(function* () {
      const servers = yield* mcp.servers()
      const entries = yield* Effect.forEach(
        servers,
        (server) =>
          Effect.gen(function* () {
            const config = yield* mcp.config(server.name)
            // A server still starting must not stall the list; `mcp.tools.changed` refreshes it later.
            const tools = yield* mcp.tools(server.name).pipe(
              Effect.timeout(Duration.seconds(2)),
              Effect.orElseSucceed((): Mcp.Tool[] => []),
            )
            return { name: server.name, status: server.status, config, tools: tools.length } satisfies ServerInput
          }),
        { concurrency: "unbounded" },
      )
      const integrations = yield* integration.list()
      return detect({ servers: entries, integrations, env: process.env, binaries: yield* binaries })
    }).pipe(Effect.withSpan("Capability.detect"))
    const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(compute, Duration.seconds(60))

    const refresh = Effect.gen(function* () {
      yield* invalidate
      yield* bus.publish(Event.Updated, {})
    })
    yield* bus
      .subscribe([McpEvent.StatusChanged, McpEvent.ToolsChanged, Credential.Event.Updated, Integration.Event.Updated])
      .pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach(() => refresh),
        Effect.forkScoped({ startImmediately: true }),
      )

    return Service.of({
      list: Effect.fn("Capability.list")(function* (input) {
        const base = yield* cached
        const agent = input?.agent ? yield* agents.get(Agent.ID.make(input.agent)) : undefined
        return resolve(base, agent)
      }),
      refresh: Effect.fn("Capability.refresh")(function* () {
        yield* invalidateBinaries
        yield* refresh
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Mcp.node, Integration.node, Agent.node],
})
