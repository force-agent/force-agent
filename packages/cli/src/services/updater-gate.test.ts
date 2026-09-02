import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/util/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { Effect, Layer, Logger } from "effect"
import { Updater } from "./updater"

// force-agent overlay guard: self-update must stay off unless explicitly
// enabled. The gate has to sit ahead of every other branch in check(), so the
// updater never reads config, never resolves a package manager and never
// reaches update.opencode.ai on a deployed server.

afterEach(() => {
  delete process.env.LABHARNESS_ENABLE_AUTOUPDATE
  delete process.env.LABFY_ENABLE_AUTOUPDATE
  delete process.env.OPENCODE_ENABLE_AUTOUPDATE
})

async function reasons() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "force-updater-"))
  const messages: Array<string> = []
  const capture = Logger.make<unknown, void>(({ message }) => {
    messages.push(JSON.stringify(message))
  })
  const directories = {
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    log: path.join(root, "log"),
    bin: path.join(root, "bin"),
    repos: path.join(root, "repos"),
    tmp: path.join(root, "tmp"),
  }
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const updater = yield* Updater.Service
        yield* updater.check()
      }).pipe(
        Effect.provide(Updater.layer),
        Effect.provide(Global.layerWith(directories)),
        Effect.provide(LayerNode.compile(AppProcess.node, [])),
        Effect.provide(LayerNode.compile(CrossSpawnSpawner.node, [])),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(Logger.layer([capture])),
        Effect.scoped,
      ) as Effect.Effect<void>,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return messages.join(" | ")
}

test("auto-update is off by default", async () => {
  expect(await reasons()).toContain("autoupdate-disabled-by-default")
})

test("the opt-in re-enables the upstream code path", async () => {
  process.env.LABHARNESS_ENABLE_AUTOUPDATE = "1"
  expect(await reasons()).not.toContain("autoupdate-disabled-by-default")
})

test("the legacy opt-in spelling is honored too", async () => {
  process.env.OPENCODE_ENABLE_AUTOUPDATE = "true"
  expect(await reasons()).not.toContain("autoupdate-disabled-by-default")
})
