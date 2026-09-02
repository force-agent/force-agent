import { BindPolicy } from "@opencode-ai/server/bind-policy"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Env } from "../../env"
import { ServerProcess } from "../../server-process"

export default Runtime.handler(
  Commands.commands.web,
  Effect.fnUntraced(function* (input) {
    const hostname = Option.getOrUndefined(input.hostname)
    // Same early refusal as `serve`: fail at the flag the operator typed rather than after a
    // boot. ServerProcess runs the authoritative check once hostname and credential are both
    // settled — this one cannot see the service config, so it is a courtesy, not the gate.
    if (hostname !== undefined) {
      const configured = yield* Env.configuredPassword
      yield* BindPolicy.assert({ hostname, credential: BindPolicy.classify(configured) })
    }
    return yield* ServerProcess.run({
      mode: "default",
      hostname,
      port: Option.getOrUndefined(input.port),
      announce: "web",
      showCredentials: input.showCredentials,
    })
  }),
)
