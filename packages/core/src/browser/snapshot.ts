import type { Browser } from "@opencode-ai/schema/browser"
import type { CdpClient } from "./cdp/client.js"

export const DEFAULT_MAX_NODES = 400

// Roles the agent can act on. These always get a ref; `interactive` mode lists only these.
const INTERACTIVE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "switch",
  "spinbutton",
  "menubutton",
  "tabpanel",
])

// Layout-only roles: descend into them without printing a line.
const TRANSPARENT = new Set(["none", "presentation", "generic", "GenericContainer", "InlineTextBox", "LineBreak"])

const FLAGS = ["checked", "disabled", "expanded", "selected", "required", "readonly", "pressed", "invalid"]

type AXNode = {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value?: string }
  readonly name?: { readonly value?: string }
  readonly value?: { readonly value?: string | number | boolean }
  readonly properties?: ReadonlyArray<{
    readonly name: string
    readonly value?: { readonly value?: string | number | boolean }
  }>
  readonly childIds?: ReadonlyArray<string>
  readonly backendDOMNodeId?: number
}

export type Tree = {
  readonly nodes: Browser.SnapshotNode[]
  readonly text: string
  // ref -> backendDOMNodeId, valid for this snapshot version only.
  readonly refs: Map<string, number>
  readonly truncated: boolean
}

export async function capture(
  client: CdpClient,
  sessionId: string,
  options: { readonly mode: Browser.SnapshotMode; readonly maxNodes?: number },
): Promise<Tree> {
  const result = await client.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}, sessionId)
  const byId = new Map(result.nodes.map((node) => [node.nodeId, node]))
  const root = result.nodes[0]
  const nodes: Browser.SnapshotNode[] = []
  const refs = new Map<string, number>()
  const max = options.maxNodes ?? DEFAULT_MAX_NODES
  let truncated = false

  const walk = (node: AXNode, depth: number, parentName: string | undefined) => {
    if (nodes.length >= max) {
      truncated = true
      return
    }
    const role = String(node.role?.value ?? "")
    const name = clip(String(node.name?.value ?? ""), 120)
    const printable = !node.ignored && !TRANSPARENT.has(role) && role !== ""
    const interactive = INTERACTIVE.has(role)
    // A text leaf repeating its parent's accessible name adds nothing.
    const redundant = role === "StaticText" && (name === "" || name === parentName)
    const wanted = options.mode === "interactive" ? interactive : printable && !redundant
    const nextDepth = wanted && options.mode !== "interactive" ? depth + 1 : depth
    if (wanted) {
      const ref = node.backendDOMNodeId !== undefined && role !== "StaticText" ? `e${refs.size + 1}` : undefined
      if (ref !== undefined && node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId)
      const value = node.value?.value
      nodes.push({
        ...(ref === undefined ? {} : { ref }),
        role,
        name: annotate(name, node),
        depth,
        ...(value === undefined || value === "" ? {} : { value: clip(String(value), 80) }),
      })
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id)
      if (child) walk(child, nextDepth, wanted ? name : parentName)
    }
  }
  if (root) walk(root, 0, undefined)

  return { nodes, refs, truncated, text: render(nodes) }
}

export function render(nodes: ReadonlyArray<Browser.SnapshotNode>) {
  return nodes
    .map((node) => {
      const parts = [`${"  ".repeat(node.depth)}- ${node.role}`]
      if (node.name !== "") parts.push(JSON.stringify(node.name))
      if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`)
      if (node.ref !== undefined) parts.push(`[ref=${node.ref}]`)
      return parts.join(" ")
    })
    .join("\n")
}

// Line diff on ref-stripped text: refs are renumbered every snapshot, so comparing them would
// report the whole page as changed.
export function diff(previous: string | undefined, current: string) {
  const strip = (line: string) => line.replace(/ \[ref=e\d+\]$/, "")
  const before = new Set((previous ?? "").split("\n").map(strip))
  const after = new Map(current.split("\n").map((line) => [strip(line), line]))
  const added = [...after.entries()].filter(([key]) => !before.has(key)).map(([, line]) => `+ ${line.trimStart()}`)
  const removed = [...before].filter((key) => key !== "" && !after.has(key)).map((line) => `- ${line.trimStart()}`)
  if (added.length === 0 && removed.length === 0) return "(no changes)"
  return [...removed, ...added].join("\n")
}

function annotate(name: string, node: AXNode) {
  const flags = (node.properties ?? [])
    .filter((property) => FLAGS.includes(property.name))
    .filter((property) => property.value?.value !== false && property.value?.value !== "false")
    .map((property) => property.name)
  const level = node.properties?.find((property) => property.name === "level")?.value?.value
  const suffix = [...flags, ...(level === undefined ? [] : [`level=${level}`])]
  return suffix.length === 0 ? name : `${name} [${suffix.join(", ")}]`
}

function clip(text: string, max: number) {
  const single = text.replace(/\s+/g, " ").trim()
  return single.length > max ? single.slice(0, max - 1) + "…" : single
}
