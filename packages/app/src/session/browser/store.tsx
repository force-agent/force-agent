import type {
  BrowserControl,
  BrowserControlInput,
  BrowserHandoff,
  BrowserState,
  BrowserTab,
} from "@opencode-ai/client/promise"
import { createRoot, createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useServerSDK, type ServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"

export type Thumbnail = { readonly version: number; readonly url: string }

export type BrowserStore = {
  readonly state: () => BrowserState | undefined
  readonly error: () => string | undefined
  readonly tabs: () => readonly BrowserTab[]
  readonly active: () => BrowserTab | undefined
  readonly control: () => BrowserControl
  readonly handoff: () => BrowserHandoff | undefined
  readonly thumbnail: (tabID: string) => Thumbnail | undefined
  readonly refresh: () => Promise<void>
  readonly open: (url?: string) => Promise<void>
  readonly close: (tabID: string) => Promise<void>
  readonly activate: (tabID: string) => Promise<void>
  readonly navigate: (url: string, tabID?: string) => Promise<void>
  readonly back: (tabID: string) => Promise<void>
  readonly reload: (tabID: string) => Promise<void>
  readonly setControl: (owner: BrowserControlInput["owner"]) => Promise<void>
}

export const controlLabelKey = {
  idle: "session.browser.control.idle",
  agent: "session.browser.control.agent",
  human: "session.browser.control.human",
  "handoff-login": "session.browser.control.handoff-login",
} as const

type Entry = { readonly store: BrowserStore; readonly dispose: () => void; refs: number }

// One store per server + directory, shared by the sidebar preview and the Browser panel so the
// SSE subscription and thumbnail fetches happen once.
const cache = new Map<string, Entry>()

export function useBrowserStore(): BrowserStore {
  const sdk = useServerSDK()
  const directory = useWorkspaceLocation()().directory
  const key = `${sdk.url}|${directory}`
  const entry = cache.get(key) ?? create(key, sdk, directory)
  entry.refs += 1
  onCleanup(() => {
    entry.refs -= 1
    if (entry.refs > 0) return
    cache.delete(key)
    entry.dispose()
  })
  return entry.store
}

function create(key: string, sdk: ServerSDK, directory: string): Entry {
  const entry = createRoot((dispose) => {
    const location = { directory }
    const [state, setState] = createSignal<BrowserState | undefined>(undefined)
    const [error, setError] = createSignal<string | undefined>(undefined)
    const [thumbnails, setThumbnails] = createStore<Record<string, Thumbnail | undefined>>({})
    const versions = new Map<string, number>()

    const mine = (event: { location?: { directory?: string } }) =>
      event.location?.directory === undefined || event.location.directory === directory

    const message = (cause: unknown) =>
      cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
        ? cause.message
        : String(cause)

    const call = async (work: () => Promise<unknown>) => {
      try {
        await work()
        setError(undefined)
      } catch (cause) {
        setError(message(cause))
      }
    }

    const refresh = () =>
      call(async () => {
        const result = await sdk.api.browser.state({ location })
        setState(result.data)
      })

    // Thumbnails are fetched through the authenticated API and kept as object URLs, the same
    // way local images are read, so `<img>` never needs credentials in its src.
    const fetchThumbnail = async (tabID: string, version: number) => {
      if ((versions.get(tabID) ?? 0) >= version) return
      versions.set(tabID, version)
      const bytes = await sdk.api.browser.thumbnail({ tabID, location }).catch(() => undefined)
      if (!bytes || versions.get(tabID) !== version) return
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }))
      // Read the old URL before writing: store setters merge into the existing object.
      const previous = thumbnails[tabID]?.url
      setThumbnails(tabID, { version, url })
      if (previous) URL.revokeObjectURL(previous)
    }

    const unsubscribe = [
      sdk.event.on("browser.state", (event) => {
        if (!mine(event)) return
        setState(event.data.state)
        for (const tab of event.data.state.tabs)
          if (tab.thumbnailVersion > 0) void fetchThumbnail(tab.id, tab.thumbnailVersion)
      }),
      sdk.event.on("browser.tab.url", (event) => {
        if (!mine(event)) return
        setState(
          (current) =>
            current && {
              ...current,
              tabs: current.tabs.map((tab) =>
                tab.id === event.data.tab ? { ...tab, url: event.data.url, title: event.data.title } : tab,
              ),
            },
        )
      }),
      sdk.event.on("browser.tab.changed", (event) => {
        if (!mine(event) || event.data.op !== "closed") return
        const previous = thumbnails[event.data.tab.id]
        versions.delete(event.data.tab.id)
        setThumbnails(produce((draft) => delete draft[event.data.tab.id]))
        if (previous) URL.revokeObjectURL(previous.url)
      }),
      sdk.event.on("browser.thumbnail", (event) => {
        if (mine(event)) void fetchThumbnail(event.data.tab, event.data.version)
      }),
      sdk.event.on("browser.handoff.requested", (event) => {
        if (mine(event)) void refresh()
      }),
    ]

    onCleanup(() => {
      for (const stop of unsubscribe) stop()
      for (const thumbnail of Object.values(thumbnails)) if (thumbnail) URL.revokeObjectURL(thumbnail.url)
    })

    void refresh()

    const store: BrowserStore = {
      state,
      error,
      tabs: () => state()?.tabs ?? [],
      active: () => {
        const current = state()
        return current?.tabs.find((tab) => tab.id === current.activeTab) ?? current?.tabs[0]
      },
      control: () => state()?.control ?? "idle",
      handoff: () => state()?.handoff,
      thumbnail: (tabID) => thumbnails[tabID],
      refresh,
      // Reads the state inline instead of calling `refresh`: a nested `call` would clear the
      // error the outer one just recorded, and the open button would go silent again.
      open: (url) =>
        call(async () => {
          await sdk.api.browser.tab.open({ location, url })
          const result = await sdk.api.browser.state({ location })
          setState(result.data)
        }),
      close: (tabID) => call(() => sdk.api.browser.tab.close({ tabID, location })),
      activate: (tabID) => call(() => sdk.api.browser.tab.activate({ tabID, location })),
      // Navigation is an agent-style action on the server; a person holding the browser hands it
      // back first, and their next click on the canvas takes it again.
      navigate: (url, tabID) =>
        call(async () => {
          if (state()?.control === "human") await sdk.api.browser.control({ location, owner: "release" })
          await sdk.api.browser.navigate({ location, url, tab: tabID })
        }),
      back: (tabID) => call(() => sdk.api.browser.tab.back({ tabID, location })),
      reload: (tabID) => call(() => sdk.api.browser.tab.reload({ tabID, location })),
      setControl: (owner) =>
        call(async () => {
          const result = await sdk.api.browser.control({ location, owner })
          setState(result.data)
        }),
    }
    return { store, dispose, refs: 0 }
  })
  cache.set(key, entry)
  return entry
}
