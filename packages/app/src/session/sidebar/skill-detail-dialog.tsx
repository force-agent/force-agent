import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, createMemo, createResource, createSignal, For, Show, type Accessor } from "solid-js"
import type { SkillInfo } from "@opencode-ai/client/promise"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { isBinaryPath } from "@/workspaces/files/file-content"

type Entry = { path: string; type: "file" | "directory" }

/** `fs.list` returns directories with a trailing slash; strip it before taking the basename. */
function nameOf(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() ?? path
}

function skillDirectory(skill: SkillInfo) {
  const loc = skill.location
  const idx = loc.lastIndexOf("/")
  if (idx <= 0) return loc
  return loc.slice(0, idx)
}

export function SkillDetailDialog(props: { skill: SkillInfo; open: Accessor<boolean>; onOpenChange: (open: boolean) => void }) {
  const sdk = useServerSDK()
  const language = useLanguage()
  const skillDir = createMemo(() => skillDirectory(props.skill))
  const [selected, setSelected] = createSignal<string>("")
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set<string>())
  const [listings, setListings] = createSignal<Map<string, Entry[]>>(new Map<string, Entry[]>())

  const loadDir = async (path: string) => {
    try {
      const res = await sdk.api.file.list({ location: { directory: skillDir() }, path: path || undefined })
      setListings((prev) => {
        const next = new Map(prev)
        next.set(path, res.data as Entry[])
        return next
      })
      return res.data as Entry[]
    } catch {
      setListings((prev) => {
        const next = new Map(prev)
        next.set(path, [])
        return next
      })
      return [] as Entry[]
    }
  }

  createEffect(() => {
    if (!props.open()) return
    setSelected("")
    setExpanded(new Set<string>())
    setListings(new Map<string, Entry[]>())
    void loadDir("").then((entries) => {
      const first = entries.find((e) => e.type === "file")
      if (first) setSelected(first.path)
    })
  })

  const toggleDir = (path: string) => {
    const next = new Set(expanded())
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      if (!listings().has(path)) void loadDir(path)
    }
    setExpanded(next)
  }

  const selectFile = (path: string) => setSelected(path)

  const [content] = createResource(
    () => (selected() ? { dir: skillDir(), path: selected() } : undefined),
    async (input) => {
      if (!input) return undefined
      try {
        const data = (await sdk.api.file.read({ path: input.path, location: { directory: input.dir } })) as unknown as Uint8Array
        const binary = isBinaryPath(input.path)
        if (binary) return { type: "binary" as const, text: "" }
        const text = new TextDecoder().decode(data as Uint8Array)
        return { type: "text" as const, text }
      } catch {
        return { type: "error" as const, text: "" }
      }
    },
  )

  const isMd = createMemo(() => selected().toLowerCase().endsWith(".md"))

  return (
    <Kobalte open={props.open()} onOpenChange={props.onOpenChange}>
      <Kobalte.Portal>
        <Kobalte.Overlay class="fixed inset-0 z-50 bg-[var(--v2-overlay-simple-overlay-scrim)]" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Kobalte.Content
            data-slot="dialog-content"
            class="flex max-h-[calc(100vh-32px)] w-full max-w-[800px] h-[480px] flex-col overflow-hidden rounded-[6px] border border-[var(--v2-border-border-weaker-base)] bg-[var(--v2-background-bg-layer-01)] shadow-[var(--v2-elevation-overlay)]"
          >
            <div class="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--v2-border-border-weaker-base)] px-4 py-3">
              <div class="min-w-0 flex-1">
                <Kobalte.Title class="truncate text-[13px] font-medium leading-[16px] text-[var(--v2-text-text-base)]">
                  {props.skill.name}
                </Kobalte.Title>
                <Show when={props.skill.description}>
                  <Kobalte.Description class="line-clamp-2 text-[12px] leading-[16px] text-[var(--v2-text-text-muted)]">
                    {props.skill.description}
                  </Kobalte.Description>
                </Show>
              </div>
              <Kobalte.CloseButton
                aria-label={language.t("common.close")}
                class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--v2-icon-icon-muted)] hover:bg-[var(--v2-overlay-simple-overlay-hover)]"
              >
                <Icon name="close" size="small" />
              </Kobalte.CloseButton>
            </div>
            <div class="flex min-h-0 flex-1">
              <div class="w-[220px] shrink-0 overflow-auto border-r border-[var(--v2-border-border-weaker-base)]">
                <For each={listings().get("") ?? []}>
                  {(entry) => (
                    <Show
                      when={entry.type === "directory"}
                      fallback={
                        <button
                          type="button"
                          class="flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] text-[var(--v2-text-text-muted)] hover:bg-[var(--v2-overlay-simple-overlay-hover)] data-[selected]:bg-[var(--v2-overlay-simple-overlay-pressed)] data-[selected]:text-[var(--v2-text-text-base)]"
                          data-selected={selected() === entry.path ? "" : undefined}
                          onClick={() => selectFile(entry.path)}
                        >
                          <FileIcon node={{ path: entry.path, type: "file" }} class="size-4 shrink-0" />
                          <span class="min-w-0 flex-1 truncate">{nameOf(entry.path)}</span>
                        </button>
                      }
                    >
                      <div>
                        <button
                          type="button"
                          class="flex h-7 w-full items-center gap-1 px-2 text-left text-[12px] text-[var(--v2-text-text-muted)] hover:bg-[var(--v2-overlay-simple-overlay-hover)]"
                          aria-expanded={expanded().has(entry.path)}
                          onClick={() => toggleDir(entry.path)}
                        >
                          <span
                            class="flex size-4 shrink-0 items-center justify-center transition-transform"
                            style={{ transform: expanded().has(entry.path) ? "rotate(90deg)" : "rotate(0deg)" }}
                          >
                            <Icon name="chevron-down" size="small" />
                          </span>
                          <FileIcon node={{ path: entry.path, type: "directory" }} class="size-4 shrink-0" />
                          <span class="min-w-0 flex-1 truncate">{nameOf(entry.path)}</span>
                        </button>
                        <Show when={expanded().has(entry.path)}>
                          <div class="pl-3">
                            <For each={listings().get(entry.path) ?? []}>
                              {(child) => (
                                <Show
                                  when={child.type === "directory"}
                                  fallback={
                                    <button
                                      type="button"
                                      class="flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] text-[var(--v2-text-text-muted)] hover:bg-[var(--v2-overlay-simple-overlay-hover)] data-[selected]:bg-[var(--v2-overlay-simple-overlay-pressed)] data-[selected]:text-[var(--v2-text-text-base)]"
                                      data-selected={selected() === child.path ? "" : undefined}
                                      onClick={() => selectFile(child.path)}
                                    >
                                      <FileIcon node={{ path: child.path, type: "file" }} class="size-4 shrink-0" />
                                      <span class="min-w-0 flex-1 truncate">{nameOf(child.path)}</span>
                                    </button>
                                  }
                                >
                                  <div class="flex h-7 items-center gap-1 px-2 text-[12px] text-[var(--v2-text-text-faint)]">
                                    <FileIcon node={{ path: child.path, type: "directory" }} class="size-4 shrink-0" />
                                    <span class="truncate">{nameOf(child.path)}</span>
                                  </div>
                                </Show>
                              )}
                            </For>
                            <Show when={(listings().get(entry.path) ?? []).length === 0}>
                              <div class="px-6 py-1 text-[11px] text-[var(--v2-text-text-faint)]">{language.t("session.files.empty")}</div>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  )}
                </For>
                <Show when={(listings().get("") ?? []).length === 0}>
                  <div class="px-3 py-6 text-center text-[12px] text-[var(--v2-text-text-faint)]">{language.t("session.files.empty")}</div>
                </Show>
              </div>
              <div class="flex min-w-0 flex-1 flex-col overflow-auto p-3">
                <Show when={selected()} fallback={<div class="text-[12px] text-[var(--v2-text-text-faint)]">{language.t("session.files.selectToOpen")}</div>}>
                  <Show
                    when={content.loading}
                    fallback={
                      <Show
                        when={content()?.type !== "binary"}
                        fallback={<div class="text-[12px] text-[var(--v2-text-text-faint)]">{language.t("session.files.binaryContent")}</div>}
                      >
                        <Show
                          when={content()?.type !== "error"}
                          fallback={<div class="text-[12px] text-[var(--v2-text-text-faint)]">{language.t("toast.file.loadFailed.title")}</div>}
                        >
                          <pre class="whitespace-pre-wrap break-words text-[12px] leading-[16px] text-[var(--v2-text-text-base)]" data-overflow={isMd() ? "wrap" : "wrap"}>
                            {content()?.text}
                          </pre>
                        </Show>
                      </Show>
                    }
                  >
                    <div class="text-[12px] text-[var(--v2-text-text-faint)]">{language.t("common.loading")}...</div>
                  </Show>
                </Show>
              </div>
            </div>
          </Kobalte.Content>
        </div>
      </Kobalte.Portal>
    </Kobalte>
  )
}
