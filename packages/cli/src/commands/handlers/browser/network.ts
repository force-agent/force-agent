import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.network,
  Effect.fn("cli.browser.network")(function* (input) {
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() =>
      client.browser.network({
        location,
        host: Option.getOrUndefined(input.host),
        path: Option.getOrUndefined(input.path),
        xhr: input.xhr || undefined,
        since: Option.getOrUndefined(input.since),
        limit: Option.getOrUndefined(input.limit),
        body: Option.getOrUndefined(input.body),
        tab: Option.getOrUndefined(input.tab),
      }),
    )
    print(input.json, response.data, () => {
      const data = response.data
      const lines = data.entries.map(
        (entry) =>
          `${entry.id}  ${entry.method} ${entry.url}  ${entry.error ? `ERR ${entry.error}` : (entry.status ?? "…")}  ${entry.type}${entry.fromCache ? " (cache)" : ""}`,
      )
      const head = `${data.entries.length} of ${data.total} matching requests`
      const body = data.body
        ? `${EOL}${EOL}Body of ${data.body.id}${data.body.base64 ? " (base64)" : ""}${data.body.truncated ? " (truncated)" : ""}:${EOL}${data.body.body}`
        : ""
      return [head, ...lines].join(EOL) + body
    })
  }),
)
