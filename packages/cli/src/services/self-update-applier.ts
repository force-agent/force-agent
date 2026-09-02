export * as SelfUpdateApplier from "./self-update-applier"

import type { SelfUpdateApplier as Contract } from "@opencode-ai/server/self-update"
import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { Deferred, type Duration, Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { OPENCODE_LOCAL } from "../version"
import { RestartHandoff } from "./restart-handoff"

/**
 * force-agent overlay: how `force web` replaces itself when the UI clicks Update.
 *
 * `detect` says whether this install can be replaced from the UI and by which package
 * manager; `install` runs that manager (the binary already loaded stays in memory, so the
 * package on disk can be swapped underneath it on Linux/macOS); `restart` hands the
 * credential to the next process (see RestartHandoff), sets the exit code the shim
 * (`bin/force.cjs`) treats as "run me again" and opens the server's shutdown latch.
 */
export const packageName = "force-agent"
export const restartExitCode = 75
/** The manual command shown whenever the UI cannot do it. */
export const manualCommand = `npm install -g ${packageName}@latest`

type Manager = "npm" | "pnpm" | "bun" | "yarn"

export interface Listening {
  readonly port: number
  readonly shutdown: Effect.Effect<void>
}

export interface Input {
  readonly password: string
  readonly hostname: string
  /** True when the password came from the environment: the child inherits it, no handoff is written. */
  readonly configured: boolean
  /** Completed by the server's `onListen` with the bound port and the shutdown effect. */
  readonly listening: Deferred.Deferred<Listening>
}

export const make = Effect.fnUntraced(function* (input: Input) {
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service

  const run = Effect.fnUntraced(function* (command: string[], timeout: Duration.Input) {
    return yield* appProcess
      .run(ChildProcess.make(command[0], command.slice(1)), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
        Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
      )
  })

  const detect: Contract.Applier["detect"] = Effect.fnUntraced(function* () {
    if (OPENCODE_LOCAL) return { manager: "unknown", canApply: false, reason: "local" } satisfies Contract.Detection
    // The running .exe is locked by the OS: a global reinstall fails while the server is up.
    if (process.platform === "win32")
      return {
        manager: "unknown",
        canApply: false,
        reason: "unsupported-platform",
        command: manualCommand,
      } satisfies Contract.Detection
    const checks: ReadonlyArray<{ manager: Manager; command: string[] }> = [
      { manager: "npm", command: ["npm", "list", "-g", "--depth=0", packageName] },
      { manager: "pnpm", command: ["pnpm", "list", "-g", "--depth=0", packageName] },
      { manager: "bun", command: ["bun", "pm", "ls", "-g"] },
      { manager: "yarn", command: ["yarn", "global", "list"] },
    ]
    const results = yield* Effect.forEach(
      checks,
      (check) => run(check.command, "10 seconds").pipe(Effect.map((result) => ({ check, result }))),
      { concurrency: "unbounded" },
    )
    const found = results.find((entry) => entry.result.stdout.includes(packageName))?.check.manager
    // npx/bunx runs without a global install to replace.
    if (found === undefined)
      return {
        manager: "unknown",
        canApply: false,
        reason: "no-manager",
        command: manualCommand,
      } satisfies Contract.Detection
    return { manager: found, canApply: true } satisfies Contract.Detection
  })

  const install: Contract.Applier["install"] = Effect.fnUntraced(function* (version: string) {
    const detection = yield* detect()
    if (!detection.canApply || detection.manager === "unknown")
      return yield* Effect.fail(new Error("This installation cannot update itself."))
    const target = `${packageName}@${version}`
    const commands: Record<Manager, string[]> = {
      npm: ["npm", "install", "--global", target],
      pnpm: ["pnpm", "add", "--global", `--allow-build=${packageName}`, target],
      bun: ["bun", "install", "--global", "--trust", target],
      yarn: ["yarn", "global", "add", target],
    }
    const result = yield* run(commands[detection.manager], "5 minutes")
    if (result.code === 0) return
    const message = result.stderr.trim() || `Failed to install ${target} with ${detection.manager}`
    const error = new Error(message)
    if (/EACCES|EPERM|permission denied/i.test(message))
      Object.assign(error, { hint: `sudo ${commands[detection.manager].join(" ")}` })
    return yield* Effect.fail(error)
  })

  const restart: Contract.Applier["restart"] = Effect.fnUntraced(function* (version: string) {
    // Let the `restarting` event drain to SSE subscribers before the listener closes.
    yield* Effect.sleep("300 millis")
    const listening = yield* Deferred.await(input.listening)
    yield* RestartHandoff.write({
      password: input.password,
      hostname: input.hostname,
      port: listening.port,
      expectedVersion: version,
      configured: input.configured,
    }).pipe(Effect.provideService(Global.Service, global))
    process.exitCode = restartExitCode
    yield* listening.shutdown
  })

  return { detect, install, restart } satisfies Contract.Applier
})
