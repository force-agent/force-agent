import path from "path"
import fs from "fs"
import os from "os"
import { Context, Effect, Layer } from "effect"
// XDG on runtimes with a home directory; one tmp-rooted directory on workerd.
// The variants resolve through the `workerd` bundle condition, like the
// native-module stubs, so no runtime sniffing happens here.
import { roots } from "#global-roots"
import { env } from "./env.js"
import { Flock } from "./flock.js"
import { makeGlobalNode } from "./effect/app-node.js"

const app = "force-agent"
const { data, cache, config, state, tmp } = roots(app)

/**
 * Adopt the previous brand's directories.
 *
 * `data`, `config` and `state` hold real user data — the SQLite database with
 * every session, the stored credentials, the flock — so renaming the app
 * without moving them would look exactly like a factory reset to anyone who
 * updates. `cache` and `tmp` are excluded: both are disposable, and moving them
 * only risks a stale lock.
 *
 * Each root moves once and only into a name that does not exist yet, so a
 * second run is a no-op and an install that already has new-brand data is never
 * overwritten. Failure is deliberately silent: a read-only home or a
 * cross-device rename is not a reason to refuse to boot, and the cost of losing
 * this race is the old directory staying where it is.
 */
{
  const previous = roots("labharness")
  for (const key of ["data", "config", "state"] as const) {
    const from = previous[key]
    const to = { data, config, state }[key]
    if (from === to) continue
    try {
      if (fs.existsSync(to) || !fs.existsSync(from)) continue
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(from, to)
    } catch {}
  }
}

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  // The acquired service canonicalizes default tmp; use it instead of Path.tmp for path comparisons.
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Path.config,
    state: Path.state,
    tmp: input.tmp ?? Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const acquire = (input: Partial<Interface>) =>
  Effect.gen(function* () {
    const service = Service.of(make(input))
    yield* Effect.promise(() =>
      Promise.all(
        [service.data, service.config, service.state, service.log, service.bin, service.repos, service.tmp].map(
          (directory) => fs.promises.mkdir(directory, { recursive: true }),
        ),
      ),
    )
    const canonicalTmp = yield* Effect.promise(() => fs.promises.realpath(service.tmp))
    return Service.of({ ...service, tmp: input.tmp ?? canonicalTmp })
  })

const layer = Layer.effect(
  Service,
  Effect.suspend(() => acquire({ config: env("CONFIG_DIR") ?? Path.config })),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, acquire(input))

export * as Global from "./global.js"
