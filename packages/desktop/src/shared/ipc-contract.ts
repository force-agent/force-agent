export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}

export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type DirectoryPickerOptions = {
  multiple?: boolean
  title?: string
  defaultPath?: string
}

export type FilePickerOptions = DirectoryPickerOptions & {
  extensions?: string[]
}

export type PickedFiles = {
  token: string
  files: { path: string; name: string; size: number }[]
}

export type SaveFilePickerOptions = {
  title?: string
  defaultPath?: string
}

export type ClipboardImage = {
  buffer: ArrayBuffer
  width: number
  height: number
}

// Native browser view (Phase 5): the renderer reports where the browser panel sits, in CSS
// pixels relative to its viewport; main maps that to the window's content view.
export type BrowserViewLocation = {
  directory: string
  workspaceID?: string
}

export type BrowserViewBounds = {
  x: number
  y: number
  width: number
  height: number
}
