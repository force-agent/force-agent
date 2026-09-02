import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.eval,
  Effect.fn("cli.browser.eval")(function* (input) {
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() =>
      client.browser.eval({ location, expression: input.expression, tab: Option.getOrUndefined(input.tab) }),
    )
    print(
      input.json,
      response.data,
      () => response.data.json + (response.data.truncated ? `${EOL}${EOL}(result truncated at 256 KB)` : ""),
    )
  }),
)
