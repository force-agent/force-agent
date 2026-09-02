import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { Permission } from "@opencode-ai/core/permission"
import { RemotePlugin } from "@opencode-ai/core/plugin/remote"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/util/global"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "./host"

const testLocation = location({ directory: AbsolutePath.make("/project") })
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(testLocation))
const global = Global.make({ data: "/data", config: "/config", tmp: "/tmp/opencode" })
const globalLayer = Layer.succeed(Global.Service, Global.Service.of(global))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Location.node]), [
    [Global.node, globalLayer],
    [Location.node, locationLayer],
  ]) as unknown as Layer.Layer<unknown, never>,
)

const remote = Agent.ID.make("remote")

describe("RemotePlugin", () => {
  it.effect("registers a preset that reads freely, asks to act, and denies leaving the workspace", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* RemotePlugin.Plugin.effect(host({ agent: agentHost(agent) }))

      const info = yield* agent.get(remote)
      if (!info) throw new Error("expected the remote agent preset")
      expect(info.mode).toBe("primary")
      const rules = info.permissions

      for (const action of ["read", "grep", "glob"]) {
        expect(Permission.evaluate(action, "src/index.ts", rules).effect).toBe("allow")
      }
      expect(Permission.evaluate("read", ".env", rules).effect).toBe("ask")
      expect(Permission.evaluate("read", ".env.local", rules).effect).toBe("ask")
      expect(Permission.evaluate("read", ".env.example", rules).effect).toBe("allow")

      for (const action of ["shell", "edit", "webfetch"]) {
        expect(Permission.evaluate(action, "*", rules).effect).toBe("ask")
      }

      // The managed external directories the agent layer opens up for other
      // presets are closed again here, last rule wins.
      for (const resource of ["/elsewhere", path.join(global.tmp, "*"), path.join(global.data, "tool-output", "*")]) {
        expect(Permission.evaluate("external_directory", resource, rules).effect).toBe("deny")
      }

      // Nothing unlisted falls through to allow.
      expect(Permission.evaluate("patch", "*", rules).effect).toBe("ask")
      expect(Permission.evaluate("subagent", "*", rules).effect).toBe("ask")
    }),
  )
})
