import { createEffect, on, onCleanup, onMount } from "solid-js"
import type { BrowserViewLocation, BrowserViewPlatform } from "@/runtime/platform/platform"

/**
 * Desktop body of the browser panel: an empty box whose position the native `WebContentsView`
 * follows. Bounds are reported on every layout change; visibility follows `active` so the view
 * hides while the panel is mounted but off screen.
 */
export function NativeViewSlot(props: { view: BrowserViewPlatform; location: BrowserViewLocation; active: boolean }) {
  let slot!: HTMLDivElement
  let frame: number | undefined

  const report = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const rect = slot.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      void props.view.setBounds(props.location, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
    })
  }

  onMount(() => {
    const observer = new ResizeObserver(report)
    observer.observe(slot)
    // Sidebar resizes and scrolls move the slot without resizing it.
    window.addEventListener("resize", report)
    document.addEventListener("scroll", report, true)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", report)
      document.removeEventListener("scroll", report, true)
      if (frame !== undefined) cancelAnimationFrame(frame)
      void props.view.setVisible(props.location, false)
    })
  })

  createEffect(
    on(
      () => props.active,
      (active) => {
        void props.view.setVisible(props.location, active)
        if (active) report()
      },
    ),
  )

  return (
    <div
      ref={slot}
      data-slot="session-browser-native"
      class="absolute inset-0"
      onClick={() => void props.view.focus(props.location)}
    />
  )
}
