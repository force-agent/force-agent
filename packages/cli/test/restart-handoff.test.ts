import { Global } from "@opencode-ai/util/global"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { RestartHandoff } from "../src/services/restart-handoff"
import { tmpdir } from "./fixture/tmpdir"

const record = {
  password: "s3cret",
  hostname: "127.0.0.1",
  port: 4096,
  expectedVersion: "9.9.9",
}

const run = <A>(effect: Effect.Effect<A, unknown, Global.Service>, state: string) =>
  Effect.runPromise(effect.pipe(Effect.provide(Global.layerWith({ state }))))

describe("web restart handoff", () => {
  test("writes 0600 into the state directory and consume() reads it once", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    expect(await run(RestartHandoff.write({ ...record, configured: false }), state)).toBe(true)
    const file = path.join(state, RestartHandoff.filename)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    // No leftover temp file from the tmp+rename dance.
    expect(fs.readdirSync(state).filter((name) => name.includes("web-restart"))).toEqual([RestartHandoff.filename])

    const consumed = await run(RestartHandoff.consume(), state)
    expect(consumed).toMatchObject({ ...record, ppid: process.ppid })
    // Consumed once: the file is gone and a second read finds nothing.
    expect(fs.existsSync(file)).toBe(false)
    expect(await run(RestartHandoff.consume(), state)).toBeUndefined()
  })

  test("never writes when the password came from the environment", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    expect(await run(RestartHandoff.write({ ...record, configured: true }), state)).toBe(false)
    expect(fs.existsSync(path.join(state, RestartHandoff.filename))).toBe(false)
  })

  test("rejects an expired handoff and still deletes the file", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    fs.mkdirSync(state, { recursive: true })
    const file = path.join(state, RestartHandoff.filename)
    fs.writeFileSync(
      file,
      JSON.stringify({ v: 1, ...record, createdAt: Date.now() - RestartHandoff.maxAgeMs - 1, ppid: process.ppid }),
    )
    expect(await run(RestartHandoff.consume(), state)).toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)
  })

  test("rejects a handoff written under another parent process", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    fs.mkdirSync(state, { recursive: true })
    const file = path.join(state, RestartHandoff.filename)
    fs.writeFileSync(file, JSON.stringify({ v: 1, ...record, createdAt: Date.now(), ppid: process.ppid + 1 }))
    expect(await run(RestartHandoff.consume(), state)).toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)
  })

  test("rejects a malformed file and deletes it", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    fs.mkdirSync(state, { recursive: true })
    const file = path.join(state, RestartHandoff.filename)
    fs.writeFileSync(file, "{not json")
    expect(await run(RestartHandoff.consume(), state)).toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)
  })
})
