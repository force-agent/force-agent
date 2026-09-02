import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Capability } from "@opencode-ai/core/capability"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { Mcp } from "@opencode-ai/core/mcp/index"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const connected = { status: "connected" } as const
const none = { integrations: [], env: {}, binaries: new Map() }

function agent(input: Partial<Agent.Info>): Agent.Info {
  return { ...Agent.Info.default(Agent.ID.make("build")), ...input }
}

describe("Capability.detect", () => {
  test("maps MCP server posthog-mcp to posthog and counts tools", () => {
    const base = Capability.detect({ ...none, servers: [{ name: "posthog-mcp", status: connected, tools: 3 }] })
    expect(base.map((item) => item.id)).toEqual(["posthog"])
    expect(base[0]?.channels.mcp).toEqual([{ server: "posthog-mcp", status: connected, tools: 3 }])
  })

  test("matches by local command token and by remote url host", () => {
    const base = Capability.detect({
      ...none,
      servers: [
        { name: "ph", status: connected, tools: 1, config: { type: "local", command: ["npx", "-y", "@posthog/mcp"] } },
        {
          name: "gh",
          status: connected,
          tools: 1,
          config: { type: "remote", url: "https://api.githubcopilot.com/mcp" },
        },
      ],
    })
    expect(base.map((item) => item.id)).toEqual(["github", "posthog"])
  })

  test("unmatched MCP server becomes mcp:<server>", () => {
    const base = Capability.detect({ ...none, servers: [{ name: "tamz-schema", status: connected, tools: 4 }] })
    expect(base).toEqual([
      {
        id: "mcp:tamz-schema",
        name: "tamz-schema",
        channels: { mcp: [{ server: "tamz-schema", status: connected, tools: 4 }] },
      },
    ])
  })

  test("catalog env key becomes api channel; unknown *_API_KEY|*_TOKEN becomes env:<prefix>", () => {
    const base = Capability.detect({
      ...none,
      servers: [],
      env: { POSTHOG_API_KEY: "phx", TAMZ_SCHEMA_TOKEN: "t", META_ACCESS_TOKEN: "m", CRW_MCP_TOKEN: "", NOT_A_SECRET: "x" },
    })
    expect(base.map((item) => item.id)).toEqual(["posthog", "env:meta", "env:tamz_schema"])
    expect(base[0]?.channels.api).toMatchObject({ method: "env", connected: true })
    expect(base[0]?.channels.api?.hosts).toContain("posthog.com")
    expect(base[1]?.channels).toEqual({ api: { method: "env", connected: true, hosts: [] } })
  })

  test("catalog binary found becomes cli channel; binaries alone never create mcp/api", () => {
    const base = Capability.detect({ ...none, servers: [], binaries: new Map([["gh", "/usr/bin/gh"]]) })
    expect(base).toEqual([
      { id: "github", name: "GitHub", channels: { cli: { binary: "gh", path: "/usr/bin/gh", found: true } } },
    ])
  })

  test("product with only a missing binary is omitted, but missing binary is reported alongside other channels", () => {
    const base = Capability.detect({
      ...none,
      servers: [{ name: "posthog-mcp", status: connected, tools: 0 }],
      binaries: new Map([["posthog", undefined]]),
    })
    expect(base.map((item) => item.id)).toEqual(["posthog"])
    expect(base[0]?.channels.cli).toEqual({ binary: "posthog", found: false })
  })

  test("stored integration credential becomes a connected api channel", () => {
    const base = Capability.detect({
      ...none,
      servers: [],
      integrations: [
        {
          id: Integration.ID.make("openai"),
          name: "OpenAI",
          methods: [{ type: "key" }],
          connections: [{ type: "credential", id: "cred_1" as never, label: "OpenAI" }],
        },
      ],
    })
    expect(base[0]?.channels.api).toMatchObject({ integrationID: "openai", method: "key", connected: true })
  })
})

describe("Capability.resolve", () => {
  const base = Capability.detect({
    ...none,
    servers: [
      { name: "posthog-mcp", status: connected, tools: 3 },
      { name: "my-ph", status: connected, tools: 2 },
    ],
    binaries: new Map([["gh", "/usr/bin/gh"]]),
  })

  test("without an agent everything is allowed and nothing is pinned", () => {
    const list = Capability.resolve(base)
    expect(list.map((item) => [item.id, item.allowed, item.pinned])).toEqual([
      ["github", true, false],
      ["posthog", true, false],
      ["mcp:my-ph", true, false],
    ])
  })

  test("allowed is false when the ruleset denies posthog_*", () => {
    const list = Capability.resolve(
      base,
      agent({ permissions: [{ action: "posthog-mcp_*", resource: "*", effect: "deny" }] }),
    )
    expect(list.find((item) => item.id === "posthog")?.allowed).toBe(false)
    expect(list.find((item) => item.id === "github")?.allowed).toBe(true)
  })

  test("cli is evaluated as shell and api as webfetch", () => {
    const list = Capability.resolve(
      base,
      agent({
        capabilities: ["openai"],
        permissions: [
          { action: "shell", resource: "gh *", effect: "deny" },
          { action: "webfetch", resource: "*", effect: "deny" },
        ],
      }),
    )
    expect(list.find((item) => item.id === "github")?.allowed).toBe(false)
    expect(list.find((item) => item.id === "openai")).toMatchObject({ pinned: true, channels: {}, allowed: true })
  })

  test("pinned via capabilities comes first", () => {
    const list = Capability.resolve(base, agent({ capabilities: ["posthog"] }))
    expect(list.map((item) => [item.id, item.pinned])).toEqual([
      ["posthog", true],
      ["github", false],
      ["mcp:my-ph", false],
    ])
  })

  test("posthog=mcp:my-ph moves that server into posthog", () => {
    const list = Capability.resolve(base, agent({ capabilities: ["posthog=mcp:my-ph"] }))
    expect(list.map((item) => item.id)).toEqual(["posthog", "github"])
    expect(list[0]?.channels.mcp?.map((item) => item.server)).toEqual(["my-ph", "posthog-mcp"])
  })

  test("parsePin", () => {
    expect(Capability.parsePin("posthog")).toEqual({ id: "posthog" })
    expect(Capability.parsePin("posthog=mcp:my-ph")).toEqual({ id: "posthog", mcp: "my-ph" })
    expect(Capability.parsePin(" github = mcp:gh ")).toEqual({ id: "github", mcp: "gh" })
    expect(Capability.parsePin("github=other")).toEqual({ id: "github" })
  })
})

const testLocation = location({ directory: AbsolutePath.make("/project") })
const global = Global.make({ data: "/data", config: "/config", tmp: "/tmp/opencode" })
const mcpLayer = Layer.succeed(
  Mcp.Service,
  Mcp.Service.of({
    transform: () => Effect.die("unused"),
    reload: () => Effect.die("unused"),
    servers: () =>
      Effect.succeed([new Mcp.ServerInfo({ name: Mcp.ServerName.make("posthog-mcp"), status: connected })]),
    add: () => Effect.die("unused"),
    connect: () => Effect.die("unused"),
    disconnect: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    tools: () =>
      Effect.succeed([
        new Mcp.Tool({ server: Mcp.ServerName.make("posthog-mcp"), name: "query" }),
        new Mcp.Tool({ server: Mcp.ServerName.make("posthog-mcp"), name: "flags" }),
      ]),
    config: () => Effect.undefined,
    callTool: () => Effect.die("unused"),
    instructions: () => Effect.succeed([]),
    prompts: () => Effect.succeed([]),
    prompt: () => Effect.undefined,
    resourceCatalog: () => Effect.succeed(Mcp.ResourceCatalog.make({ resources: [], templates: [] })),
    readResource: () => Effect.undefined,
  }),
)
const integrationLayer = Layer.succeed(
  Integration.Service,
  Integration.Service.of({ list: () => Effect.succeed([]) } as unknown as Integration.Interface),
)
// Deny every channel: the host machine may also expose posthog through env keys or a binary.
const build = agent({
  capabilities: ["posthog"],
  permissions: [
    { action: "posthog-mcp_*", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
  ],
})
const agentLayer = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: (id: Agent.ID) => Effect.succeed(id === build.id ? build : undefined),
  } as unknown as Agent.Interface),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Capability.node, Bus.node, Location.node]), [
    [Global.node, Layer.succeed(Global.Service, Global.Service.of(global))],
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(testLocation))],
    [Mcp.node, mcpLayer],
    [Integration.node, integrationLayer],
    [Agent.node, agentLayer],
  ]) as unknown as Layer.Layer<unknown, never>,
)

describe("Capability.Service", () => {
  it.live("lists posthog with tool count, pinned and denied for the agent", () =>
    Effect.gen(function* () {
      const service = yield* Capability.Service
      const all = yield* service.list()
      const posthog = all.find((item) => item.id === "posthog")
      expect(posthog).toMatchObject({ pinned: false, allowed: true })
      expect(posthog?.channels.mcp).toEqual([{ server: "posthog-mcp", status: connected, tools: 2 }])

      const scoped = yield* service.list({ agent: "build" })
      expect(scoped[0]).toMatchObject({ id: "posthog", pinned: true, allowed: false })
    }),
  )

  it.live("publishes capability.updated when mcp tools change", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const updated = yield* bus
        .subscribe(Capability.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* bus.publish(McpEvent.ToolsChanged, { server: "posthog-mcp" })
      const events = yield* Fiber.join(updated).pipe(Effect.timeout("5 seconds"))
      expect(events.length).toBe(1)
    }),
  )
})
