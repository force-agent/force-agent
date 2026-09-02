// One CDP wire: JSON messages in, JSON messages out. Implemented over the launched Chromium's
// `--remote-debugging-pipe` (fds 3/4), a DevTools WebSocket, or, in a later phase, the Electron
// main process relaying `webContents.debugger` for the desktop provider.
export interface CdpTransport {
  readonly send: (message: string) => void
  readonly onMessage: (listener: (message: string) => void) => () => void
  readonly onClose: (listener: () => void) => () => void
  readonly close: () => void
}
