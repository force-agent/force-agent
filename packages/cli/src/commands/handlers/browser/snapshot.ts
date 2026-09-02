import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, describePage, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.snapshot,
  Effect.fn("cli.browser.snapshot")(function* (input) {
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() =>
      client.browser.snapshot({ location, mode: input.mode, tab: Option.getOrUndefined(input.tab) }),
    )
    print(input.json, response.data, () => {
      const note = response.data.truncated ? `${EOL}(truncated at ${response.data.nodes} nodes)` : ""
      return describePage(response.data) + EOL + EOL + response.data.tree + note
    })
  }),
)
