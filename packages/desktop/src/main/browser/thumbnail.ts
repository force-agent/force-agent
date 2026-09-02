import type { ViewHost } from "./view-host"

export const WIDTH = 320
export const INTERVAL_MS = 3_000
const QUALITY = 50

// `capturePage` of the visible active tab every INTERVAL_MS, sent to the server as `thumbnail`.
// Hidden views render nothing, so nothing is captured while the panel is off screen.
export function startThumbnails(
  host: ViewHost,
  send: (tabID: string, version: number, jpegBase64: string) => void,
): () => void {
  const versions = new Map<string, number>()
  let busy = false
  const tick = async () => {
    if (busy || !host.visible) return
    const view = host.active
    if (!view || view.webContents.isDestroyed()) return
    const tabID = String(view.webContents.id)
    busy = true
    const image = await view.webContents.capturePage().catch(() => undefined)
    busy = false
    if (!image || image.isEmpty()) return
    const version = (versions.get(tabID) ?? 0) + 1
    versions.set(tabID, version)
    send(tabID, version, image.resize({ width: WIDTH }).toJPEG(QUALITY).toString("base64"))
  }
  const timer = setInterval(() => void tick(), INTERVAL_MS)
  void tick()
  return () => clearInterval(timer)
}
