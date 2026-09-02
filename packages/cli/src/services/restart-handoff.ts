export * as RestartHandoff from "./restart-handoff"

import { Global } from "@opencode-ai/util/global"
import { Effect, Option, Schema } from "effect"
import fs from "node:fs"
import path from "node:path"

/**
 * force-agent overlay: how `web` keeps its password across a self-update restart.
 *
 * The shim (`bin/force.cjs`) re-executes the binary when it exits with code 75. The
 * new process cannot inherit anything from the old one through the environment — the shim
 * is the parent and its env is fixed — so the credential travels through a file in the
 * state directory: written `tmp+rename` with mode 0600, consumed exactly once (deleted
 * before it is validated), valid for a minute and only for a process spawned by the same
 * shim (`ppid`). It is never written when the operator pinned the password through the
 * environment: the child inherits that on its own. The contents are never logged.
 */
export const Record = Schema.Struct({
  v: Schema.Literal(1),
  password: Schema.String,
  hostname: Schema.String,
  port: Schema.Number,
  expectedVersion: Schema.String,
  createdAt: Schema.Number,
  ppid: Schema.Number,
}).annotate({ identifier: "RestartHandoff.Record" })
export interface Record extends Schema.Schema.Type<typeof Record> {}

export const filename = "web-restart.json"
export const maxAgeMs = 60_000

export interface Input {
  readonly password: string
  readonly hostname: string
  readonly port: number
  readonly expectedVersion: string
  /** True when the password came from the environment; nothing is written then. */
  readonly configured: boolean
}

const file = Effect.map(Global.Service, (global) => path.join(global.state, filename))

/** Returns false when nothing was written (password configured through the environment). */
export const write = Effect.fnUntraced(function* (input: Input) {
  if (input.configured) return false
  const target = yield* file
  const record: Record = {
    v: 1,
    password: input.password,
    hostname: input.hostname,
    port: input.port,
    expectedVersion: input.expectedVersion,
    createdAt: Date.now(),
    ppid: process.ppid,
  }
  yield* Effect.sync(() => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
    // `mode` above is subject to the umask; the file must be 0600 regardless of it.
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, target)
  })
  return true
})

/** Reads and deletes the handoff. Undefined when absent, malformed, older than a minute or from another parent. */
export const consume = Effect.fnUntraced(function* () {
  const target = yield* file
  const text = yield* Effect.sync(() => {
    let content: string | undefined
    try {
      content = fs.readFileSync(target, "utf8")
    } catch {
      return undefined
    }
    // Deleted before validation: a rejected file must not survive to be tried again.
    try {
      fs.unlinkSync(target)
    } catch {}
    return content
  })
  if (text === undefined) return undefined
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Record))(text).pipe(Effect.option)
  if (Option.isNone(decoded)) return undefined
  const record = decoded.value
  if (Date.now() - record.createdAt > maxAgeMs) return undefined
  if (record.ppid !== process.ppid) return undefined
  return record
})
