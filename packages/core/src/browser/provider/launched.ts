import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import { env } from "@opencode-ai/util/env"
import { which } from "../../util/which.js"
import { CdpClient } from "../cdp/client.js"
import { pipeTransport } from "../cdp/pipe.js"
import { websocketTransport } from "../cdp/websocket.js"
import type { CdpConnection, CdpProvider, ConnectOptions } from "./index.js"

const NAMES = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "msedge", "chrome"]

const MAC_BUNDLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]

const READY_TIMEOUT_MS = 15_000

// Resolution order from the plan: explicit env, PATH names, macOS bundles, then the Playwright
// cache. Nothing is downloaded here; `labharness browser install` is the opt-in for that.
export function resolveExecutable(): string | undefined {
  const explicit = env("BROWSER_PATH")
  if (explicit) return explicit
  for (const name of NAMES) {
    const found = which(name)
    if (found) return found
  }
  for (const bundle of MAC_BUNDLES) if (fs.existsSync(bundle)) return bundle
  return playwrightChromium()
}

export function playwrightChromium(): string | undefined {
  const root = path.join(os.homedir(), ".cache", "ms-playwright")
  if (!fs.existsSync(root)) return undefined
  const dirs = fs
    .readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .toSorted((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  const candidates = [
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-win/chrome.exe",
  ]
  return dirs
    .flatMap((dir) => candidates.map((candidate) => path.join(root, dir, candidate)))
    .find((candidate) => fs.existsSync(candidate))
}

function flags(options: ConnectOptions) {
  return [
    `--user-data-dir=${options.profileDir}`,
    ...(options.headed ? [] : ["--headless=new"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--window-size=1280,800",
  ]
}

async function launchPipe(executable: string, options: ConnectOptions): Promise<CdpConnection> {
  const child = spawn(executable, [...flags(options), "--remote-debugging-pipe", "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  })
  const input = child.stdio[3] as Writable | null
  const output = child.stdio[4] as Readable | null
  if (!input || !output) {
    child.kill()
    throw new Error("Chromium did not expose the remote debugging pipe")
  }
  const client = new CdpClient(pipeTransport(input, output))
  await Promise.race([client.send("Target.getTargets"), exited(child)]).catch((error) => {
    client.close()
    child.kill()
    throw error
  })
  return { client, close: () => stop(child, client) }
}

async function launchPort(executable: string, options: ConnectOptions): Promise<CdpConnection> {
  const marker = path.join(options.profileDir, "DevToolsActivePort")
  fs.rmSync(marker, { force: true })
  const child = spawn(executable, [...flags(options), "--remote-debugging-port=0", "about:blank"], {
    stdio: ["ignore", "ignore", "ignore"],
  })
  // A spawn that never starts (a bad path from the env, a binary without the exec bit) emits
  // `error` and no exit code: without this listener the process reports it as unhandled and the
  // loop below still burns the whole timeout before saying anything useful.
  let spawnFailure: Error | undefined
  child.once("error", (error) => {
    spawnFailure = error
  })
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (!fs.existsSync(marker)) {
    if (spawnFailure) throw spawnFailure
    if (child.exitCode !== null) throw new Error(`Chromium exited with code ${child.exitCode}`)
    if (Date.now() > deadline) {
      child.kill()
      throw new Error("Timed out waiting for DevToolsActivePort")
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const [port, wsPath] = fs.readFileSync(marker, "utf8").split("\n")
  const client = new CdpClient(await websocketTransport(`ws://127.0.0.1:${port}${wsPath}`))
  return { client, close: () => stop(child, client) }
}

function exited(child: ChildProcess) {
  return new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`Chromium exited with code ${code}`)))
    child.once("error", reject)
    setTimeout(() => reject(new Error("Timed out waiting for the remote debugging pipe")), READY_TIMEOUT_MS)
  })
}

async function stop(child: ChildProcess, client: CdpClient) {
  await client.send("Browser.close").catch(() => undefined)
  client.close()
  if (child.exitCode === null) child.kill()
}

export const launched: CdpProvider = {
  kind: "launched",
  connect: async (options) => {
    const executable = resolveExecutable()
    if (!executable)
      throw new Error(
        "No Chromium found. Set LABHARNESS_BROWSER_PATH, install Chrome/Chromium, or run `labharness browser install`.",
      )
    fs.mkdirSync(options.profileDir, { recursive: true })
    // Both launch strategies failed: say which binary was tried and how to point at another one,
    // otherwise the panel shows a CDP detail ("Timed out waiting for DevToolsActivePort") that
    // tells nobody what to install.
    return launchPipe(executable, options)
      .catch(() => launchPort(executable, options))
      .catch((cause: unknown) => {
        throw new Error(
          `Could not start a browser at ${executable}: ${cause instanceof globalThis.Error ? cause.message : String(cause)}. ` +
            "Set LABHARNESS_BROWSER_PATH to a Chrome/Chromium binary, install Chrome/Chromium, or run `labharness browser install`.",
        )
      })
  },
}
