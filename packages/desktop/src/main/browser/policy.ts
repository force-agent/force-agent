import fs from "node:fs"
import path from "node:path"
import type { Session, WebContents } from "electron"

export type PolicyOptions = {
  // Popups (`window.open`, target=_blank) become tabs of the same project.
  readonly onNewTab: (url: string) => void
  // `<project>/.force/downloads`
  readonly downloads: string
  readonly log: (message: string, data?: Record<string, unknown>) => void
}

const wiredSessions = new WeakSet<Session>()

// Policy for the agent's browser views only; the app window keeps `windows/security.ts`.
// Navigation is unrestricted on purpose: this is the browser the agent and the person drive.
export function applyPolicy(contents: WebContents, options: PolicyOptions) {
  contents.setWindowOpenHandler((details) => {
    options.onNewTab(details.url)
    return { action: "deny" }
  })
  contents.on("certificate-error", (event, url, error, _certificate, callback) => {
    event.preventDefault()
    options.log("certificate rejected", { url, error })
    callback(false)
  })
  const session = contents.session
  if (wiredSessions.has(session)) return
  wiredSessions.add(session)
  session.on("will-download", (_event, item) => {
    fs.mkdirSync(options.downloads, { recursive: true })
    const target = path.join(options.downloads, safeName(item.getFilename()))
    item.setSavePath(target)
    options.log("download started", { url: item.getURL(), path: target })
    item.once("done", (_done, state) => options.log("download finished", { path: target, state }))
  })
}

function safeName(name: string) {
  const clean = name.replace(/[/\\]/g, "_").trim() || "download"
  return `${Date.now()}-${clean}`
}
