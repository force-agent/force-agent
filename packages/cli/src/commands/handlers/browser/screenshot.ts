import path from "node:path"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, print } from "./client"

export default Runtime.handler(
  Commands.commands.browser.commands.screenshot,
  Effect.fn("cli.browser.screenshot")(function* (input) {
    const { client, location } = yield* connect()
    const response = yield* Effect.promise(() =>
      client.browser.screenshot({ location, fullPage: input.fullPage, tab: Option.getOrUndefined(input.tab) }),
    )
    const out = path.resolve(Option.getOrElse(input.out, () => "screenshot.jpg"))
    yield* Effect.promise(() => Bun.write(out, Buffer.from(response.data.base64, "base64")))
    print(input.json, { path: out, url: response.data.url, tab: response.data.tab }, () => `Saved ${out}`)
  }),
)
