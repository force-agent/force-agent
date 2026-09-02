import { describe, expect, test } from "bun:test"
import { createWebUpdater, WebUpdateTimeoutError, type WebUpdaterWorker } from "./web-updater"

type Call = { method: string; path: string; body?: unknown }

const status = (extra: Record<string, unknown> = {}) => ({
  current: "2.0.0",
  latest: "9.9.9",
  available: true,
  manager: "npm",
  canApply: true,
  command: "npm i -g force-agent@9.9.9",
  phase: { type: "idle" },
  ...extra,
})

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init })

/** A scripted server: `update` and `health` are read on each call so a test can flip them mid-flight. */
function server(script: { update: () => unknown; health: () => Response; onApply?: () => unknown }) {
  const calls: Call[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ method, path: url.pathname + url.search, body })
    if (url.pathname === "/api/health") return script.health()
    if (url.pathname === "/api/update/apply") return json(script.onApply?.() ?? script.update(), { status: 202 })
    if (url.pathname === "/api/update") return json(script.update())
    return new Response("not found", { status: 404 })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

function fakeWorker(initial: string) {
  const listeners = new Set<() => void>()
  const worker: WebUpdaterWorker & { messages: unknown[]; set(state: string): void } = {
    state: initial,
    messages: [],
    postMessage(message) {
      worker.messages.push(message)
      // Workbox's SKIP_WAITING handler: the waiting worker activates.
      worker.set("activating")
      worker.set("activated")
    },
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    set(state) {
      worker.state = state
      for (const listener of [...listeners]) listener()
    },
  }
  return worker
}

const quick = { pollMs: 0, sleep: () => Promise.resolve(), serviceWorkerTimeoutMs: 0 }

describe("createWebUpdater", () => {
  test("check maps the server status onto updater states", async () => {
    const answers: unknown[] = [
      status(),
      status({ canApply: false, reason: "local" }),
      status({ available: false, latest: "2.0.0" }),
      status({ phase: { type: "error", message: "npm failed", hint: "sudo npm i -g force-agent" } }),
    ]
    const { calls, fetch } = server({ update: () => answers.shift(), health: () => json({}) })
    const updater = createWebUpdater({ baseUrl: "http://srv", fetch, authorization: () => "dXNlcjpwdw==" })

    expect(await updater.check()).toEqual({ status: "ready", version: "9.9.9" })
    expect(await updater.check()).toEqual({
      status: "manual",
      version: "9.9.9",
      command: "npm i -g force-agent@9.9.9",
    })
    expect(await updater.check()).toEqual({ status: "up-to-date" })
    expect(await updater.check()).toEqual({ status: "error", message: "npm failed (sudo npm i -g force-agent)" })
    expect(calls.map((call) => call.path)).toEqual(Array(4).fill("/api/update?refresh=true"))
  })

  test("check reports a failed request as an error state", async () => {
    const rejected = (async () =>
      new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof globalThis.fetch
    const updater = createWebUpdater({ baseUrl: "http://srv", fetch: rejected })
    expect(await updater.check()).toEqual({ status: "error", message: "401 Unauthorized" })
  })

  test("install applies, waits for the restart and the new process, promotes the worker, then reloads", async () => {
    let phase: unknown = { type: "idle" }
    let updatePolls = 0
    let polls = 0
    const pid = 41
    const { calls, fetch } = server({
      update: () => {
        // First GET is the check, second is the first poll after apply, third answers "restarting".
        if (++updatePolls === 3) phase = { type: "restarting", version: "9.9.9", pid }
        return status({ phase })
      },
      onApply: () => {
        phase = { type: "installing", version: "9.9.9" }
        return status({ phase })
      },
      health: () => {
        polls += 1
        // The old process answers once (pid capture); then the server is down (503) and the old
        // pid answers again before the new pid comes up on the target version.
        if (polls === 1) return json({ healthy: true, version: "2.0.0", pid })
        if (polls === 2) return new Response("", { status: 503, headers: { "retry-after": "1" } })
        if (polls === 3) return json({ healthy: true, version: "9.9.9", pid })
        return json({ healthy: true, version: "9.9.9", pid: pid + 1 })
      },
    })
    let reloads = 0
    const worker = fakeWorker("installing")
    const registration = {
      waiting: null,
      installing: worker,
      unregistered: 0,
      update: async () => {
        queueMicrotask(() => worker.set("installed"))
      },
      unregister: async () => {
        registration.unregistered += 1
        return true
      },
    }
    const updater = createWebUpdater({
      baseUrl: "http://srv",
      fetch,
      ...quick,
      serviceWorkerTimeoutMs: 1000,
      serviceWorker: { getRegistration: async () => registration },
      reload: () => void (reloads += 1),
    })

    expect(await updater.check()).toEqual({ status: "ready", version: "9.9.9" })
    const install = updater.install()
    expect(updater.state()).toEqual({ status: "installing", version: "9.9.9" })
    await install

    expect(updater.state()).toEqual({ status: "restarting", version: "9.9.9" })
    expect(calls.find((call) => call.method === "POST")).toEqual({
      method: "POST",
      path: "/api/update/apply",
      body: { version: "9.9.9" },
    })
    expect(updatePolls).toBe(3)
    // Health was asked before apply (pid capture) and polled until the new pid answered.
    expect(polls).toBe(4)
    expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }])
    expect(registration.unregistered).toBe(0)
    expect(reloads).toBe(1)
  })

  test("install surfaces an install failure reported by the server and does not reload", async () => {
    let phase: unknown = { type: "idle" }
    const { fetch } = server({
      update: () => status({ phase }),
      onApply: () => {
        phase = { type: "error", message: "EACCES", hint: "sudo npm i -g force-agent@9.9.9" }
        return status({ phase: { type: "installing", version: "9.9.9" } })
      },
      health: () => json({ healthy: true, version: "2.0.0", pid: 7 }),
    })
    let reloads = 0
    const updater = createWebUpdater({ baseUrl: "http://srv", fetch, ...quick, reload: () => void (reloads += 1) })
    await updater.check()
    await expect(updater.install()).rejects.toThrow("EACCES (sudo npm i -g force-agent@9.9.9)")
    expect(updater.state()).toEqual({ status: "error", message: "EACCES (sudo npm i -g force-agent@9.9.9)" })
    expect(reloads).toBe(0)
  })

  test("install gives up after the deadline when the new server never answers", async () => {
    const { fetch } = server({
      update: () => status(),
      onApply: () => status({ phase: { type: "restarting", version: "9.9.9", pid: 7 } }),
      health: () => new Response("", { status: 503 }),
    })
    let reloads = 0
    const updater = createWebUpdater({
      baseUrl: "http://srv",
      fetch,
      pollMs: 1,
      deadlineMs: 20,
      reload: () => void (reloads += 1),
    })
    await updater.check()
    const failure = await updater.install().catch((error) => error)
    expect(failure).toBeInstanceOf(WebUpdateTimeoutError)
    expect(failure).toMatchObject({ version: "9.9.9", command: "npm i -g force-agent@9.9.9" })
    expect(updater.state()).toMatchObject({ status: "error" })
    expect(reloads).toBe(0)
  })

  test("install drops a service worker that fails to update so the reload goes to the network", async () => {
    let calls = 0
    const { fetch } = server({
      update: () => status(),
      onApply: () => status({ phase: { type: "restarting", version: "9.9.9", pid: 7 } }),
      health: () => json({ healthy: true, version: calls++ === 0 ? "2.0.0" : "9.9.9", pid: calls }),
    })
    const registration = {
      waiting: null,
      installing: null,
      unregistered: 0,
      update: async () => {
        throw new TypeError("Failed to fetch")
      },
      unregister: async () => {
        registration.unregistered += 1
        return true
      },
    }
    let reloads = 0
    const updater = createWebUpdater({
      baseUrl: "http://srv",
      fetch,
      ...quick,
      serviceWorker: { getRegistration: async () => registration },
      reload: () => void (reloads += 1),
    })
    await updater.check()
    await updater.install()
    expect(registration.unregistered).toBe(1)
    expect(reloads).toBe(1)
  })
})
