import { BindPolicy } from "@opencode-ai/server/bind-policy"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Env } from "../../env"
import { ServerProcess } from "../../server-process"

export default Runtime.handler(
  Commands.commands.serve,
  Effect.fnUntraced(function* (input) {
    if (input.service && input.stdio) return yield* Effect.fail(new Error("--service and --stdio cannot be combined"))
    const hostname = Option.getOrUndefined(input.hostname)
    // Refuse an explicitly requested reachable bind before anything starts. The
    // authoritative check runs again in ServerProcess once the service config
    // has had its say about hostname and password; this one exists so the
    // common case fails at the flag the operator typed.
    if (hostname !== undefined) {
      const configured = yield* Env.configuredPassword
      yield* BindPolicy.assert({ hostname, credential: BindPolicy.classify(configured) })
    }
    return yield* ServerProcess.run({
      mode: input.service ? "service" : input.stdio ? "stdio" : "default",
      hostname,
      port: Option.getOrUndefined(input.port),
      showCredentials: input.showCredentials,
    })
  }),
)
