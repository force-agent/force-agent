import { BrowserWindow, WebContentsView, type WebContents } from "electron"
import type { BrowserViewBounds } from "../../shared/ipc-contract"

export type Tab = {
  readonly id: string
  readonly url: string
  readonly title: string
}

export type ViewHostOptions = {
  readonly partition: string
  // Called whenever the tab list (ids, urls, titles) changes; the provider client forwards it.
  readonly onChange: () => void
  // Applied to every new view's WebContents (popup, download and certificate policy, debugger).
  readonly onCreate: (contents: WebContents, tabID: string) => void
}

const EMPTY: BrowserViewBounds = { x: 0, y: 0, width: 0, height: 0 }

// One project's native browser: a `WebContentsView` per tab, all attached to the window that
// shows the project. Only the active tab is visible, and only while the renderer says the panel
// is on screen and the window itself is showing.
export class ViewHost {
  private readonly views = new Map<string, WebContentsView>()
  private win: BrowserWindow | undefined
  private bounds = EMPTY
  private panelVisible = false
  private windowVisible = true
  private activeID: string | undefined
  private readonly windowListeners: Array<() => void> = []

  constructor(private readonly options: ViewHostOptions) {}

  get active() {
    return this.activeID === undefined ? undefined : this.views.get(this.activeID)
  }

  get visible() {
    return this.panelVisible && this.windowVisible && this.win !== undefined && !this.win.isDestroyed()
  }

  get(tabID: string) {
    return this.views.get(tabID)
  }

  list(): Tab[] {
    return [...this.views.entries()].map(([id, view]) => ({
      id,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
    }))
  }

  // `activate: false` lists the tab without showing it (popups the person opened); the first tab
  // is always the active one.
  create(url: string, activate = true): string {
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: this.options.partition,
      },
    })
    const contents = view.webContents
    const id = String(contents.id)
    // Sites see a regular Chrome of the same version, not an Electron shell.
    contents.setUserAgent(contents.getUserAgent().replace(/ Electron\/\S+/, ""))
    this.views.set(id, view)
    this.options.onCreate(contents, id)
    const changed = () => this.options.onChange()
    contents.on("page-title-updated", changed)
    contents.on("did-navigate", changed)
    contents.on("did-navigate-in-page", changed)
    contents.on("did-finish-load", changed)
    contents.once("destroyed", () => {
      if (this.views.get(id) !== view) return
      this.views.delete(id)
      if (this.activeID === id) this.activeID = this.views.keys().next().value
      this.apply()
      this.options.onChange()
    })
    if (this.win && !this.win.isDestroyed()) this.win.contentView.addChildView(view)
    if (activate || this.activeID === undefined) this.activeID = id
    view.setBounds(this.bounds)
    this.apply()
    void contents.loadURL(url).catch(() => undefined)
    this.options.onChange()
    return id
  }

  close(tabID: string) {
    const view = this.views.get(tabID)
    if (!view) return
    this.views.delete(tabID)
    if (this.activeID === tabID) this.activeID = this.views.keys().next().value
    if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(view)
    view.webContents.close()
    this.apply()
    this.options.onChange()
  }

  activate(tabID: string) {
    if (!this.views.has(tabID) || this.activeID === tabID) return
    this.activeID = tabID
    this.apply()
  }

  // Bind (or move) every view to `win`. A project shown in two windows follows the last one
  // that reported the panel.
  host(win: BrowserWindow) {
    if (this.win === win) return
    if (this.win && !this.win.isDestroyed()) for (const view of this.views.values()) this.win.contentView.removeChildView(view)
    for (const off of this.windowListeners.splice(0)) off()
    this.win = win
    this.windowVisible = win.isVisible() && !win.isMinimized()
    const hide = () => {
      this.windowVisible = false
      this.apply()
    }
    const show = () => {
      this.windowVisible = true
      this.apply()
    }
    const gone = () => {
      if (this.win !== win) return
      this.win = undefined
      this.apply()
    }
    win.on("hide", hide)
    win.on("minimize", hide)
    win.on("show", show)
    win.on("restore", show)
    win.once("closed", gone)
    this.windowListeners.push(
      () => win.off("hide", hide),
      () => win.off("minimize", hide),
      () => win.off("show", show),
      () => win.off("restore", show),
      () => win.off("closed", gone),
    )
    for (const view of this.views.values()) win.contentView.addChildView(view)
    this.apply()
  }

  setBounds(bounds: BrowserViewBounds) {
    this.bounds = bounds
    this.apply()
  }

  setVisible(visible: boolean) {
    this.panelVisible = visible
    this.apply()
  }

  focus() {
    const view = this.active
    if (view && this.visible) view.webContents.focus()
  }

  dispose() {
    for (const off of this.windowListeners.splice(0)) off()
    for (const [id] of this.views) this.close(id)
    this.win = undefined
  }

  private apply() {
    for (const [id, view] of this.views) {
      const show = this.visible && id === this.activeID
      view.setVisible(show)
      if (show) view.setBounds(this.bounds)
    }
  }
}
