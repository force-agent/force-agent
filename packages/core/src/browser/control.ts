import type { Browser } from "@opencode-ai/schema/browser"

// `idle | agent | human | handoff-login`. Agent tools acquire `agent` around each action and drop
// back to `idle`; the panel takes `human` and releases it; `browser_handoff` parks the session in
// `handoff-login` until the human releases, the URL matches `until`, or the timeout fires. While a
// human holds control every agent action fails fast with the state and a hint.
export type State = {
  readonly control: Browser.Control
  readonly since: number
  readonly handoff?: Browser.Handoff
}

export type Transition =
  | "agent.acquire"
  | "agent.release"
  | "human.take"
  | "human.release"
  | { readonly handoff: Browser.Handoff }
  | "handoff.end"

export class ControlError extends Error {
  constructor(
    readonly state: Browser.Control,
    readonly hint: string,
  ) {
    super(`Browser is controlled by ${state}: ${hint}`)
    this.name = "BrowserControlError"
  }
}

export const initial = (): State => ({ control: "idle", since: Date.now() })

export function transition(state: State, input: Transition): State {
  const now = Date.now()
  if (typeof input === "object") {
    if (state.control === "human")
      throw new ControlError("human", "A person is using the browser; wait for them to hand it back.")
    return { control: "handoff-login", since: now, handoff: input.handoff }
  }
  if (input === "agent.acquire") {
    if (state.control === "idle" || state.control === "agent") return { control: "agent", since: now }
    if (state.control === "human")
      throw new ControlError("human", "A person is using the browser; use browser_handoff or wait.")
    throw new ControlError("handoff-login", "Waiting for the person to finish the handoff.")
  }
  if (input === "agent.release") return state.control === "agent" ? { control: "idle", since: now } : state
  if (input === "human.take") return { control: "human", since: now }
  return { control: "idle", since: now }
}

export const canAct = (state: State) => state.control === "idle" || state.control === "agent"
