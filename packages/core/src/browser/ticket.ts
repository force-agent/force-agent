export * as BrowserTicket from "./ticket.js"

import { BrowserTicket } from "@opencode-ai/schema/browser-ticket"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Cache, Context, Duration, Effect, Layer } from "effect"
import type { Workspace } from "../workspace.js"

const DEFAULT_TTL = Duration.seconds(60)
const CAPACITY = 10_000

export const ConnectToken = BrowserTicket.ConnectToken

export type Scope = {
  readonly tabID: string
  readonly directory?: string
  readonly workspaceID?: Workspace.ID
}

export interface Interface {
  issue(input: Scope): Effect.Effect<typeof ConnectToken.Type>
  consume(input: Scope & { readonly ticket: string }): Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserTicket") {}

function matches(record: Scope, input: Scope) {
  return (
    record.tabID === input.tabID && record.directory === input.directory && record.workspaceID === input.workspaceID
  )
}

// Same shape as PtyTicket: tickets go in via Cache.set and out atomically via invalidateWhen.
const noLookup = () => Effect.die(new Error("BrowserTicket cache must be used via set/invalidateWhen, never get"))

export const make = (ttl: Duration.Input = DEFAULT_TTL) =>
  Effect.gen(function* () {
    const cache = yield* Cache.make<string, Scope>({ capacity: CAPACITY, lookup: noLookup, timeToLive: ttl })
    const expiresIn = Math.max(1, Math.round(Duration.toSeconds(Duration.fromInputUnsafe(ttl))))
    return Service.of({
      issue: Effect.fn("BrowserTicket.issue")(function* (input) {
        const ticket = crypto.randomUUID()
        yield* Cache.set(cache, ticket, input)
        return { ticket, expires_in: expiresIn }
      }),
      consume: Effect.fn("BrowserTicket.consume")(function* (input) {
        return yield* Cache.invalidateWhen(cache, input.ticket, (stored) => matches(stored, input))
      }),
    })
  })

const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })
