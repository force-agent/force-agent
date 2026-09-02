import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, describeTabs, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.tabs,
  Effect.fn("cli.browser.tabs")(function* (input) {
    const op = Option.getOrElse(input.op, () => "list")
    if (!["list", "open", "close", "activate"].includes(op)) yield* Effect.fail(new Error(`Unknown op: ${op}`))
    const tab = Option.getOrUndefined(input.tab)
    if ((op === "close" || op === "activate") && tab === undefined)
      yield* Effect.fail(new Error(`${op} needs --tab <id>`))
    const { client, location } = yield* connect()
    if (op === "open")
      yield* Effect.promise(() => client.browser.tab.open({ location, url: Option.getOrUndefined(input.url) }))
    if (op === "close" && tab !== undefined)
      yield* Effect.promise(() => client.browser.tab.close({ location, tabID: tab }))
    if (op === "activate" && tab !== undefined)
      yield* Effect.promise(() => client.browser.tab.activate({ location, tabID: tab }))
    const response = yield* Effect.promise(() => client.browser.state({ location }))
    print(input.json, response.data, () => describeTabs(response.data))
  }),
)
