import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, describePage, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.navigate,
  Effect.fn("cli.browser.navigate")(function* (input) {
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() =>
      client.browser.navigate({ location, url: input.url, tab: Option.getOrUndefined(input.tab) }),
    )
    print(input.json, response.data, () => describePage(response.data) + EOL + EOL + response.data.tree)
  }),
)
