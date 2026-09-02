import type { CdpClient } from "./cdp/client.js"

export const MIME = "image/jpeg"

export async function screenshot(
  client: CdpClient,
  sessionId: string,
  input: { readonly backendNodeId?: number; readonly fullPage?: boolean },
) {
  const clip = await (async () => {
    if (input.backendNodeId !== undefined) {
      const box = await client.send<{ model: { content: number[]; width: number; height: number } }>(
        "DOM.getBoxModel",
        { backendNodeId: input.backendNodeId },
        sessionId,
      )
      const quad = box.model.content
      return { x: quad[0], y: quad[1], width: box.model.width, height: box.model.height, scale: 1 }
    }
    if (!input.fullPage) return undefined
    const metrics = await client.send<{ cssContentSize: { width: number; height: number } }>(
      "Page.getLayoutMetrics",
      {},
      sessionId,
    )
    return { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 }
  })()
  const result = await client.send<{ data: string }>(
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: 70,
      ...(clip === undefined ? {} : { clip }),
      ...(input.fullPage ? { captureBeyondViewport: true } : {}),
    },
    sessionId,
  )
  return { mime: MIME, base64: result.data }
}
