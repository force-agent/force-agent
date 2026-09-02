export * as RemotePlugin from "./remote.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../agent.js"

const remote = Agent.ID.make("remote")

const PROMPT = `You are running against a workspace whose operator is not watching every step.

Read, search and explore freely. Anything that writes, runs, or leaves the workspace needs the
operator's answer first, so batch your reading, decide what you actually need, and ask once with
the concrete command or edit rather than a series of small approvals.

State plainly when a request cannot be completed under these rules instead of working around them.`

/**
 * force-agent overlay: a restrictive preset for a session an operator is not
 * sitting in front of.
 *
 * Rules are evaluated in order and the LAST match wins (Permission.evaluate uses
 * findLast), with `ask` as the fallback when nothing matches. So the ordering
 * here is: open with a blanket ask, widen to the read-only actions, then close
 * back down on the specific actions that must not slip through. Rules pushed by
 * `Agent.Info.default` and the agent layer land BEFORE these, which is why the
 * blanket `allow` they seed is neutralised by the first rule below.
 *
 * This narrows what the model reaches for on its own. It is not isolation — the
 * shell is still the shell once a request is approved.
 */
export const Plugin = define({
  id: "opencode.remote",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((draft) => {
      draft.update(remote, (item) => {
        item.name = Agent.Name.make("Remote")
        item.description =
          "Restrictive agent for unattended or remote sessions: reading and searching are allowed, everything that writes, runs, or leaves the workspace is asked for, and access outside the workspace is denied."
        item.system = PROMPT
        item.mode = "primary"
        item.permissions.push(
          { action: "*", resource: "*", effect: "ask" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "question", resource: "*", effect: "allow" },
          { action: "read", resource: "*.env", effect: "ask" },
          { action: "read", resource: "*.env.*", effect: "ask" },
          { action: "read", resource: "*.env.example", effect: "allow" },
          { action: "edit", resource: "*", effect: "ask" },
          { action: "webfetch", resource: "*", effect: "ask" },
          // The shell tool asserts under its own name, "shell"; "bash" is the v1
          // spelling that config migration rewrites (see v1/config/migrate.ts).
          { action: "shell", resource: "*", effect: "ask" },
          // Covered by the blanket ask above, but spelled out so a later widening of the read-only
          // block cannot quietly hand an unattended session a thirty-agent fan-out.
          { action: "workflow.run", resource: "*", effect: "ask" },
          { action: "external_directory", resource: "*", effect: "deny" },
        )
      })
    })
  }),
})
