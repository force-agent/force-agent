export * as Browser from "./session.js"

import path from "node:path"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserEvent } from "@opencode-ai/schema/browser-event"
import type { Event } from "@opencode-ai/schema/event"
import { truthy } from "@opencode-ai/util/env"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Global } from "@opencode-ai/util/global"
import { Context, Effect, Layer, Schema } from "effect"
import { Bus } from "../bus.js"
import { Location } from "../location.js"
import { act, PasswordRefusedError, RefNotFoundError } from "./act.js"
import type { CdpClient, CdpEvent } from "./cdp/client.js"
import { canAct, ControlError as ControlRaw, initial, transition, type State as ControlState } from "./control.js"
import { EvaluationError, pageEval, pageFetch } from "./fetch.js"
import { dispatchInput } from "./input.js"
import { Network } from "./network.js"
import { locationKey, onProviderChange, select, type CdpConnection } from "./provider/index.js"
import { read } from "./read.js"
import { Screencasts, type Frame } from "./screencast.js"
import { screenshot } from "./screenshot.js"
import { capture, diff } from "./snapshot.js"
import { INTERVAL_MS, Thumbnails } from "./thumbnail.js"

const LOAD_TIMEOUT_MS = 30_000
const SETTLE_TIMEOUT_MS = 10_000
const ATTACH_TIMEOUT_MS = 5_000
const DEFAULT_HANDOFF_SEC = 300
const HUMAN_IDLE_MS = 60_000
const NAVIGATE_SNAPSHOT_NODES = 150

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Browser.UnavailableError", {
  message: Schema.String,
}) {}

export class TabNotFoundError extends Schema.TaggedError<TabNotFoundError>()("Browser.TabNotFoundError", {
  tabID: Schema.String,
}) {}

export class ControlError extends Schema.TaggedError<ControlError>()("Browser.ControlError", {
  state: Browser.Control,
  hint: Schema.String,
}) {}

export class ActionError extends Schema.TaggedError<ActionError>()("Browser.ActionError", {
  message: Schema.String,
}) {}

export type Error = UnavailableError | TabNotFoundError | ControlError | ActionError

export interface Interface {
  readonly state: () => Effect.Effect<Browser.State>
  readonly open: (input: Browser.OpenTabInput) => Effect.Effect<Browser.Tab, Error>
  readonly close: (tabID: Browser.TabID) => Effect.Effect<void, Error>
  readonly activate: (tabID: Browser.TabID) => Effect.Effect<Browser.Tab, Error>
  readonly navigate: (input: Browser.NavigateInput) => Effect.Effect<Browser.Snapshot, Error>
  readonly snapshot: (input: Browser.SnapshotInput) => Effect.Effect<Browser.Snapshot, Error>
  readonly act: (input: Browser.ActInput) => Effect.Effect<Browser.ActResult, Error>
  readonly read: (input: Browser.ReadInput) => Effect.Effect<Browser.ReadResult, Error>
  readonly screenshot: (input: Browser.ScreenshotInput) => Effect.Effect<Browser.ScreenshotResult, Error>
  readonly thumbnail: (
    tabID: Browser.TabID,
  ) => Effect.Effect<{ readonly version: number; readonly data: Uint8Array }, Error>
  readonly control: (input: Browser.ControlInput) => Effect.Effect<Browser.State>
  readonly handoff: (input: Browser.HandoffInput) => Effect.Effect<Browser.HandoffResult, Error>
  readonly back: (tabID: Browser.TabID) => Effect.Effect<Browser.Tab, Error>
  readonly reload: (tabID: Browser.TabID) => Effect.Effect<Browser.Tab, Error>
  // Screencast frames of one tab while the returned stop function has not been called. The
  // screencast itself runs only while at least one subscriber exists.
  readonly stream: (tabID: Browser.TabID, onFrame: (frame: Frame) => void) => Effect.Effect<() => void, Error>
  // Human input from the panel: takes `human` control (unless a handoff is pending) and hands
  // it back after HUMAN_IDLE_MS without input.
  readonly input: (tabID: Browser.TabID, input: Browser.StreamInput) => Effect.Effect<void, Error>
  // "Page as endpoint": captured traffic of a tab, `fetch` run by the page itself, and JS
  // evaluated in it. Capture is on from the moment a tab attaches.
  readonly network: (input: Browser.NetworkInput) => Effect.Effect<Browser.NetworkResult, Error>
  readonly fetch: (input: Browser.FetchInput) => Effect.Effect<Browser.FetchResult, Error>
  readonly evaluate: (input: Browser.EvalInput) => Effect.Effect<Browser.EvalResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Browser") {}

type Tab = {
  readonly id: string
  readonly sessionId: string
  url: string
  title: string
  // Refs from the latest capture of any mode; `baseline` is the last full tree, which is what
  // `diff` compares against so an interactive listing in between does not read as a change.
  snapshot?: { readonly version: number; readonly refs: Map<string, number> }
  baseline?: string
  // Resolves once Page/Network are enabled for the session; actions wait for it so the first
  // navigation of a fresh tab is captured too.
  ready: Promise<void>
}

class TabGone extends globalThis.Error {
  constructor(readonly tabID: string) {
    super(`Tab not found: ${tabID}`)
  }
}

class Unavailable extends globalThis.Error {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)

    // The provider is picked per connection: a desktop that connects later wins over a launched
    // Chromium, and a desktop that disconnects drops the session (see `onProviderChange` below).
    const key = locationKey({ directory: location.directory, workspaceID: location.workspaceID })
    let providerKind: Browser.Provider | undefined
    let pushedThumbnails = false
    const profile = location.project.id.replace(/[^a-z0-9_-]/gi, "_")
    const profileDir = path.join(global.data, "browser", profile)
    const tabs = new Map<string, Tab>()
    const waiters = new Map<string, Set<() => void>>()
    const thumbnails = new Thumbnails()
    let screencasts: Screencasts | undefined
    let network: Network | undefined
    let humanTimer: ReturnType<typeof setTimeout> | undefined
    let connection: CdpConnection | undefined
    let connecting: Promise<CdpConnection> | undefined
    let userAgent = ""
    let activeTab: string | undefined
    let control: ControlState = initial()
    let versions = 0

    const tabInfo = (tab: Tab): Browser.Tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.id === activeTab,
      thumbnailVersion: thumbnails.get(tab.id)?.version ?? 0,
    })

    const state = (): Browser.State => ({
      running: connection !== undefined,
      provider: connection === undefined ? undefined : providerKind,
      profile,
      control: control.control,
      tabs: [...tabs.values()].map(tabInfo),
      activeTab,
      handoff: control.handoff,
    })

    const publish = <D extends Event.Definition>(definition: D, data: Event.Data<D>) =>
      runFork(bus.publish(definition, data).pipe(Effect.catchCause(() => Effect.void)))
    const publishState = () => publish(BrowserEvent.StateChanged, { state: state() })

    const attach = async (client: CdpClient, event: CdpEvent) => {
      const info = event.params.targetInfo as { targetId: string; type: string; url: string; title: string }
      const sessionId = event.params.sessionId as string
      if (info.type !== "page") return
      const enable = async () => {
        await client.send("Page.enable", {}, sessionId).catch(() => undefined)
        // Capture starts with the tab, not with the first `browser_network` call: the XHR a
        // login page fires is the one worth replaying, and it is gone by the time the agent asks.
        await network?.enable(info.targetId, sessionId).catch(() => undefined)
        // Headless Chromium advertises itself in the UA; the agent's browser should look like a
        // regular Chrome of the same version. The desktop's views already carry a real one.
        if (userAgent && providerKind !== "desktop")
          await client
            .send(
              "Emulation.setUserAgentOverride",
              { userAgent: userAgent.replace("HeadlessChrome", "Chrome") },
              sessionId,
            )
            .catch(() => undefined)
      }
      const existing = tabs.get(info.targetId)
      if (existing) {
        // The desktop re-attached its debugger to a known tab: the domains enabled above are
        // gone with the old attachment, so enable them again without reopening the tab.
        existing.ready = enable()
        await existing.ready
        return
      }
      const tab: Tab = { id: info.targetId, sessionId, url: info.url, title: info.title, ready: enable() }
      tabs.set(tab.id, tab)
      activeTab ??= tab.id
      await tab.ready
      for (const wake of waiters.get(tab.id) ?? []) wake()
      waiters.delete(tab.id)
      publish(BrowserEvent.TabChanged, { tab: tabInfo(tab), op: "opened" })
      publishState()
    }

    const detach = (targetId: string) => {
      const tab = tabs.get(targetId)
      if (!tab) return
      tabs.delete(targetId)
      thumbnails.drop(targetId)
      screencasts?.drop(targetId)
      network?.drop(targetId)
      if (activeTab === targetId) activeTab = tabs.keys().next().value
      publish(BrowserEvent.TabChanged, { tab: tabInfo(tab), op: "closed" })
      publishState()
    }

    const connect = async () => {
      const provider = select(key)
      const opened = await provider
        .connect({ profileDir, headed: truthy("BROWSER_HEADED") })
        .catch((error: unknown) => {
          throw new Unavailable(error instanceof globalThis.Error ? error.message : String(error))
        })
      providerKind = provider.kind
      pushedThumbnails = opened.thumbnails !== undefined
      const client = opened.client
      userAgent = (await client.send<{ userAgent: string }>("Browser.getVersion")).userAgent
      screencasts = new Screencasts(client)
      network = new Network(client, () => control.control === "agent")
      // Thumbnails refresh while the agent drives or a person watches; `touch` throttles per tab.
      const ticker = setInterval(() => {
        for (const tab of tabs.values())
          if ((control.control === "agent" && tab.id === activeTab) || screencasts?.active(tab.id))
            touchThumbnail(client, tab).catch(() => undefined)
      }, INTERVAL_MS)
      const unsubscribeThumbnails = opened.thumbnails?.((tabID, data) => {
        if (!tabs.has(tabID)) return
        publish(BrowserEvent.Thumbnail, { tab: tabID, version: thumbnails.set(tabID, data) })
      })
      client.on("Target.attachedToTarget", (event) => {
        attach(client, event).catch(() => undefined)
      })
      client.on("Target.targetInfoChanged", (event) => {
        const info = event.params.targetInfo as { targetId: string; url: string; title: string }
        const tab = tabs.get(info.targetId)
        if (!tab || (tab.url === info.url && tab.title === info.title)) return
        tab.url = info.url
        tab.title = info.title
        publish(BrowserEvent.TabUrl, { tab: tab.id, url: tab.url, title: tab.title })
      })
      client.on("Target.targetDestroyed", (event) => detach(event.params.targetId as string))
      client.on("Target.detachedFromTarget", (event) => {
        if (typeof event.params.targetId === "string") detach(event.params.targetId)
      })
      client.onClose(() => {
        clearInterval(ticker)
        unsubscribeThumbnails?.()
        screencasts?.close()
        screencasts = undefined
        network?.close()
        network = undefined
        connection = undefined
        connecting = undefined
        for (const id of Array.from(tabs.keys())) detach(id)
        publishState()
      })
      await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      // `Target.targetInfoChanged` (URL and title updates from in-page navigation) only flows
      // once discovery is on; auto-attach alone does not deliver it.
      await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined)
      // Existing pages are not always reported by setAutoAttach; attach to them explicitly.
      const targets = await client.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets")
      for (const target of targets.targetInfos)
        if (target.type === "page" && !tabs.has(target.targetId))
          await client
            .send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
            .catch(() => undefined)
      connection = opened
      publishState()
      return opened
    }

    const ensure = () => {
      connecting ??= connect().catch((error: unknown) => {
        connecting = undefined
        throw error
      })
      return connecting
    }

    // A desktop connecting while a launched Chromium serves this location replaces it: the
    // launched session is closed (tabs drop, `browser.state` fires) and the next action
    // reconnects through the desktop. A desktop disconnecting closes its own transport.
    const unsubscribeProvider = onProviderChange(key, () => {
      const current = connection
      if (!current || providerKind === select(key).kind) return
      connection = undefined
      connecting = undefined
      current.close().catch(() => undefined)
    })

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        clearTimeout(humanTimer)
        unsubscribeProvider()
        const current = connection
        connection = undefined
        connecting = undefined
        if (current) await current.close().catch(() => undefined)
      }),
    )

    const waitForTab = (id: string) =>
      new Promise<Tab>((resolve, reject) => {
        const existing = tabs.get(id)
        if (existing) return resolve(existing)
        const timer = setTimeout(() => reject(new TabGone(id)), ATTACH_TIMEOUT_MS)
        const set = waiters.get(id) ?? new Set()
        set.add(() => {
          clearTimeout(timer)
          resolve(tabs.get(id)!)
        })
        waiters.set(id, set)
      })

    const createTab = async (client: CdpClient, url: string) => {
      const created = await client.send<{ targetId: string }>("Target.createTarget", { url })
      const tab = await waitForTab(created.targetId)
      activeTab = tab.id
      await client.send("Target.activateTarget", { targetId: tab.id }).catch(() => undefined)
      return tab
    }

    // Resolve the requested tab, falling back to the active one and opening a blank tab when the
    // browser has none yet.
    const resolveTab = async (client: CdpClient, tabID: string | undefined) => {
      if (tabID !== undefined) {
        const tab = tabs.get(tabID)
        if (!tab) throw new TabGone(tabID)
        await tab.ready
        return tab
      }
      const active = activeTab === undefined ? undefined : tabs.get(activeTab)
      if (active) await active.ready
      return active ?? createTab(client, "about:blank")
    }

    const refresh = async (client: CdpClient, tab: Tab) => {
      const info = await client
        .send<{ targetInfo: { url: string; title: string } }>("Target.getTargetInfo", { targetId: tab.id })
        .catch(() => undefined)
      if (!info) return
      tab.url = info.targetInfo.url
      tab.title = info.targetInfo.title
    }

    // Wait for the document to settle after an action: a short grace period so a navigation the
    // action triggered has started, then poll readyState. Runtime.evaluate needs no Runtime.enable.
    const settle = async (client: CdpClient, tab: Tab) => {
      await sleep(250)
      const deadline = Date.now() + SETTLE_TIMEOUT_MS
      while (Date.now() < deadline) {
        const ready = await client
          .send<{ result: { value?: string } }>(
            "Runtime.evaluate",
            { expression: "document.readyState", returnByValue: true },
            tab.sessionId,
          )
          .then((result) => result.result.value)
          .catch(() => undefined)
        if (ready === "complete") return
        await sleep(100)
      }
    }

    const takeSnapshot = async (
      client: CdpClient,
      tab: Tab,
      mode: Browser.SnapshotMode,
      maxNodes: number | undefined,
    ): Promise<Browser.Snapshot> => {
      await refresh(client, tab)
      const tree = await capture(client, tab.sessionId, { mode: mode === "diff" ? "full" : mode, maxNodes })
      const previous = tab.baseline
      const version = ++versions
      tab.snapshot = { version, refs: tree.refs }
      if (mode !== "interactive") tab.baseline = tree.text
      return {
        tab: tab.id,
        url: tab.url,
        title: tab.title,
        version,
        mode,
        tree: mode === "diff" ? diff(previous, tree.text) : tree.text,
        nodes: tree.nodes.length,
        truncated: tree.truncated,
      }
    }

    // Providers that push thumbnails (desktop `capturePage`) make CDP captures redundant.
    const touchThumbnail = (client: CdpClient, tab: Tab) =>
      pushedThumbnails
        ? Promise.resolve()
        : thumbnails.touch(client, tab.sessionId, tab.id, screencasts?.latest(tab.id)).then((version) => {
            if (version !== undefined) publish(BrowserEvent.Thumbnail, { tab: tab.id, version })
          })

    const setControl = (input: Parameters<typeof transition>[1]) => {
      const next = transition(control, input)
      if (next === control) return
      control = next
      publishState()
    }

    // Any input from the panel means a person is at the browser: take `human` control (a pending
    // handoff already belongs to them) and give it back after a quiet minute.
    const humanTouch = () => {
      if (control.control !== "human" && control.control !== "handoff-login") setControl("human.take")
      clearTimeout(humanTimer)
      humanTimer = setTimeout(() => {
        if (control.control === "human") setControl("human.release")
      }, HUMAN_IDLE_MS)
    }

    // Every agent action: connect lazily, resolve the tab, hold `agent` control for the duration,
    // and refresh the thumbnail on the way out.
    const withAgent = <A>(tabID: string | undefined, body: (client: CdpClient, tab: Tab) => Promise<A>) =>
      Effect.tryPromise({
        try: async () => {
          const client = (await ensure()).client
          setControl("agent.acquire")
          const tab = await resolveTab(client, tabID)
          return body(client, tab).finally(() => {
            setControl("agent.release")
            touchThumbnail(client, tab).catch(() => undefined)
          })
        },
        catch: failure,
      })

    // Read-only paths do not take control but still refuse while a person holds the browser: a
    // snapshot taken mid-login would carry what they typed into the model context.
    const withReader = <A>(tabID: string | undefined, body: (client: CdpClient, tab: Tab) => Promise<A>) =>
      Effect.tryPromise({
        try: async () => {
          const client = (await ensure()).client
          if (!canAct(control))
            throw new ControlRaw(control.control, "A person is using the browser; wait or use browser_handoff.")
          return body(client, await resolveTab(client, tabID))
        },
        catch: failure,
      })

    const navigate = Effect.fn("Browser.navigate")(function* (input: Browser.NavigateInput) {
      const url = yield* Effect.try({
        try: () => new URL(input.url),
        catch: () => new ActionError({ message: `Invalid URL: ${input.url}` }),
      })
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return yield* new ActionError({ message: "URL must use http:// or https://" })
      return yield* withAgent(input.tab, async (client, tab) => {
        const loaded = client
          .once("Page.loadEventFired", (event) => event.sessionId === tab.sessionId, LOAD_TIMEOUT_MS)
          .then(
            () => true,
            () => false,
          )
        const result = await client.send<{ errorText?: string }>("Page.navigate", { url: url.href }, tab.sessionId)
        if (result.errorText) throw new globalThis.Error(`Navigation failed: ${result.errorText}`)
        await loaded
        await settle(client, tab)
        // Network idle needs Network.enable (phase 7); approximate with a short quiet period.
        if (input.wait === "networkidle") await sleep(500)
        return takeSnapshot(client, tab, "full", NAVIGATE_SNAPSHOT_NODES)
      })
    })

    const snapshot = Effect.fn("Browser.snapshot")(function* (input: Browser.SnapshotInput) {
      return yield* withReader(input.tab, (client, tab) =>
        takeSnapshot(client, tab, input.mode ?? "full", input.maxNodes),
      )
    })

    const perform = Effect.fn("Browser.act")(function* (input: Browser.ActInput) {
      return yield* withAgent(input.tab, async (client, tab) => {
        await act({ client, sessionId: tab.sessionId, refs: tab.snapshot?.refs ?? new Map() }, input)
        await settle(client, tab)
        const next = await takeSnapshot(client, tab, "diff", undefined)
        return { tab: tab.id, url: next.url, title: next.title, version: next.version, diff: next.tree }
      })
    })

    const readPage = Effect.fn("Browser.read")(function* (input: Browser.ReadInput) {
      return yield* withReader(input.tab, async (client, tab) => {
        await refresh(client, tab)
        const result = await read(client, tab.sessionId, input)
        return { tab: tab.id, url: tab.url, title: tab.title, ...result }
      })
    })

    const shoot = Effect.fn("Browser.screenshot")(function* (input: Browser.ScreenshotInput) {
      return yield* withReader(input.tab, async (client, tab) => {
        const backendNodeId = input.ref === undefined ? undefined : tab.snapshot?.refs.get(input.ref)
        if (input.ref !== undefined && backendNodeId === undefined) throw new RefNotFoundError(input.ref)
        await refresh(client, tab)
        const image = await screenshot(client, tab.sessionId, { backendNodeId, fullPage: input.fullPage })
        return { tab: tab.id, url: tab.url, ...image }
      })
    })

    const thumbnail = Effect.fn("Browser.thumbnail")(function* (tabID: Browser.TabID) {
      return yield* Effect.tryPromise({
        try: async () => {
          const tab = tabs.get(tabID)
          if (!tab || !connection) throw new TabGone(tabID)
          if (!pushedThumbnails)
            await thumbnails.touch(connection.client, tab.sessionId, tab.id, screencasts?.latest(tab.id))
          const current = thumbnails.get(tab.id)
          if (!current) throw new globalThis.Error("Thumbnail unavailable")
          return { version: current.version, data: current.data }
        },
        catch: failure,
      })
    })

    const open = Effect.fn("Browser.open")(function* (input: Browser.OpenTabInput) {
      return yield* Effect.tryPromise({
        try: async () => {
          const client = (await ensure()).client
          // A freshly launched Chromium already has one untouched about:blank tab; opening another
          // blank tab adopts it instead of leaving two empty tabs behind.
          const blank = [...tabs.values()].find((item) => item.url === "about:blank" && item.snapshot === undefined)
          if (input.url === undefined && blank) {
            activeTab = blank.id
            publish(BrowserEvent.TabChanged, { tab: tabInfo(blank), op: "activated" })
            publishState()
            return tabInfo(blank)
          }
          setControl("agent.acquire")
          const tab = await createTab(client, input.url ?? "about:blank").finally(() => setControl("agent.release"))
          publish(BrowserEvent.TabChanged, { tab: tabInfo(tab), op: "activated" })
          publishState()
          return tabInfo(tab)
        },
        catch: failure,
      })
    })

    const close = Effect.fn("Browser.close")(function* (tabID: Browser.TabID) {
      return yield* Effect.tryPromise({
        try: async () => {
          const client = (await ensure()).client
          if (!tabs.has(tabID)) throw new TabGone(tabID)
          await client.send("Target.closeTarget", { targetId: tabID })
          detach(tabID)
        },
        catch: failure,
      })
    })

    const activate = Effect.fn("Browser.activate")(function* (tabID: Browser.TabID) {
      return yield* Effect.tryPromise({
        try: async () => {
          const client = (await ensure()).client
          const tab = tabs.get(tabID)
          if (!tab) throw new TabGone(tabID)
          await client.send("Target.activateTarget", { targetId: tabID }).catch(() => undefined)
          activeTab = tabID
          publish(BrowserEvent.TabChanged, { tab: tabInfo(tab), op: "activated" })
          publishState()
          return tabInfo(tab)
        },
        catch: failure,
      })
    })

    const setOwner = Effect.fn("Browser.control")(function* (input: Browser.ControlInput) {
      if (input.owner === "human") humanTouch()
      // A person may ask for `agent` while a human holds it; refusing is the state machine's job,
      // and the returned state tells the caller who still owns the browser.
      if (input.owner === "agent")
        yield* Effect.try({ try: () => setControl("agent.acquire"), catch: () => undefined }).pipe(
          Effect.catch(() => Effect.void),
        )
      if (input.owner === "release") {
        clearTimeout(humanTimer)
        setControl(
          control.control === "handoff-login"
            ? "handoff.end"
            : control.control === "human"
              ? "human.release"
              : "agent.release",
        )
      }
      return state()
    })

    // Back and reload come from the panel toolbar, so they neither take agent control nor refuse
    // while a person holds the browser.
    const history = (name: string, command: (client: CdpClient, tab: Tab) => Promise<unknown>) =>
      Effect.fn(name)(function* (tabID: Browser.TabID) {
        return yield* Effect.tryPromise({
          try: async () => {
            const client = (await ensure()).client
            const tab = tabs.get(tabID)
            if (!tab) throw new TabGone(tabID)
            await command(client, tab)
            await settle(client, tab)
            await refresh(client, tab)
            publishState()
            touchThumbnail(client, tab).catch(() => undefined)
            return tabInfo(tab)
          },
          catch: failure,
        })
      })

    const back = history("Browser.back", async (client, tab) => {
      const nav = await client.send<{ currentIndex: number; entries: { id: number }[] }>(
        "Page.getNavigationHistory",
        {},
        tab.sessionId,
      )
      const previous = nav.entries[nav.currentIndex - 1]
      if (!previous) return
      await client.send("Page.navigateToHistoryEntry", { entryId: previous.id }, tab.sessionId)
    })

    const reload = history("Browser.reload", (client, tab) => client.send("Page.reload", {}, tab.sessionId))

    const stream = Effect.fn("Browser.stream")(function* (tabID: Browser.TabID, onFrame: (frame: Frame) => void) {
      return yield* Effect.tryPromise({
        try: async () => {
          const client = (await ensure()).client
          const tab = tabs.get(tabID)
          if (!tab || !screencasts) throw new TabGone(tabID)
          const stop = screencasts.subscribe(tab.id, tab.sessionId, onFrame)
          touchThumbnail(client, tab).catch(() => undefined)
          return stop
        },
        catch: failure,
      })
    })

    const input = Effect.fn("Browser.input")(function* (tabID: Browser.TabID, event: Browser.StreamInput) {
      return yield* Effect.tryPromise({
        try: async () => {
          const client = (await ensure()).client
          const tab = tabs.get(tabID)
          if (!tab) throw new TabGone(tabID)
          humanTouch()
          await dispatchInput(client, tab.sessionId, event)
        },
        catch: failure,
      })
    })

    const handoff = Effect.fn("Browser.handoff")(function* (input: Browser.HandoffInput) {
      const started = yield* Effect.tryPromise({
        try: async () => {
          const client = (await ensure()).client
          const tab = await resolveTab(client, input.tab)
          await refresh(client, tab)
          const request: Browser.Handoff = { tab: tab.id, reason: input.reason, until: input.until, since: Date.now() }
          setControl({ handoff: request })
          publish(BrowserEvent.HandoffRequested, { handoff: request })
          await touchThumbnail(client, tab).catch(() => undefined)
          return { client, tab, request }
        },
        catch: failure,
      })
      const pattern = input.until === undefined ? undefined : new RegExp(input.until)
      const deadline = Date.now() + (input.timeoutSec ?? DEFAULT_HANDOFF_SEC) * 1000
      // Ends when the person releases control (or takes and releases it), the URL matches
      // `until`, or the timeout fires.
      while (true) {
        const released = control.handoff !== started.request
        yield* Effect.promise(() => refresh(started.client, started.tab))
        const matched = pattern?.test(started.tab.url) ?? false
        if (released || matched) {
          if (control.handoff === started.request) setControl("handoff.end")
          return { completed: true, tab: started.tab.id, url: started.tab.url }
        }
        if (Date.now() >= deadline) {
          setControl("handoff.end")
          return { completed: false, tab: started.tab.id, url: started.tab.url }
        }
        yield* Effect.sleep("1 second")
      }
    })

    const listNetwork = Effect.fn("Browser.network")(function* (input: Browser.NetworkInput) {
      return yield* withReader(input.tab, async (client, tab) => {
        await refresh(client, tab)
        const log = network
        if (!log) throw new Unavailable("Browser is not running")
        const listed = log.list(tab.id, input)
        const body = input.body === undefined ? undefined : await log.body(tab.id, input.body)
        return { tab: tab.id, url: tab.url, entries: listed.entries, total: listed.total, body }
      })
    })

    const fetchInPage = Effect.fn("Browser.fetch")(function* (input: Browser.FetchInput) {
      return yield* withAgent(input.tab, async (client, tab) => {
        const { tab: _, ...rest } = input
        const result = await pageFetch(client, tab.sessionId, rest)
        return { tab: tab.id, ...result }
      })
    })

    const evaluate = Effect.fn("Browser.evaluate")(function* (input: Browser.EvalInput) {
      return yield* withAgent(input.tab, async (client, tab) => {
        const { tab: _, ...rest } = input
        const result = await pageEval(client, tab.sessionId, rest)
        await refresh(client, tab)
        return { tab: tab.id, url: tab.url, ...result }
      })
    })

    return Service.of({
      state: () => Effect.sync(state),
      network: listNetwork,
      fetch: fetchInPage,
      evaluate,
      open,
      close,
      activate,
      navigate,
      snapshot,
      act: perform,
      read: readPage,
      screenshot: shoot,
      thumbnail,
      control: setOwner,
      handoff,
      back,
      reload,
      stream,
      input,
    })
  }),
)

function failure(error: unknown): Error {
  if (error instanceof ControlRaw) return new ControlError({ state: error.state, hint: error.hint })
  if (error instanceof TabGone) return new TabNotFoundError({ tabID: error.tabID })
  if (error instanceof Unavailable) return new UnavailableError({ message: error.message })
  if (error instanceof RefNotFoundError || error instanceof PasswordRefusedError || error instanceof EvaluationError)
    return new ActionError({ message: error.message })
  return new ActionError({ message: error instanceof globalThis.Error ? error.message : String(error) })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Location.node, Global.node],
})
