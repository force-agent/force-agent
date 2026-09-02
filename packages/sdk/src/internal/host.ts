export * as EmbeddedHost from "./host"

import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { SessionRestart } from "@opencode-ai/core/session/execution/restart"
import { Workspace } from "@opencode-ai/core/workspace"
import { WorkspaceDriver } from "@opencode-ai/core/workspace/driver"
import { InProcess } from "@opencode-ai/server/in-process"
import { createEmbeddedRoutes } from "@opencode-ai/server/routes"
import type { ServerOptions } from "@opencode-ai/server/options"
import type { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect"
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { context, layer, type LogOptions } from "../logging"
import { OwnedFetch } from "./fetch"

export interface CreateOptions extends Omit<ServerOptions, "hostname" | "port" | "password"> {
  readonly log?: LogOptions
  readonly workspaceProviders?: Readonly<Record<string, WorkspaceDriver.Interface>>
}

/** Host hooks for embedding opencode on a non-default runtime profile. */
export interface EmbedOptions {
  readonly overrides?: LayerNode.Replacements
}

export const create = Effect.fn("EmbeddedHost.create")(function* (
  options: CreateOptions = {},
  embed: EmbedOptions = {},
) {
  const { log, workspaceProviders, ...server } = options
  // The host owns the handler outright, so it mints the credential the routes
  // are configured with and stamps it on every request itself. The embedder
  // never sees it, and there is no unauthenticated route graph to fall into.
  const grant = InProcess.grant()
  const runtime = ManagedRuntime.make(
    createEmbeddedRoutes(
      grant,
      {
        ...server,
        app: { ...server.app, name: server.app?.name ?? "sdk" },
        database: { path: ":memory:", ...server.database },
      },
      workspaceProviders
        ? [...(embed.overrides ?? []), [WorkspaceDriver.node, WorkspaceDriver.registryNode(workspaceProviders)]]
        : embed.overrides,
    ).pipe(Layer.provide(HttpServer.layerServices), Layer.provideMerge(layer(log))),
  )

  return yield* Effect.gen(function* () {
    const services = yield* runtime.contextEffect
    // The sweep is a no-op when nothing is suspended. ManagedRuntime owns the
    // fiber so recovery never delays startup but still stops with the host.
    runtime.runFork(Context.get(services, SessionRestart.Service).resumeSuspendedSessions)
    const routed = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(
      context(services),
    )(Context.get(services, HttpRouter.HttpRouter).asHttpEffect())
    const handler = (request: Request) => routed(InProcess.authorize(request, grant))
    const transport = OwnedFetch.make(handler, runtime.dispose)

    return {
      runtime,
      fetch: transport.fetch,
      plugins: Context.get(services, SdkPlugins.Service),
      workspace: Context.get(services, Workspace.Service),
      close: transport.close,
    }
  }).pipe(Effect.onError(() => runtime.disposeEffect))
})

export type Interface = Effect.Success<ReturnType<typeof create>>
