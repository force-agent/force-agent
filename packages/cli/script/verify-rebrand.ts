#!/usr/bin/env bun
// force-agent overlay: rebrand regression gate.
//
// The fork's identity lives in a handful of one-line constants (the XDG app
// name, the compiled binary name, the branded env prefix, the npm scope). A
// merge from upstream reverts any of them silently and the result still builds,
// still passes typecheck and still runs - it just writes to ~/.local/share/opencode
// again and publishes packages nobody installs. This script is the check that
// makes such a revert loud, and it runs in CI before anything is published.
//
//   bun run script/verify-rebrand.ts              # source constants only
//   bun run script/verify-rebrand.ts ./dist       # source + built distribution

import path from "node:path"
import { readdir, stat } from "node:fs/promises"

const root = path.resolve(import.meta.dirname, "..", "..", "..")
const failures: string[] = []
const notes: string[] = []

function check(condition: boolean, message: string) {
  if (!condition) failures.push(message)
}

async function contains(file: string, marker: string) {
  return (await Bun.file(file).text()).includes(marker)
}

// The constants that ARE the rebrand. Each one is a single line upstream owns,
// which is exactly why a merge can take it back without any conflict.
const sources: ReadonlyArray<{ file: string; markers: ReadonlyArray<string> }> = [
  { file: "packages/util/src/global.ts", markers: [`const app = "force-agent"`] },
  { file: "packages/cli/script/build.ts", markers: [`const binary = "force"`, `@force-agent/${"$"}{name}`] },
  // Every spelling, on purpose: FORCE_AGENT_ is the brand and LABHARNESS_, LABFY_ and
  // POWER_ are the ones before it, all still honored. Losing a fallback boots a
  // server with no password an existing deployment already set.
  {
    file: "packages/cli/src/env.ts",
    markers: [`"FORCE_AGENT_PASSWORD"`, `"LABHARNESS_PASSWORD"`, `"LABFY_PASSWORD"`, `"POWER_PASSWORD"`],
  },
  {
    file: "packages/util/src/env.ts",
    markers: [
      `PREFIX = "FORCE_AGENT_"`,
      `PREVIOUS_PREFIX = "LABHARNESS_"`,
      `LABFY_PREFIX = "LABFY_"`,
      `LEGACY_PREFIX = "POWER_"`,
      `UPSTREAM_PREFIX = "OPENCODE_"`,
    ],
  },
  {
    file: "packages/cli/bin/force.cjs",
    markers: [
      `const command = "force"`,
      `const scope = "@force-agent"`,
      // The binary override keeps the same chain as every other branded var.
      `"FORCE_AGENT_BIN_PATH"`,
      `"LABHARNESS_BIN_PATH"`,
      `"OPENCODE_BIN_PATH"`,
    ],
  },
  { file: "packages/cli/script/dist-package.ts", markers: [`name: "force-agent"`, `"@force-agent/"`] },
  // An upgrade that reinstalls @opencode-ai/cli replaces the fork with upstream.
  { file: "packages/cli/src/services/updater.ts", markers: [`: "force-agent"`] },
  // The Update button asks npm about this exact package; the wrong name here
  // makes the server check a package it is not, and never offer an update.
  { file: "packages/core/src/self-update.ts", markers: [`?? "force-agent"`] },
  { file: "packages/cli/src/services/self-update-applier.ts", markers: [`packageName = "force-agent"`] },
]

for (const source of sources) {
  const file = path.join(root, source.file)
  if (!(await Bun.file(file).exists())) {
    failures.push(`${source.file} is missing`)
    continue
  }
  for (const marker of source.markers)
    check(await contains(file, marker), `${source.file} no longer contains ${JSON.stringify(marker)}`)
}

const distribution = process.argv[2]
if (distribution !== undefined) await verifyDistribution(path.resolve(distribution))

if (notes.length > 0) console.log(notes.join("\n"))
if (failures.length > 0) {
  console.error(["Rebrand regression:", ...failures.map((failure) => `  - ${failure}`)].join("\n"))
  process.exit(1)
}
console.log("rebrand ok")

async function verifyDistribution(dist: string) {
  const platforms = (await readdir(dist, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("cli-"))
    .map((entry) => entry.name)
  check(platforms.length > 0, `${dist} contains no cli-* platform directories`)

  for (const platform of platforms) {
    const manifest = path.join(dist, platform, "package.json")
    if (!(await Bun.file(manifest).exists())) {
      failures.push(`${platform} has no package.json`)
      continue
    }
    const pkg = await Bun.file(manifest).json()
    check(
      typeof pkg.name === "string" && pkg.name === `@force-agent/${platform}`,
      `${platform} is published as ${pkg.name} instead of @force-agent/${platform}`,
    )
    // A platform package must not declare `bin`: npm would link a second command
    // and race the root package's shim for the same name.
    check(pkg.bin === undefined, `${platform} declares a bin entry; only the root package may`)
    check(Array.isArray(pkg.os) && pkg.os.length === 1, `${platform} does not pin a single os`)
    check(Array.isArray(pkg.cpu) && pkg.cpu.length === 1, `${platform} does not pin a single cpu`)

    const windows = platform.includes("-windows-") || platform.endsWith("-windows")
    const binary = path.join(dist, platform, "bin", `force${windows ? ".exe" : ""}`)
    if (!(await Bun.file(binary).exists())) {
      failures.push(`${platform} has no bin/force${windows ? ".exe" : ""}`)
      continue
    }
    check((await stat(binary)).size > 10_000_000, `${platform} binary is implausibly small`)
    const found = await scan(
      binary,
      ["--user-agent=force/", "FORCE_AGENT_PASSWORD", "LABHARNESS_PASSWORD", "LABFY_PASSWORD", "POWER_PASSWORD"],
      ["opencode2"],
    )
    check(
      found.required.includes("--user-agent=force/"),
      `${platform} binary was compiled without the force user agent (OPENCODE_CLI_NAME define lost)`,
    )
    check(
      found.required.includes("FORCE_AGENT_PASSWORD"),
      `${platform} binary does not know the FORCE_AGENT_PASSWORD variable`,
    )
    // The older brands are not optional either: an operator who exported
    // LABHARNESS_, LABFY_ or POWER_SERVER_PASSWORD before a rename must not get
    // an unauthenticated server.
    check(
      found.required.includes("LABHARNESS_PASSWORD"),
      `${platform} binary dropped the LABHARNESS_PASSWORD fallback`,
    )
    check(found.required.includes("LABFY_PASSWORD"), `${platform} binary dropped the LABFY_PASSWORD fallback`)
    check(found.required.includes("POWER_PASSWORD"), `${platform} binary dropped the legacy POWER_PASSWORD fallback`)
    // Informational, not a gate: upstream prose and a few help strings still say
    // "opencode2". They are cosmetic and outside this feature; the count makes a
    // sudden jump visible in the CI log.
    notes.push(`${platform}: residual "opencode2" occurrences (approximate): ${found.counts["opencode2"] ?? 0}`)
  }

  const rootManifest = path.join(dist, "force-agent", "package.json")
  if (!(await Bun.file(rootManifest).exists())) return failures.push(`${dist}/force-agent/package.json is missing`)
  const pkg = await Bun.file(rootManifest).json()
  const serialized = JSON.stringify(pkg)
  check(pkg.name === "force-agent", `root package is named ${pkg.name}`)
  check(
    JSON.stringify(pkg.bin) === JSON.stringify({ force: "./bin/force.cjs" }),
    `root package bin is ${JSON.stringify(pkg.bin)} instead of the force shim`,
  )
  check(!serialized.includes("@opencode-ai/"), "root package still references an @opencode-ai package")
  check(!serialized.includes("opencode2"), "root package still references the opencode2 command")
  const optional: Record<string, string> = pkg.optionalDependencies ?? {}
  check(Object.keys(optional).length > 0, "root package declares no platform packages")
  for (const name of Object.keys(optional))
    check(name.startsWith("@force-agent/cli-"), `root package depends on ${name}, which is not a platform package`)
  for (const platform of platforms)
    check(
      optional[`@force-agent/${platform}`] !== undefined,
      `root package does not depend on the built @force-agent/${platform}`,
    )
  const shim = path.join(dist, "force-agent", "bin", "force.cjs")
  check(await contains(shim, `const command = "force"`), "the shipped shim is not the force shim")
  check(await contains(shim, `const scope = "@force-agent"`), "the shipped shim resolves a scope other than @force-agent")
}

// Streamed so a 140MB executable never lands in memory at once, with an overlap
// window so a marker split across two chunks is still seen.
async function scan(file: string, required: ReadonlyArray<string>, counted: ReadonlyArray<string>) {
  const markers = [...required, ...counted]
  const overlap = Math.max(...markers.map((marker) => marker.length)) - 1
  const seen = new Set<string>()
  const counts: Record<string, number> = {}
  const reader = Bun.file(file).stream().getReader()
  let trailing = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    const text = trailing + Buffer.from(chunk.value).toString("latin1")
    for (const marker of markers) {
      if (!text.includes(marker)) continue
      seen.add(marker)
      counts[marker] = (counts[marker] ?? 0) + text.split(marker).length - 1
    }
    trailing = text.slice(-overlap)
  }
  return { required: required.filter((marker) => seen.has(marker)), counts }
}
