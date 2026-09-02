import { describe, expect, test } from "bun:test"
import { BODY_LIMIT, CAPACITY, decodeBody, Network } from "@opencode-ai/core/browser/network"
import { fakeCdp } from "./fake-cdp"

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function request(
  cdp: ReturnType<typeof fakeCdp>,
  id: string,
  url: string,
  options: { method?: string; type?: string; wallTime?: number; headers?: Record<string, string> } = {},
) {
  cdp.emit(
    "Network.requestWillBeSent",
    {
      requestId: id,
      request: { url, method: options.method ?? "GET", headers: options.headers ?? { accept: "*/*" } },
      type: options.type ?? "Document",
      wallTime: options.wallTime ?? 1_700_000_000 + Number(id.replace(/\D/g, "") || 0),
    },
    "s1",
  )
}

function response(
  cdp: ReturnType<typeof fakeCdp>,
  id: string,
  status: number,
  mimeType: string,
  headers: Record<string, string> = {},
) {
  cdp.emit("Network.responseReceived", { requestId: id, response: { status, mimeType, headers } }, "s1")
}

describe("Network (fake CDP)", () => {
  test("enables per tab and records request, response and failure", async () => {
    const cdp = fakeCdp()
    const network = new Network(cdp.client)
    await network.enable("tab1", "s1")
    expect(cdp.sent.map((item) => item.method)).toEqual(["Network.enable"])
    expect(cdp.sent[0].sessionId).toBe("s1")

    request(cdp, "r1", "https://app.example.com/", { type: "Document" })
    response(cdp, "r1", 200, "text/html", { "content-type": "text/html", "set-cookie": "session=abc" })
    request(cdp, "r2", "https://api.example.com/v1/me", { type: "XHR", headers: { cookie: "session=abc" } })
    response(cdp, "r2", 401, "application/json")
    request(cdp, "r3", "https://cdn.example.com/app.js", { type: "Script" })
    cdp.emit("Network.loadingFailed", { requestId: "r3", errorText: "net::ERR_FAILED" }, "s1")
    // Another session's traffic never lands in this tab.
    cdp.emit(
      "Network.requestWillBeSent",
      { requestId: "x1", request: { url: "https://other/", method: "GET", headers: {} }, type: "Document" },
      "s2",
    )

    const listed = network.list("tab1", {})
    expect(listed.total).toBe(3)
    expect(listed.entries.map((entry) => entry.id)).toEqual(["r3", "r2", "r1"])
    const me = listed.entries[1]
    expect(me).toMatchObject({ method: "GET", url: "https://api.example.com/v1/me", status: 401, type: "xhr" })
    expect(me.requestHeaders.cookie).toBe("<redacted>")
    expect(listed.entries[2].responseHeaders?.["set-cookie"]).toBe("<redacted>")
    expect(listed.entries[2].responseHeaders?.["content-type"]).toBe("text/html")
    expect(listed.entries[0].error).toBe("net::ERR_FAILED")
    expect(listed.entries[0].status).toBeUndefined()
  })

  test("marks requests made while a person holds the browser and keeps their bodies private", async () => {
    let agent = false
    const cdp = fakeCdp((method) =>
      method === "Network.getResponseBody" ? { body: '{"token":"s3cret"}', base64Encoded: false } : undefined,
    )
    const network = new Network(cdp.client, () => agent)
    await network.enable("tab1", "s1")
    request(cdp, "r1", "https://app.example.com/login", { method: "POST", type: "Fetch", headers: { cookie: "a=b" } })
    response(cdp, "r1", 200, "application/json", { "set-cookie": "session=abc" })
    agent = true
    request(cdp, "r2", "https://app.example.com/api/me", { type: "Fetch" })
    response(cdp, "r2", 200, "application/json")

    const listed = network.list("tab1", {})
    expect(listed.entries.map((entry) => [entry.id, entry.captured])).toEqual([
      ["r2", "agent"],
      ["r1", "human"],
    ])
    // Listed, headers still redacted, but the body of the person's request never comes back.
    expect(listed.entries[1].requestHeaders.cookie).toBe("<redacted>")
    expect(listed.entries[1].responseHeaders?.["set-cookie"]).toBe("<redacted>")
    await expect(network.body("tab1", "r1")).rejects.toThrow(/captured while a person was using the browser/)
    expect(cdp.sent.some((item) => item.method === "Network.getResponseBody")).toBe(false)
    expect((await network.body("tab1", "r2")).body).toBe('{"token":"s3cret"}')
  })

  test("enabling again for the same session keeps the log", async () => {
    const cdp = fakeCdp()
    const network = new Network(cdp.client)
    await network.enable("tab1", "s1")
    request(cdp, "r1", "https://app.example.com/")
    await network.enable("tab1", "s1")
    expect(network.list("tab1", {}).entries.map((entry) => entry.id)).toEqual(["r1"])
    expect(cdp.sent.filter((item) => item.method === "Network.enable")).toHaveLength(2)
  })

  test("filters by host, path, xhr, since and limit", async () => {
    const cdp = fakeCdp()
    const network = new Network(cdp.client)
    await network.enable("tab1", "s1")
    request(cdp, "r1", "https://app.example.com/", { type: "Document", wallTime: 100 })
    request(cdp, "r2", "https://api.example.com/v1/me", { type: "XHR", wallTime: 200 })
    request(cdp, "r3", "https://api.example.com/v1/items", { type: "Fetch", wallTime: 300 })
    request(cdp, "r4", "https://cdn.example.com/app.js", { type: "Script", wallTime: 400 })

    expect(network.list("tab1", { xhr: true }).entries.map((entry) => entry.id)).toEqual(["r3", "r2"])
    expect(network.list("tab1", { host: "API.example" }).entries.map((entry) => entry.id)).toEqual(["r3", "r2"])
    expect(network.list("tab1", { path: "/v1/me" }).entries.map((entry) => entry.id)).toEqual(["r2"])
    expect(network.list("tab1", { since: 300_000 }).entries.map((entry) => entry.id)).toEqual(["r4", "r3"])
    const limited = network.list("tab1", { limit: 1 })
    expect(limited.entries.map((entry) => entry.id)).toEqual(["r4"])
    expect(limited.total).toBe(4)
    expect(network.list("nope", {}).entries).toEqual([])
  })

  test("keeps the newest CAPACITY entries", async () => {
    const cdp = fakeCdp()
    const network = new Network(cdp.client)
    await network.enable("tab1", "s1")
    for (let index = 0; index < CAPACITY + 25; index++)
      request(cdp, `r${index}`, `https://example.com/${index}`, { wallTime: index })
    const listed = network.list("tab1", { limit: CAPACITY + 100 })
    expect(listed.total).toBe(CAPACITY)
    expect(listed.entries[0].id).toBe(`r${CAPACITY + 24}`)
    expect(listed.entries.at(-1)?.id).toBe("r25")
    // Evicted ids no longer resolve for bodies.
    await expect(network.body("tab1", "r0")).rejects.toThrow(/No captured request/)
  })

  test("fetches bodies on demand, decoding textual base64 and truncating at the limit", async () => {
    const big = "y".repeat(BODY_LIMIT + 10)
    const cdp = fakeCdp((method, params) => {
      if (method !== "Network.getResponseBody") return
      if (params.requestId === "json")
        return { body: Buffer.from('{"user":"alice"}').toString("base64"), base64Encoded: true }
      if (params.requestId === "png") return { body: "iVBORw0KGgo=", base64Encoded: true }
      if (params.requestId === "big") return { body: big, base64Encoded: false }
      return
    })
    const network = new Network(cdp.client)
    await network.enable("tab1", "s1")
    request(cdp, "json", "https://api.example.com/me", { type: "XHR" })
    response(cdp, "json", 200, "application/json")
    request(cdp, "png", "https://cdn.example.com/a.png", { type: "Image" })
    response(cdp, "png", 200, "image/png")
    request(cdp, "big", "https://api.example.com/dump", { type: "Fetch" })
    response(cdp, "big", 200, "text/plain")

    expect(await network.body("tab1", "json")).toEqual({
      id: "json",
      body: '{"user":"alice"}',
      base64: false,
      truncated: false,
    })
    expect(await network.body("tab1", "png")).toEqual({ id: "png", body: "iVBORw0KGgo=", base64: true, truncated: false })
    const truncated = await network.body("tab1", "big")
    expect(truncated.truncated).toBe(true)
    expect(truncated.body).toHaveLength(BODY_LIMIT)
    const sent = cdp.sent.filter((item) => item.method === "Network.getResponseBody")
    expect(sent).toHaveLength(3)
    expect(sent[0]).toMatchObject({ params: { requestId: "json" }, sessionId: "s1" })
    await flush()
  })

  test("decodeBody treats +json and text/* as textual", () => {
    const raw = Buffer.from("<a/>").toString("base64")
    expect(decodeBody("a", raw, true, "application/ld+json; charset=utf-8").body).toBe("<a/>")
    expect(decodeBody("a", raw, true, "text/csv").body).toBe("<a/>")
    expect(decodeBody("a", raw, true, "application/octet-stream")).toMatchObject({ body: raw, base64: true })
    expect(decodeBody("a", "plain", false, undefined)).toMatchObject({ body: "plain", base64: false })
  })

  test("drop and close forget tabs", async () => {
    const cdp = fakeCdp()
    const network = new Network(cdp.client)
    await network.enable("tab1", "s1")
    request(cdp, "r1", "https://example.com/")
    network.drop("tab1")
    expect(network.list("tab1", {}).total).toBe(0)
    await network.enable("tab1", "s1")
    request(cdp, "r1", "https://example.com/")
    expect(network.list("tab1", {}).total).toBe(1)
    network.close()
    request(cdp, "r2", "https://example.com/")
    expect(network.list("tab1", {}).total).toBe(0)
  })
})
