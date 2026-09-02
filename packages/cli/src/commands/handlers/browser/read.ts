import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.read,
  Effect.fn("cli.browser.read")(function* (input) {
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() =>
      client.browser.read({
        location,
        selector: Option.getOrUndefined(input.selector),
        page: Option.getOrUndefined(input.page),
        tab: Option.getOrUndefined(input.tab),
      }),
    )
    print(input.json, response.data, () => {
      const pages = response.data.pages > 1 ? `${EOL}${EOL}(page ${response.data.page} of ${response.data.pages})` : ""
      return response.data.markdown + pages
    })
  }),
)
