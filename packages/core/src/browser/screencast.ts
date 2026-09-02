import type { Browser } from "@opencode-ai/schema/browser"
import type { CdpClient, CdpEvent } from "./cdp/client.js"

// `Page.startScreencast` parameters. 1280x800 matches the launched window, so frames are the
// viewport at 1:1 unless the panel asked for a bigger viewport through a resize input.
export const OPTIONS = { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }

export type Frame = {
  readonly tabID: string
  readonly data: Uint8Array
  readonly metadata: Omit<Browser.FrameHeader, "tab">
}

export type Subscriber = (frame: Frame) => void

type Entry = {
  readonly sessionId: string
  readonly subscribers: Set<Subscriber>
  latest?: Uint8Array
}

// Screencast per tab, refcounted by subscriber: `Page.startScreencast` on the first subscriber,
// `Page.stopScreencast` when the last one leaves, and one `Page.screencastFrameAck` per frame
// (Chromium withholds the next frame until the previous one is acknowledged).
export class Screencasts {
  private readonly entries = new Map<string, Entry>()
  private readonly off: () => void

  constructor(private readonly client: CdpClient) {
    this.off = client.on("Page.screencastFrame", (event) => this.frame(event))
  }

  active(tabID: string) {
    return this.entries.has(tabID)
  }

  // Most recent frame of a streaming tab; thumbnails reuse it instead of taking a screenshot.
  latest(tabID: string) {
    return this.entries.get(tabID)?.latest
  }

  any() {
    return this.entries.size > 0
  }

  subscribe(tabID: string, sessionId: string, subscriber: Subscriber): () => void {
    const entry = this.entries.get(tabID) ?? { sessionId, subscribers: new Set<Subscriber>() }
    const first = entry.subscribers.size === 0
    entry.subscribers.add(subscriber)
    this.entries.set(tabID, entry)
    if (first) this.client.send("Page.startScreencast", OPTIONS, sessionId).catch(() => undefined)
    return () => {
      if (!entry.subscribers.delete(subscriber) || entry.subscribers.size > 0) return
      if (this.entries.get(tabID) === entry) this.entries.delete(tabID)
      this.client.send("Page.stopScreencast", {}, sessionId).catch(() => undefined)
    }
  }

  // A closed tab needs no stop call; its session is gone with it.
  drop(tabID: string) {
    this.entries.delete(tabID)
  }

  close() {
    this.off()
    this.entries.clear()
  }

  private frame(event: CdpEvent) {
    const params = event.params as { data: string; metadata: Frame["metadata"]; sessionId: number }
    if (event.sessionId !== undefined)
      this.client
        .send("Page.screencastFrameAck", { sessionId: params.sessionId }, event.sessionId)
        .catch(() => undefined)
    const found = [...this.entries].find(([, entry]) => entry.sessionId === event.sessionId)
    if (!found) return
    const frame: Frame = { tabID: found[0], data: Buffer.from(params.data, "base64"), metadata: params.metadata }
    found[1].latest = frame.data
    for (const subscriber of found[1].subscribers) subscriber(frame)
  }
}
