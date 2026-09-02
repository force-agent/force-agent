import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.fetch,
  Effect.fn("cli.browser.fetch")(function* (input) {
    const headers: Record<string, string> = {}
    for (const raw of input.header) {
      const at = raw.indexOf(":")
      if (at === -1) return yield* Effect.fail(new Error(`Header must be 'Name: value', got ${raw}`))
      headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim()
    }
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() =>
      client.browser.fetch({
        location,
        url: input.url,
        method: Option.getOrUndefined(input.method),
        headers: input.header.length > 0 ? headers : undefined,
        body: Option.getOrUndefined(input.body),
        tab: Option.getOrUndefined(input.tab),
      }),
    )
    print(input.json, response.data, () => {
      const data = response.data
      if (data.error) return `${input.url} failed: ${data.error}`
      const head = `${data.status} ${data.statusText}  ${data.url}`
      const headers = Object.entries(data.headers).map(([key, value]) => `${key}: ${value}`)
      const tail = data.truncated ? `${EOL}${EOL}(body truncated at 512 KB)` : ""
      return [head, ...headers, "", data.body].join(EOL) + tail
    })
  }),
)
