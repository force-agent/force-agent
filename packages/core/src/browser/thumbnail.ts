import type { CdpClient } from "./cdp/client.js"

export const WIDTH = 320
export const INTERVAL_MS = 3_000

export type Thumbnail = {
  readonly version: number
  readonly data: Uint8Array
  readonly at: number
}

// Small versioned jpeg per tab. `touch` captures at most once every INTERVAL_MS, so calling it
// after every agent action costs one screenshot per 3 s while the agent is active and nothing
// while it is not. Returns the new version when a capture happened.
export class Thumbnails {
  private readonly cache = new Map<string, Thumbnail>()

  get(tab: string) {
    return this.cache.get(tab)
  }

  drop(tab: string) {
    this.cache.delete(tab)
  }

  // Store a thumbnail the provider captured itself (desktop `capturePage`). Returns the version.
  set(tab: string, data: Uint8Array): number {
    const version = (this.cache.get(tab)?.version ?? 0) + 1
    this.cache.set(tab, { version, data, at: Date.now() })
    return version
  }

  // `frame` is the latest screencast frame when one is streaming: `Page.captureScreenshot` with a
  // scaled clip re-emulates device metrics for the capture, which leaks into screencast frames as
  // bogus 320px `deviceWidth` metadata and breaks the panel's input mapping.
  async touch(client: CdpClient, sessionId: string, tab: string, frame?: Uint8Array): Promise<number | undefined> {
    const current = this.cache.get(tab)
    if (current && Date.now() - current.at < INTERVAL_MS) return undefined
    const data = frame ?? (await capture(client, sessionId).catch(() => undefined))
    if (data === undefined) return undefined
    const version = (current?.version ?? 0) + 1
    this.cache.set(tab, { version, data, at: Date.now() })
    return version
  }
}

async function capture(client: CdpClient, sessionId: string) {
  const metrics = await client.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(
    "Page.getLayoutMetrics",
    {},
    sessionId,
  )
  const width = Math.max(1, metrics.cssVisualViewport.clientWidth)
  const result = await client.send<{ data: string }>(
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: 50,
      clip: { x: 0, y: 0, width, height: metrics.cssVisualViewport.clientHeight, scale: WIDTH / width },
    },
    sessionId,
  )
  return new Uint8Array(Buffer.from(result.data, "base64"))
}
