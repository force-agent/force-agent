#!/usr/bin/env bun
// force-agent overlay: assembles the root `force-agent` npm package from the
// platform builds already sitting in dist/.
//
// Upstream's script/publish.ts builds and publishes its distribution in one
// step, with a placeholder binary that postinstall must overwrite. This one only
// ASSEMBLES, and the package it assembles works without postinstall ever running:
// `bin` points at a Node shim that resolves the platform binary at runtime.
// Publishing is the CI workflow's job, so the artifact can be inspected -- and
// verified by verify-rebrand.ts -- before anything reaches the registry.
//
//   bun run script/build.ts                 # produces dist/cli-<os>-<arch>/ (all four targets)
//   bun run script/build.ts --single        # CI uses --single por default: builds only the host platform (fast feedback)
//   bun run script/dist-package.ts          # release usa all: requires all four platform builds, fails if any is missing
//   bun run script/dist-package.ts --allow-partial  # dev/CI only: allowed for preview builds (0.0.0-*); stable releases must not use it — 0.4.0 publicado só com linux-x64 quebrou darwin-arm64

import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

const dir = path.resolve(import.meta.dirname, "..")
const dist = path.resolve(dir, process.argv.find((arg) => arg.startsWith("--dist="))?.slice("--dist=".length) ?? "dist")
// Every target the distribution promises. `bin/force.cjs` lists the same
// four slugs; a partial dist would publish a root package whose optional
// dependencies cannot resolve on a platform it claims to support.
const expected = ["cli-linux-x64", "cli-linux-arm64", "cli-darwin-arm64", "cli-windows-x64"]
const allowPartial = process.argv.includes("--allow-partial")

const platforms = (await readdir(dist, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("cli-"))
  .map((entry) => entry.name)
  .sort()
if (platforms.length === 0) throw new Error(`No platform builds in ${dist}; run script/build.ts first`)

const missing = expected.filter((name) => !platforms.includes(name))
if (missing.length > 0 && !allowPartial)
  throw new Error(`Missing platform builds: ${missing.join(", ")} (pass --allow-partial to package anyway)`)

const optionalDependencies: Record<string, string> = {}
for (const platform of platforms) {
  const pkg = await Bun.file(path.join(dist, platform, "package.json")).json()
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@force-agent/"))
    throw new Error(`${platform} is not a @force-agent platform package (found ${pkg.name})`)
  optionalDependencies[pkg.name] = pkg.version
}

const versions = new Set(Object.values(optionalDependencies))
if (versions.size !== 1) throw new Error(`Platform packages disagree on version: ${[...versions].join(", ")}`)
const version = [...versions][0]!

// --allow-partial is for preview/dev builds only (0.0.0-*). Stable releases
// must ship all four targets: 0.4.0 publicado só com linux-x64 quebrou
// darwin-arm64 — the root package's optionalDependencies promised darwin-arm64
// before it was resolvable, leaving installs on that platform with no binary.
// CI uses --single por default (one platform, fast feedback); release usa all
// (omit --single and --allow-partial, build the full matrix).
if (missing.length > 0 && allowPartial && !isPreviewVersion(version)) {
  throw new Error(
    `Refusing to package ${version} with --allow-partial: missing ${missing.join(", ")} — 0.4.0 publicado só com linux-x64 quebrou darwin-arm64. ` +
      `Stable releases must include all four targets (${expected.join(", ")}); rebuild without --single. ` +
      `CI uses --single por default, release usa all. Use --allow-partial only for preview builds (0.0.0-*).`,
  )
}
if (missing.length > 0) console.warn(`packaging without ${missing.join(", ")}`)

const target = path.join(dist, "force-agent")
await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "bin"), { recursive: true })
await Bun.write(path.join(target, "bin", "force.cjs"), Bun.file(path.join(dir, "bin", "force.cjs")))
await Bun.write(path.join(target, "postinstall.mjs"), Bun.file(path.join(dir, "script", "dist-postinstall.mjs")))
await Bun.write(path.join(target, "README.md"), readme(version))
await Bun.write(
  path.join(target, "package.json"),
  JSON.stringify(
    {
      name: "force-agent",
      version,
      description: "Force Agent CLI: a coding agent that runs as a background service with a web UI.",
      license: "MIT",
      homepage: "https://labfy.dev",
      repository: { type: "git", url: "git+https://github.com/force-agent/force-agent.git" },
      bugs: { url: "https://github.com/force-agent/force-agent/issues" },
      // The shim, not a binary. npm writes the Windows .cmd/.ps1 wrappers from
      // this file's shebang while linking, which is BEFORE any postinstall could
      // change what the target is - so the target has to be its final self here.
      bin: { force: "./bin/force.cjs" },
      // Pure optimization: it hardlinks the platform binary next to the shim.
      // It exits 0 no matter what, and `--ignore-scripts` installs work anyway.
      scripts: { postinstall: "node ./postinstall.mjs" },
      files: ["bin", "postinstall.mjs", "README.md"],
      engines: { node: ">=18" },
      // npm can only express the union; the per-combination truth is the
      // optionalDependencies below, each pinned to one os and one cpu.
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      keywords: ["ai", "agent", "cli", "coding-agent", "force-agent"],
      optionalDependencies,
    },
    null,
    2,
  ) + "\n",
)

console.log(`packaged force-agent@${version}`)
for (const [name, value] of Object.entries(optionalDependencies)) console.log(`  ${name}@${value}`)

function isPreviewVersion(version: string) {
  // Preview builds are 0.0.0-<channel>-<build> (see packages/script/src/index.ts).
  // They are the only ones where --allow-partial makes sense: CI builds a single
  // host target with --single for speed. Stable semver (e.g. 0.4.0) without a
  // prerelease suffix must never be published partial.
  return version.startsWith("0.0.0-")
}

function readme(version: string) {
  return `# force-agent

\`\`\`sh
npx -y force-agent@latest web     # start the server and print how to open the web UI
npm i -g force-agent              # install the command
force service start               # run it in the background
\`\`\`

Version ${version}.

The command is a small Node shim. It resolves the platform binary from the
matching \`@force-agent/cli-<os>-<arch>\` optional dependency at run time, so an
install with \`--ignore-scripts\` works exactly like one without. Set
\`FORCE_BIN_PATH\` to run a binary from somewhere else (\`LABHARNESS_BIN_PATH\`,
\`LABFY_BIN_PATH\`, \`POWER_BIN_PATH\` and \`OPENCODE_BIN_PATH\` are still honored, in
that order).

Published targets: linux-x64, linux-arm64, darwin-arm64, windows-x64.

https://labfy.dev
`
}
