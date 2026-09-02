import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server, ServerWebSocket } from "bun"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Browser } from "@opencode-ai/core/browser/session"
import { attach, type DesktopSocket, type Outbound } from "@opencode-ai/core/browser/provider/desktop"
import { locationKey, select } from "@opencode-ai/core/browser/provider/index"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tempGlobalLayer } from "../fixture/global"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

// The server side of `/api/browser/provider`, reduced to what the handler does: adapt one
// WebSocket into a `DesktopSocket` and hand it to `attach` for this test's location key.
type State = { readonly listeners: Set<(message: string) => void>; readonly closers: Set<() => void> }

const directory = AbsolutePath.make("/tmp/labharness-desktop-provider-test")
const key = locationKey({ directory, workspaceID: undefined })

let server: Server<State> | undefined
let url = ""

beforeAll(() => {
  server = Bun.serve<State>({
    port: 0,
    fetch: (request, server) => {
      const state: State = { listeners: new Set(), closers: new Set() }
      if (server.upgrade(request, { data: state })) return
      return new Response("expected websocket", { status: 400 })
    },
    websocket: {
      open: (ws) => {
        const socket: DesktopSocket = {
          send: (message) => ws.send(message),
          onMessage: (listener) => {
            ws.data.listeners.add(listener)
            return () => ws.data.listeners.delete(listener)
          },
          onClose: (listener) => {
            ws.data.closers.add(listener)
            return () => ws.data.closers.delete(listener)
          },
          close: () => ws.close(),
        }
        attach(key, socket).catch(() => undefined)
      },
      message: (ws, message) => {
        for (const listener of ws.data.listeners) listener(String(message))
      },
      close: (ws) => {
        for (const listener of ws.data.closers) listener()
      },
    },
  })
  url = `ws://127.0.0.1:${server.port}/api/browser/provider`
})

afterAll(() => {
  server?.stop(true)
})

const axTree = {
  nodes: [
    { nodeId: "1", ignored: false, role: { value: "WebArea" }, name: { value: "Desk" }, childIds: ["2", "3"] },
    { nodeId: "2", ignored: false, role: { value: "heading" }, name: { value: "Native view" }, backendDOMNodeId: 11 },
    { nodeId: "3", ignored: false, role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 12 },
  ],
}

type Tab = { id: string; url: string; title: string }

// A stand-in for the Electron main process: answers the wire protocol with canned CDP results.
function fakeDesktop(initial: Tab[]) {
  const tabs = [...initial]
  const received: Outbound[] = []
  const opened = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    const send = (message: Record<string, unknown>) => ws.send(JSON.stringify(message))
    ws.addEventListener("open", () => {
      send({ type: "hello", profile: "test", userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36", tabs })
      resolve(ws)
    })
    ws.addEventListener("error", () => reject(new Error("fake desktop could not connect")))
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Outbound
      received.push(message)
      if (message.type === "tab.create") {
        const tab = { id: `t${tabs.length + 1}`, url: message.url, title: "Desk" }
        tabs.push(tab)
        send({ type: "tab.list", tabs })
        send({ type: "cdp.result", id: message.id, result: { targetId: tab.id } })
        return
      }
      if (message.type === "tab.close") {
        const index = tabs.findIndex((tab) => tab.id === message.tabID)
        if (index >= 0) tabs.splice(index, 1)
        send({ type: "tab.list", tabs })
        send({ type: "cdp.result", id: message.id, result: {} })
        return
      }
      if (message.type === "tab.activate") {
        send({ type: "cdp.result", id: message.id, result: {} })
        return
      }
      if (message.method === "Accessibility.getFullAXTree") {
        send({ type: "cdp.result", id: message.id, result: axTree })
        return
      }
      if (message.method === "Runtime.evaluate") {
        send({ type: "cdp.result", id: message.id, result: { result: { value: "complete" } } })
        return
      }
      send({ type: "cdp.result", id: message.id, result: {} })
    })
  })
  return {
    opened,
    received,
    tabs,
    emit: async (message: Record<string, unknown>) => (await opened).send(JSON.stringify(message)),
    close: async () => (await opened).close(1000),
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await sleep(20)
  }
}

const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Browser.node]), [
    [Location.node, locationLayer],
    [Global.node, tempGlobalLayer],
  ]),
)

describe("Desktop provider", () => {
  test("a connected desktop wins over the launched provider and yields on disconnect", async () => {
    expect(select(key).kind).toBe("launched")
    const desktop = fakeDesktop([])
    await desktop.opened
    await until(() => select(key).kind === "desktop")
    await desktop.close()
    await until(() => select(key).kind === "launched")
  })

  it.live("hello, tab.list, cdp roundtrip and snapshot flow through the relay", () =>
    Effect.gen(function* () {
      const desktop = fakeDesktop([{ id: "t1", url: "about:blank", title: "" }])
      yield* Effect.promise(() => desktop.opened)
      yield* Effect.promise(() => until(() => select(key).kind === "desktop"))
      const browser = yield* Browser.Service

      // The desktop's existing tab is adopted as a session tab.
      const opened = yield* browser.open({})
      expect(opened.id).toBe("t1")
      const state = yield* browser.state()
      expect(state.provider).toBe("desktop")
      expect(state.tabs.map((tab) => tab.id)).toEqual(["t1"])

      // `Target.createTarget` becomes `tab.create`; the new tab arrives through `tab.list`.
      const created = yield* browser.open({ url: "https://example.test/" })
      expect(created.id).toBe("t2")
      expect(desktop.received.find((message) => message.type === "tab.create")).toMatchObject({
        url: "https://example.test/",
      })
      expect(desktop.received.find((message) => message.type === "tab.activate")).toMatchObject({ tabID: "t2" })

      // Page-level commands travel as `cdp.send` with the tab id as session and come back as `cdp.result`.
      const snapshot = yield* browser.snapshot({ tab: "t2", mode: "full" })
      expect(snapshot.tree).toContain('heading "Native view"')
      expect(snapshot.tree).toMatch(/button "Go" \[ref=e\d+\]/)
      expect(desktop.received).toContainEqual(
        expect.objectContaining({ type: "cdp.send", tabID: "t2", method: "Accessibility.getFullAXTree" }),
      )

      // The desktop re-attaching its debugger (DevTools, crash) asks the session to enable the
      // page-level domains again, without closing and reopening the tab.
      const enabled = () =>
        desktop.received.filter(
          (message) => message.type === "cdp.send" && message.tabID === "t2" && message.method === "Network.enable",
        ).length
      expect(enabled()).toBe(1)
      yield* Effect.promise(() => desktop.emit({ type: "tab.attached", tabID: "t2" }))
      yield* Effect.promise(() => until(() => enabled() === 2))
      expect((yield* browser.state()).tabs.map((tab) => tab.id)).toEqual(["t1", "t2"])
      expect((yield* browser.state()).activeTab).toBe("t2")
      expect(desktop.received.some((message) => message.type === "cdp.send" && message.method === "Emulation.setUserAgentOverride")).toBe(false)

      // Thumbnails are pushed by the desktop, not captured through CDP.
      yield* Effect.promise(() => desktop.emit({ type: "thumbnail", tabID: "t2", version: 1, jpegBase64: "/9j/" }))
      yield* Effect.promise(() =>
        until(() => desktop.received.length > 0 && Effect.runSync(browser.state()).tabs[1]?.thumbnailVersion === 1),
      )
      const thumbnail = yield* browser.thumbnail("t2")
      expect([...thumbnail.data]).toEqual([...Buffer.from("/9j/", "base64")])
      expect(desktop.received.some((message) => message.type === "cdp.send" && message.method === "Page.captureScreenshot")).toBe(
        false,
      )

      // Closing a tab goes through `tab.close`; the desktop going away drops the session.
      yield* browser.close("t1")
      expect(desktop.tabs.map((tab) => tab.id)).toEqual(["t2"])
      yield* Effect.promise(() => desktop.close())
      yield* Effect.promise(() => until(() => Effect.runSync(browser.state()).running === false))
      expect((yield* browser.state()).tabs).toEqual([])
    }),
  )
})
