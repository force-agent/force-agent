import type { BrowserViewBounds } from "../../shared/ipc-contract"

// The renderer measures the panel in CSS pixels of its own viewport; `WebContentsView.setBounds`
// wants device-independent pixels of the window's content view, which the renderer's zoom factor
// scales. Rounded outward-safe: floor the origin, ceil the size, so no seam shows at the edges.
// The origin never goes negative: a panel scrolled past the window edge is clipped, not moved.
export function viewBounds(rect: BrowserViewBounds, zoomFactor: number): BrowserViewBounds {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const x = Math.max(0, Math.floor(rect.x * zoom))
  const y = Math.max(0, Math.floor(rect.y * zoom))
  return {
    x,
    y,
    width: Math.max(0, Math.ceil((rect.x + rect.width) * zoom) - x),
    height: Math.max(0, Math.ceil((rect.y + rect.height) * zoom) - y),
  }
}
