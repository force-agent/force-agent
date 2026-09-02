import { BrowserWindow } from "electron"
import { Effect } from "effect"
import { BrowserRpcs } from "../../shared/ipc-rpc"
import { viewBounds } from "../browser/bounds"
import { BrowserProvider } from "../browser/provider-client"
import { IpcPortHandoff } from "../ipc-transport"
import { sender } from "./context"

export const browserHandlers = BrowserRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const provider = yield* BrowserProvider.Service
    const windowOf = (context: Parameters<typeof sender>[1]) => {
      const contents = sender(handoff, context)
      const win = BrowserWindow.fromWebContents(contents)
      if (!win) throw new Error("Window not found")
      return { contents, win }
    }
    return BrowserRpcs.of({
      BrowserSetBounds: ({ location, bounds }, context) =>
        Effect.sync(() => {
          const { contents, win } = windowOf(context)
          provider.setBounds(location, win, viewBounds(bounds, contents.getZoomFactor()))
        }),
      BrowserSetVisible: ({ location, visible }, context) =>
        Effect.sync(() => provider.setVisible(location, windowOf(context).win, visible)),
      BrowserFocus: ({ location }) => Effect.sync(() => provider.focus(location)),
    })
  }),
)
