#!/usr/bin/env node
// force-agent overlay: the npm `bin` target for the `force-agent` distribution package.
// The command is `force`; the package that carries it is `force-agent`.
//
// Why a Node shim instead of pointing `bin` straight at the executable:
//
//   1. npm generates the Windows `.cmd`/`.ps1` wrappers from the shebang of the
//      bin target at LINK time, which happens BEFORE `postinstall` runs. Upstream
//      ships a placeholder shell script at `bin/<name>.exe` and has postinstall
//      overwrite it with the real binary; the wrappers npm already wrote are then
//      wrong-ish by luck rather than by design, and `npm install --ignore-scripts`
//      leaves the placeholder in place, so the command prints an error forever.
//   2. This file has a real `#!/usr/bin/env node` shebang, so the wrappers npm
//      writes are correct on every platform and never need rewriting.
//   3. Resolution happens at RUNTIME, from the optional dependency that npm
//      already installed. `--ignore-scripts` changes nothing.
//
// `postinstall.mjs` is a pure optimization (it hardlinks the platform binary next
// to this file so the resolve walk is skipped). It must never be a requirement.

"use strict"

const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const command = "force"
const scope = "@force-agent"
// Every platform package this distribution publishes. Keep in sync with the
// `allTargets` list in packages/cli/script/build.ts.
const published = ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"]

const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[os.platform()] || os.platform()
const arch = { x64: "x64", arm64: "arm64", arm: "arm" }[os.arch()] || os.arch()
const executable = platform === "windows" ? command + ".exe" : command
const scriptDir = (() => {
  try {
    return path.dirname(fs.realpathSync(__filename))
  } catch {
    return __dirname
  }
})()

function isMusl() {
  if (platform !== "linux") return false
  try {
    if (fs.existsSync("/etc/alpine-release")) return true
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return ((result.stdout || "") + (result.stderr || "")).toLowerCase().includes("musl")
  } catch {
    return false
  }
}

// Candidate order: the exact host slug first, then any slug whose binaries this
// host can still execute. Slugs that are not published are dropped, so adding a
// target to `published` is all a new variant needs.
function candidates() {
  const musl = isMusl()
  const order = [
    musl ? platform + "-" + arch + "-musl" : undefined,
    platform + "-" + arch,
    // Node reports x64 when it is itself running under Rosetta on Apple silicon;
    // the arm64 build is the native one and spawns fine from a translated parent.
    platform === "darwin" && arch === "x64" ? "darwin-arm64" : undefined,
    // Windows on ARM executes x64 images through its built-in emulation layer.
    platform === "windows" && arch === "arm64" ? "windows-x64" : undefined,
  ]
  return order
    .filter((slug, index) => slug !== undefined && published.includes(slug) && order.indexOf(slug) === index)
    .map((slug) => scope + "/cli-" + slug)
}

// Resolution 1: the package as Node itself resolves it. Handles hoisting,
// nesting, pnpm's symlinked store and a global install root in one call.
function resolveByRequire(name) {
  try {
    const manifest = require.resolve(name + "/package.json", { paths: [scriptDir, process.cwd()] })
    return path.join(path.dirname(manifest), "bin", executable)
  } catch {
    return undefined
  }
}

// Resolution 2: walk node_modules upward. Covers layouts where the platform
// package is present on disk but unreachable from this file's resolution paths
// (a package published without the dependency edge, a manual drop-in).
function resolveByWalk(names, startDir) {
  let current = startDir
  for (;;) {
    for (const name of names) {
      const candidate = path.join(current, "node_modules", ...name.split("/"), "bin", executable)
      if (fs.existsSync(candidate)) return candidate
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

// The branded override, most specific first: the current FORCE_AGENT_ brand, then each
// earlier one — LABHARNESS_, LABFY_, POWER_ — then upstream's OPENCODE_. Dropping
// any fallback would silently ignore an override an existing install relies on.
const binPathKeys = [
  "FORCE_AGENT_BIN_PATH",
  "LABHARNESS_BIN_PATH",
  "LABFY_BIN_PATH",
  "POWER_BIN_PATH",
  "OPENCODE_BIN_PATH",
]

function binPathOverride() {
  for (const key of binPathKeys) {
    const value = process.env[key]
    if (value) return { key: key, value: value }
  }
  return undefined
}

function resolve(names) {
  const override = binPathOverride()
  if (override) {
    if (!fs.existsSync(override.value)) fail(override.key + " points at a missing file: " + override.value)
    return override.value
  }
  // Written by the optional postinstall hardlink. Never required.
  const cached = path.join(scriptDir, "." + command + (platform === "windows" ? ".exe" : ""))
  if (fs.existsSync(cached)) return cached
  for (const name of names) {
    const resolved = resolveByRequire(name)
    if (resolved && fs.existsSync(resolved)) return resolved
  }
  return resolveByWalk(names, scriptDir) || resolveByWalk(names, process.cwd())
}

function fail(message) {
  process.stderr.write(message + "\n")
  process.exit(1)
}

const forwarded = platform === "windows" ? ["SIGINT", "SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR1"]

// Self-update restart: the server installs the new version, then exits with
// this code and the shim re-resolves the binary (the package on disk is the new
// one by now) and runs it again with the same argv. Bounded so a build that
// keeps asking to restart cannot loop forever: at most `restartLimit` restarts,
// and a restarted process that asks again within `restartMinUptimeMs` is a
// crash loop, not an update.
const restartCode = 75
const restartLimit = 3
const restartMinUptimeMs = 5000
let restarts = 0

function run(target) {
  const started = Date.now()
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" })
  child.on("error", (error) => {
    // npm can land the tarball without the executable bit on some filesystems;
    // the upstream distribution relied on postinstall to chmod, and this one
    // does not run postinstall at all when scripts are disabled.
    if (error && error.code === "EACCES") {
      try {
        fs.chmodSync(target, 0o755)
        return run(target)
      } catch {}
    }
    fail(error && error.message ? error.message : String(error))
  })
  const handlers = {}
  for (const signal of forwarded) {
    handlers[signal] = () => {
      try {
        child.kill(signal)
      } catch {}
    }
    process.on(signal, handlers[signal])
  }
  child.on("exit", (code, signal) => {
    for (const name of forwarded) process.removeListener(name, handlers[name])
    if (signal) return process.kill(process.pid, signal)
    if (code === restartCode) {
      const uptime = Date.now() - started
      if (restarts > 0 && uptime < restartMinUptimeMs)
        fail(
          "force asked to restart again " +
            uptime +
            " ms after it was restarted; not restarting (crash loop). Start it again by hand.",
        )
      if (restarts >= restartLimit)
        fail(
          "force asked to restart " + (restarts + 1) + " times in a row; not restarting. Start it again by hand.",
        )
      restarts += 1
      const next = resolve(names)
      if (!next)
        fail("force could not find its platform binary after the update. Reinstall it with `npm i -g force-agent`.")
      return run(next)
    }
    process.exit(typeof code === "number" ? code : 0)
  })
}

const names = candidates()
if (names.length === 0)
  fail(
    "force-agent does not publish a build for " +
      platform +
      "-" +
      arch +
      (isMusl() ? " (musl libc)" : "") +
      ". Published targets: " +
      published.join(", ") +
      ".",
  )

const resolved = resolve(names)
if (!resolved)
  fail(
    "force could not find its platform binary. Install " +
      names.map((name) => JSON.stringify(name)).join(" or ") +
      ", or point FORCE_AGENT_BIN_PATH at the executable." +
      (isMusl()
        ? "\nThis host uses musl libc (Alpine). force-agent publishes glibc builds only; run it on a glibc image or install gcompat."
        : ""),
  )

run(resolved)
