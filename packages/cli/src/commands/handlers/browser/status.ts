import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, describeTabs, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.status,
  Effect.fn("cli.browser.status")(function* (input) {
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() => client.browser.state({ location }))
    print(input.json, response.data, () => describeTabs(response.data))
  }),
)
