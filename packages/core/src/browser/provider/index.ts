import type { Browser } from "@opencode-ai/schema/browser"
import type { CdpClient } from "../cdp/client.js"
import { launched } from "./launched.js"

export type ConnectOptions = {
  readonly profileDir: string
  readonly headed: boolean
}

export type CdpConnection = {
  readonly client: CdpClient
  readonly close: () => Promise<void>
  // Set when the provider pushes thumbnails itself (the desktop's `capturePage`); the session
  // then skips `Page.captureScreenshot` for them.
  readonly thumbnails?: (listener: (tabID: string, data: Uint8Array) => void) => () => void
}

export interface CdpProvider {
  readonly kind: Browser.Provider
  readonly connect: (options: ConnectOptions) => Promise<CdpConnection>
}

export type LocationRef = { readonly directory: string; readonly workspaceID?: string | undefined }

// Desktop providers are registered per location key: the Electron window that shows a project
// owns that project's browser. Anything else launches its own Chromium.
const desktops = new Map<string, CdpProvider>()
const listeners = new Map<string, Set<() => void>>()

export function locationKey(location: LocationRef) {
  return `${location.directory}\0${location.workspaceID ?? ""}`
}

export function registerDesktop(key: string, provider: CdpProvider): () => void {
  desktops.set(key, provider)
  notify(key)
  return () => {
    if (desktops.get(key) !== provider) return
    desktops.delete(key)
    notify(key)
  }
}

export function select(key: string): CdpProvider {
  return desktops.get(key) ?? launched
}

// Fires when the provider for `key` changes (desktop connected or disconnected).
export function onProviderChange(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener()
}
