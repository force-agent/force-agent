#!/usr/bin/env node
// force-agent overlay: OPTIONAL install-time optimization for the `force-agent`
// distribution package.
//
// It hardlinks (or copies) the platform binary next to the shim as
// `bin/.force[.exe]` so `bin/force.cjs` can skip the resolve walk.
// Everything here is best effort: `bin/force.cjs` resolves the binary at
// runtime on its own, so this script must NEVER fail an install. It always
// exits 0, and it never touches the `bin` target npm has already linked.

import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

try {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
  const command = Object.keys(manifest.bin ?? {})[0]
  const dependencies = manifest.optionalDependencies ?? {}
  if (command) {
    const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[os.platform()] ?? os.platform()
    const arch = { x64: "x64", arm64: "arm64", arm: "arm" }[os.arch()] ?? os.arch()
    const executable = platform === "windows" ? `${command}.exe` : command
    const target = path.join(directory, "bin", `.${executable}`)
    const names = Object.keys(dependencies).filter((name) => name.endsWith(`-${platform}-${arch}`))
    for (const name of names) {
      try {
        const source = path.join(path.dirname(require.resolve(`${name}/package.json`)), "bin", executable)
        if (!fs.existsSync(source)) continue
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (fs.existsSync(target)) fs.rmSync(target, { force: true })
        try {
          fs.linkSync(source, target)
        } catch {
          fs.copyFileSync(source, target)
        }
        fs.chmodSync(target, 0o755)
        const check = childProcess.spawnSync(target, ["--version"], { stdio: "ignore", windowsHide: true })
        if (check.status === 0) break
        fs.rmSync(target, { force: true })
      } catch {
        continue
      }
    }
  }
} catch {
  // Deliberately silent: the runtime shim is the contract, this is the shortcut.
}
