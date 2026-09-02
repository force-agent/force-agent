import type { Accessor } from "solid-js"

export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  /** The server is coming back on the new version; the page reloads by itself (web). */
  | { status: "restarting"; version: string }
  /** A newer version exists but this installation cannot apply it; show the command instead (web). */
  | { status: "manual"; version: string; command?: string }
  | { status: "error"; message: string }

export type UpdaterPlatform = {
  state: Accessor<UpdaterState>
  check(): Promise<UpdaterState>
  install(): Promise<void>
}
