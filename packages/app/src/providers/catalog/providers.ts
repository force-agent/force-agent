import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { normalizeProviderList } from "@/runtime/server/global-sync/utils"
import { Iterable, pipe } from "effect"
import { createEffect, createMemo, type Accessor } from "solid-js"
import type { ProviderListResponse } from "@/runtime/server/types"
import { same } from "@/runtime/persistence/equality"
import { useIntegrations } from "./integrations"
import { popularProviders } from "./order"

export { popularProviders } from "./order"
const emptyProviderCatalog: ProviderListResponse = { all: new Map(), connected: [], default: {} }
const popularProviderSet = new Set(popularProviders)

export function useProviders(directory: Accessor<string | undefined>) {
  const data = useData()
  const sdk = useServerSDK()
  const location = () => {
    const dir = directory()
    return dir ? { directory: dir } : undefined
  }

  createEffect(() => {
    if (sdk.connection.status() !== "connected") return
    const ref = location()
    void (async () => {
      if (!ref) await data.location.syncInfo()
      const resolved = ref ?? data.location.default()
      await Promise.all([data.location.provider.sync(resolved), data.location.model.sync(resolved)])
    })().catch(() => undefined)
  })
  const integrations = useIntegrations(directory)

  const providers = createMemo(() => {
    const ref = location()
    const provider = data.location.provider.list(ref)
    const model = data.location.model.list(ref)
    if (!provider || !model) return emptyProviderCatalog
    return normalizeProviderList(provider, model)
  })

  // Stable per-directory memos: Solid's default `===` keeps downstream
  // computations from re-running when the WeakMap cache returns the same
  // catalog, and `same` avoids array churn for derived lists.
  const all = createMemo(() => providers().all)
  const defaultProviders = createMemo(() => providers().default)
  const popular = createMemo(
    () => {
      const catalog = integrations
        .list()
        .filter((integration) => popularProviderSet.has(integration.id))
        .map((integration) => ({ id: integration.id, name: integration.name }))
      const seen = new Set(catalog.map((integration) => integration.id))
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id) && !seen.has(p.id)),
        Iterable.map((p) => ({ id: p.id, name: p.name })),
        (v) => [...catalog, ...v],
      )
    },
    undefined,
    { equals: same },
  )
  const connected = createMemo(
    () => {
      const ids = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => ids.has(p.id)),
        (v) => Array.from(v),
      )
    },
    undefined,
    { equals: same },
  )
  const paid = createMemo(
    () => {
      const connectedIds = new Set(providers().connected)
      return [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connectedIds.has(id) &&
            (id !== "opencode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
    },
    undefined,
    { equals: same },
  )

  return {
    ready: () => {
      const ref = location()
      return data.location.provider.list(ref) !== undefined && data.location.model.list(ref) !== undefined
    },
    all,
    default: defaultProviders,
    // V2 servers list only available providers, so the connectable catalog
    // comes from the integration list, with the provider catalog as fallback.
    popular,
    connected,
    paid,
  }
}
