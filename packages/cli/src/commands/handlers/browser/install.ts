import { EOL } from "node:os"
import { confirm, isCancel } from "@clack/prompts"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"

// Opt-in download: nothing in the browser service fetches a binary on its own. The Playwright
// cache it writes to (~/.cache/ms-playwright/chromium-*) is the last stop of the resolution order.
export default Runtime.handler(
  Commands.commands.browser.commands.install,
  Effect.fn("cli.browser.install")(function* (input) {
    if (!input.yes) {
      const answer = yield* Effect.promise(() =>
        confirm({
          message: "Download Chromium (~170 MB) with `bunx playwright-core install chromium`?",
          initialValue: true,
        }),
      )
      if (isCancel(answer) || !answer) {
        process.stdout.write("Cancelled" + EOL)
        return
      }
    }
    const proc = Bun.spawn(["bunx", "playwright-core", "install", "chromium"], {
      stdio: ["inherit", "inherit", "inherit"],
    })
    const code = yield* Effect.promise(() => proc.exited)
    if (code !== 0) yield* Effect.fail(new Error(`playwright-core install exited with code ${code}`))
    process.stdout.write("Chromium installed; the browser service resolves it from ~/.cache/ms-playwright" + EOL)
  }),
)
