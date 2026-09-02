import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

// The npm shim re-executes the binary when it exits with the restart code (75) — that is how
// a self-update lands: the server installs the new version, exits 75, the shim resolves the
// binary again and runs it with the same argv. Exercised through LABHARNESS_BIN_PATH with a
// shell fixture standing in for the binary. POSIX only: the shim's signal path is POSIX too.
const shim = path.resolve(import.meta.dir, "../bin/force.cjs")
const posix = process.platform !== "win32"

interface Outcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}

// The fixture exits with the N-th code of CODES on its N-th run (the last one repeats), so a
// single script covers "75 once", "always 75" and "plain failure".
function fixture(directory: string, body: string) {
  const file = path.join(directory, "fake-labharness.sh")
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

const counting = `
count=$(cat "$COUNTER" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$COUNTER"
set -- $CODES
i=1
code=$1
for c in "$@"; do
  if [ "$i" -le "$count" ]; then code=$c; fi
  i=$((i + 1))
done
echo "run $count args: $ARGS_MARKER" >&2
exit "$code"
`

function runShim(binary: string, env: Record<string, string>, args: string[] = [], onSpawn?: (pid: number) => void) {
  return new Promise<Outcome>((resolve, reject) => {
    const child = spawn(process.execPath, [shim, ...args], {
      env: { ...process.env, LABHARNESS_BIN_PATH: binary, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }))
    if (onSpawn && child.pid !== undefined) onSpawn(child.pid)
  })
}

function runs(counter: string) {
  return Number(fs.readFileSync(counter, "utf8").trim())
}

describe.if(posix)("labharness.cjs restart on exit code 75", () => {
  test("re-executes once after code 75 and exits with the second run's code", async () => {
    await using tmp = await tmpdir()
    const counter = path.join(tmp.path, "count")
    const binary = fixture(tmp.path, counting)
    const outcome = await runShim(binary, { COUNTER: counter, CODES: "75 0", ARGS_MARKER: "x" }, ["web", "--port", "1"])
    expect(outcome.signal).toBeNull()
    expect(outcome.code).toBe(0)
    expect(runs(counter)).toBe(2)
    // The restarted run gets the same argv.
    expect(outcome.stderr.match(/args: x/g)?.length).toBe(2)
  })

  test("gives up when the restarted process asks to restart again within 5 s", async () => {
    await using tmp = await tmpdir()
    const counter = path.join(tmp.path, "count")
    const binary = fixture(tmp.path, counting)
    const outcome = await runShim(binary, { COUNTER: counter, CODES: "75", ARGS_MARKER: "x" })
    expect(outcome.signal).toBeNull()
    expect(outcome.code).toBe(1)
    // First run → one restart → second run exits 75 too quickly → stop.
    expect(runs(counter)).toBe(2)
    expect(outcome.stderr).toContain("not restarting")
  })

  test("passes any other exit code through untouched", async () => {
    await using tmp = await tmpdir()
    const counter = path.join(tmp.path, "count")
    const binary = fixture(tmp.path, counting)
    const outcome = await runShim(binary, { COUNTER: counter, CODES: "3", ARGS_MARKER: "x" })
    expect(outcome.code).toBe(3)
    expect(runs(counter)).toBe(1)
  })

  test("still forwards SIGINT to the child and dies by the same signal", async () => {
    await using tmp = await tmpdir()
    const binary = fixture(tmp.path, "exec sleep 30")
    const outcome = await runShim(binary, {}, [], (pid) => {
      setTimeout(() => process.kill(pid, "SIGINT"), 500)
    })
    expect(outcome.signal).toBe("SIGINT")
  })
})
