import { EOL } from "node:os"
import { Effect } from "effect"
import { OpenCode, type BrowserState } from "@opencode-ai/client"
import { Service } from "@opencode-ai/client/effect/service"
import { ServiceConfig } from "../../../services/service-config"

// Every browser subcommand talks to the background service for the current directory.
export const connect = Effect.fn("cli.browser.connect")(function* () {
  const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
  return {
    client: OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }),
    location: { directory: process.cwd() },
  }
})

export function print(json: boolean, value: unknown, text: () => string) {
  process.stdout.write((json ? JSON.stringify(value, null, 2) : text()) + EOL)
}

export function describeTabs(state: BrowserState) {
  const tabs = state.tabs.map((tab) => `${tab.active ? "*" : " "} ${tab.id}  ${tab.title || "(untitled)"}  ${tab.url}`)
  const head = `control: ${state.control}${state.running ? ` (${state.provider}, profile ${state.profile})` : " (not running)"}`
  return [head, ...(tabs.length === 0 ? ["no tabs"] : tabs)].join(EOL)
}

export function describePage(page: { readonly url: string; readonly title: string }) {
  return `${page.title || "(untitled)"}${EOL}${page.url}`
}
