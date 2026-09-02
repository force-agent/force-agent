import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, describeTabs, print } from "./client"

const OWNERS = ["human", "agent", "release"] as const

export default Runtime.handler(
  Commands.commands.browser.commands.control,
  Effect.fn("cli.browser.control")(function* (input) {
    const owner =
      OWNERS.find((item) => item === input.owner) ??
      (yield* Effect.fail(new Error(`Owner must be one of: ${OWNERS.join(", ")}`)))
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() => client.browser.control({ location, owner }))
    print(input.json, response.data, () => describeTabs(response.data))
  }),
)
