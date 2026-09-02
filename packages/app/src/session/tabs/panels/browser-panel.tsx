import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"

import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"
import { useWorkspaceLocation } from "@/workspaces/location"
import { controlLabelKey, useBrowserStore } from "@/session/browser/store"
import { fitFrame, toPagePoint, type Fit } from "@/session/browser/coords"
import { NativeViewSlot } from "@/session/browser/native-view-slot"
import { modifiers, openStream, parseFrame, type FrameHeader, type StreamInput } from "@/session/browser/stream"

const RESIZE_DEBOUNCE_MS = 200
const RECONNECT_MS = 1_000
const MIN_VIEWPORT = { width: 200, height: 150 }

/**
 * Shared browser: tab pills, URL bar, who-controls badge and a canvas fed by the
 * server's screencast. The panel stays mounted while hidden, so the stream only
 * runs while `active` is true.
 */
export function BrowserPanel(props: { active?: boolean }) {
  const language = useLanguage()
  const store = useBrowserStore()
  const platform = usePlatform()
  const server = useServer()
  const location = useWorkspaceLocation()
  const [draft, setDraft] = createSignal<string | undefined>(undefined)
  const [opening, setOpening] = createSignal(false)

  // Launching a browser takes seconds and can fail; without this the empty-state button looks
  // dead until it either works or errors out.
  const open = async () => {
    setOpening(true)
    try {
      await store.open()
    } finally {
      setOpening(false)
    }
  }

  // Desktop app talking to its own sidecar: the browser lives in a native view hosted by this
  // window, so the screencast never starts. Remote servers (http, ssh) keep the canvas.
  const native = () => (ServerConnection.builtin(server.conn) ? platform.browserView : undefined)

  // Bind this window to the location before any tab exists, so the server prefers the desktop
  // provider over launching its own Chromium on the first tool call.
  createEffect(() => {
    const view = native()
    if (view) void view.setVisible(location().ref, false)
  })

  const url = () => draft() ?? store.active()?.url ?? ""

  const submit = () => {
    const raw = (draft() ?? "").trim()
    setDraft(undefined)
    if (!raw) return
    const target = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`
    void store.navigate(target, store.active()?.id)
  }

  return (
    <div data-slot="session-browser-panel" class="flex h-full min-h-0 flex-col">
      <Show
        when={store.tabs().length > 0}
        fallback={
          <div class="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <Icon name="monitor" size="large" class="opacity-10" />
            <div class="flex flex-col gap-1">
              <div class="text-14-medium text-text">{language.t("session.tab.browser.empty.title")}</div>
              <div class="text-13-regular text-text-weak max-w-64">
                {language.t("session.tab.browser.empty.description")}
              </div>
            </div>
            <Button
              data-slot="session-browser-open"
              data-pending={opening() || undefined}
              disabled={opening()}
              onClick={() => void open()}
            >
              {language.t(opening() ? "session.browser.opening" : "session.browser.open")}
            </Button>
            <Show when={store.error()}>
              {(error) => (
                <div class="text-12-regular text-v2-text-text-danger max-w-96">
                  {language.t("session.browser.error", { message: error() })}
                </div>
              )}
            </Show>
          </div>
        }
      >
        <div
          data-slot="session-browser-toolbar"
          class="flex shrink-0 flex-col gap-1 border-b border-v2-border-border-weaker-base px-2 py-1.5"
        >
          <div class="flex min-w-0 items-center gap-1 overflow-x-auto">
            <For each={store.tabs()}>
              {(tab) => (
                <span
                  data-slot="session-browser-tab"
                  data-active={tab.id === store.active()?.id || undefined}
                  class="flex max-w-48 shrink-0 items-center gap-1 rounded-full border border-v2-border-border-weaker-base px-2 py-0.5 text-12-regular text-v2-text-text-muted data-[active]:border-v2-border-border-weak-base data-[active]:bg-v2-background-bg-base data-[active]:text-v2-text-text-base"
                >
                  <button
                    type="button"
                    class="min-w-0 truncate"
                    title={tab.url}
                    onClick={() => void store.activate(tab.id)}
                  >
                    {tab.title || tab.url || language.t("session.browser.tab.new")}
                  </button>
                  <IconButton
                    icon={<Icon name="xmark-small" size="small" />}
                    variant="ghost-muted"
                    size="small"
                    class="!size-4"
                    aria-label={language.t("session.browser.tab.close")}
                    onClick={() => void store.close(tab.id)}
                  />
                </span>
              )}
            </For>
            <IconButton
              icon={<Icon name="plus-small" size="small" />}
              variant="ghost-muted"
              size="small"
              aria-label={language.t("session.browser.tab.new")}
              title={language.t("session.browser.tab.new")}
              onClick={() => void store.open()}
            />
          </div>
          <div class="flex items-center gap-1">
            <IconButton
              icon={<Icon name="arrow-left" size="small" />}
              variant="ghost-muted"
              size="small"
              aria-label={language.t("session.browser.back")}
              title={language.t("session.browser.back")}
              onClick={() => {
                const tab = store.active()
                if (tab) void store.back(tab.id)
              }}
            />
            <IconButton
              icon={<Icon name="outline-reset" size="small" />}
              variant="ghost-muted"
              size="small"
              aria-label={language.t("session.browser.reload")}
              title={language.t("session.browser.reload")}
              onClick={() => {
                const tab = store.active()
                if (tab) void store.reload(tab.id)
              }}
            />
            <input
              data-slot="session-browser-url"
              type="text"
              class="min-w-0 flex-1 rounded-[6px] border border-v2-border-border-weaker-base bg-v2-background-bg-layer-01 px-2 py-1 text-12-regular text-v2-text-text-base outline-none focus:border-v2-border-border-weak-base"
              placeholder={language.t("session.browser.url.placeholder")}
              value={url()}
              spellcheck={false}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onBlur={() => setDraft(undefined)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit()
                if (event.key === "Escape") setDraft(undefined)
              }}
            />
            <span
              data-slot="session-browser-control"
              data-control={store.control()}
              class="shrink-0 rounded-full px-2 py-0.5 text-[11px] uppercase tracking-wide text-v2-text-text-muted"
              classList={{
                "bg-v2-icon-icon-accent text-white": store.control() === "agent",
                "bg-v2-state-border-info text-white":
                  store.control() === "human" || store.control() === "handoff-login",
                "bg-v2-background-bg-layer-01": store.control() === "idle",
              }}
            >
              {language.t(controlLabelKey[store.control()])}
            </span>
            <Show
              when={store.control() === "human" || store.control() === "handoff-login"}
              fallback={
                <Button size="small" data-slot="session-browser-take" onClick={() => void store.setControl("human")}>
                  {language.t("session.browser.take")}
                </Button>
              }
            >
              <Button size="small" data-slot="session-browser-release" onClick={() => void store.setControl("release")}>
                {language.t(
                  store.control() === "handoff-login" ? "session.browser.handoff.done" : "session.browser.release",
                )}
              </Button>
            </Show>
          </div>
        </div>
        <Show when={store.handoff()}>
          {(handoff) => (
            <div
              data-slot="session-browser-handoff"
              class="flex shrink-0 items-center gap-2 bg-v2-state-border-info/15 px-3 py-1.5 text-12-regular text-v2-text-text-base"
            >
              <Icon name="warning" size="small" />
              <span class="min-w-0 flex-1 truncate">
                {language.t("session.browser.handoff.banner", { reason: handoff().reason })}
              </span>
            </div>
          )}
        </Show>
        <Show when={store.error()}>
          {(error) => (
            <div class="shrink-0 px-3 py-1 text-12-regular text-v2-text-text-danger">
              {language.t("session.browser.error", { message: error() })}
            </div>
          )}
        </Show>
        <div class="relative min-h-0 flex-1 bg-v2-background-bg-layer-01">
          <Show
            when={native()}
            fallback={
              <Show when={props.active && store.active()?.id}>{(tabID) => <ScreencastCanvas tabID={tabID()} />}</Show>
            }
          >
            {(view) => (
              <NativeViewSlot view={view()} location={location().ref} active={!!props.active && !!store.active()} />
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

const BUTTONS = ["left", "middle", "right"] as const

function ScreencastCanvas(props: { tabID: string }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const directory = useWorkspaceLocation()().directory
  const [status, setStatus] = createSignal<"connecting" | "open" | "closed">("connecting")
  let wrapper!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let socket: WebSocket | undefined
  let header: FrameHeader | undefined
  let image: ImageBitmap | undefined
  let pending: Blob | undefined
  let decoding = false
  let fit: Fit = { x: 0, y: 0, width: 0, height: 0 }

  const draw = () => {
    const box = wrapper.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(box.width * dpr))
    const height = Math.max(1, Math.floor(box.height * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const context = canvas.getContext("2d")
    if (!context) return
    context.clearRect(0, 0, width, height)
    if (!image) return
    fit = fitFrame({ width: box.width, height: box.height }, { width: image.width, height: image.height })
    context.drawImage(image, fit.x * dpr, fit.y * dpr, fit.width * dpr, fit.height * dpr)
  }

  // Decode at most one frame at a time; a frame that arrives mid-decode replaces the queued one.
  const decode = async (blob: Blob) => {
    pending = blob
    if (decoding) return
    decoding = true
    while (pending) {
      const next = pending
      pending = undefined
      const bitmap = await createImageBitmap(next).catch(() => undefined)
      if (!bitmap) continue
      image?.close()
      image = bitmap
      draw()
    }
    decoding = false
  }

  const send = (input: StreamInput) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(input))
  }

  // Match the page viewport to the canvas so frames map 1:1; a wrapper mid-layout (hidden tab,
  // collapsed panel) reports a tiny box that must not become the viewport.
  const resize = () => {
    const box = wrapper.getBoundingClientRect()
    if (box.width < MIN_VIEWPORT.width || box.height < MIN_VIEWPORT.height) return
    send({ type: "resize", width: Math.floor(box.width), height: Math.floor(box.height) })
  }

  const point = (event: { clientX: number; clientY: number }) => {
    if (!header) return undefined
    const box = canvas.getBoundingClientRect()
    return toPagePoint({ x: event.clientX - box.left, y: event.clientY - box.top }, fit, header)
  }

  createEffect(
    on(
      () => props.tabID,
      (tabID) => {
        let disposed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const connect = async () => {
          if (disposed) return
          setStatus("connecting")
          const next = await openStream(sdk, { tabID, directory }).catch(() => undefined)
          if (!next || disposed) {
            next?.close(1000)
            timer = setTimeout(connect, RECONNECT_MS)
            return
          }
          socket = next
          next.addEventListener("open", () => {
            setStatus("open")
            resize()
          })
          next.addEventListener("message", (event) => {
            if (!(event.data instanceof ArrayBuffer)) return
            const frame = parseFrame(event.data)
            if (!frame) return
            header = frame.header
            void decode(frame.image)
          })
          next.addEventListener("close", () => {
            if (socket === next) socket = undefined
            if (disposed) return
            setStatus("closed")
            timer = setTimeout(connect, RECONNECT_MS)
          })
        }
        void connect()
        onCleanup(() => {
          disposed = true
          clearTimeout(timer)
          socket?.close(1000)
          socket = undefined
        })
      },
    ),
  )

  createEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      draw()
      clearTimeout(timer)
      timer = setTimeout(() => {
        resize()
      }, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(wrapper)
    onCleanup(() => {
      observer.disconnect()
      clearTimeout(timer)
      image?.close()
      image = undefined
    })
  })

  return (
    <div ref={wrapper} class="absolute inset-0">
      <canvas
        ref={canvas}
        data-slot="session-browser-canvas"
        tabIndex={0}
        class="size-full cursor-default outline-none"
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          canvas.focus()
          canvas.setPointerCapture(event.pointerId)
          const at = point(event)
          if (!at) return
          send({
            type: "mouse",
            kind: "down",
            ...at,
            button: BUTTONS[event.button] ?? "left",
            clickCount: 1,
            modifiers: modifiers(event),
          })
        }}
        onPointerUp={(event) => {
          const at = point(event)
          if (!at) return
          send({
            type: "mouse",
            kind: "up",
            ...at,
            button: BUTTONS[event.button] ?? "left",
            clickCount: 1,
            modifiers: modifiers(event),
          })
        }}
        onPointerMove={(event) => {
          const at = point(event)
          if (!at) return
          send({
            type: "mouse",
            kind: "move",
            ...at,
            button: event.buttons & 1 ? "left" : "none",
            modifiers: modifiers(event),
          })
        }}
        onWheel={(event) => {
          event.preventDefault()
          const at = point(event)
          if (!at) return
          send({ type: "wheel", ...at, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) })
        }}
        onKeyDown={(event) => {
          // Let the app keep clipboard paste; everything else goes to the page.
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return
          event.preventDefault()
          send({ type: "key", kind: "down", key: event.key, code: event.code, modifiers: modifiers(event) })
        }}
        onKeyUp={(event) => {
          event.preventDefault()
          send({ type: "key", kind: "up", key: event.key, code: event.code, modifiers: modifiers(event) })
        }}
        onPaste={(event) => {
          event.preventDefault()
          const text = event.clipboardData?.getData("text/plain")
          if (text) send({ type: "paste", text })
        }}
      />
      <Show when={status() !== "open"}>
        <div class="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-2">
          <span class="rounded-full bg-v2-background-bg-base/90 px-2 py-0.5 text-[11px] text-v2-text-text-muted">
            {language.t(
              status() === "connecting" ? "session.browser.stream.connecting" : "session.browser.stream.closed",
            )}
          </span>
        </div>
      </Show>
    </div>
  )
}
