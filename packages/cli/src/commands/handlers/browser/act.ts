import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, describePage, print } from "./client"

const ACTIONS = ["click", "type", "press", "select", "scroll", "hover", "upload"] as const

export default Runtime.handler(
  Commands.commands.browser.commands.act,
  Effect.fn("cli.browser.act")(function* (input) {
    const action =
      ACTIONS.find((item) => item === input.action) ??
      (yield* Effect.fail(new Error(`Unknown action: ${input.action}`)))
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() =>
      client.browser.act({
        location,
        action,
        ref: Option.getOrUndefined(input.ref),
        text: Option.getOrUndefined(input.text),
        key: Option.getOrUndefined(input.key),
        value: Option.getOrUndefined(input.value),
        files: input.file.length === 0 ? undefined : [...input.file],
        tab: Option.getOrUndefined(input.tab),
      }),
    )
    print(input.json, response.data, () => describePage(response.data) + EOL + EOL + response.data.diff)
  }),
)
