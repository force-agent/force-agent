import { createSignal, For } from "solid-js"
import { createVirtualizer } from "@tanstack/solid-virtual"

export function SheetTable(props: { headers: string[]; rows: string[][]; testid: string }) {
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>()

  const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.rows.length
    },
    getScrollElement: () => scrollEl() ?? null,
    initialRect: { width: 0, height: 600 },
    estimateSize: () => 28,
    overscan: 10,
  })

  return (
    <div ref={setScrollEl} data-testid={`${props.testid}-preview`} class="flex-1 min-h-0 overflow-auto">
      <div class="min-w-max">
        <div
          class="sticky top-0 z-1 flex bg-background-stronger border-b border-border-weaker-base"
          data-testid={`${props.testid}-header`}
        >
          <For each={props.headers}>
            {(header) => (
              <div
                class="shrink-0 w-[180px] px-3 py-2 text-12-semibold text-text-strong border-r border-border-weaker-base truncate"
                title={header}
                data-testid={`${props.testid}-header-cell`}
              >
                {header}
              </div>
            )}
          </For>
        </div>
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            position: "relative",
            width: `${props.headers.length * 180}px`,
          }}
        >
          <For each={rowVirtualizer.getVirtualItems()}>
            {(virtualRow) => {
              const row = () => props.rows[virtualRow.index] ?? []
              return (
                <div
                  data-testid={`${props.testid}-row`}
                  data-index={virtualRow.index}
                  class="absolute top-0 left-0 flex border-b border-border-weaker-base hover:bg-background-stronger"
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    width: "100%",
                  }}
                >
                  <For each={row()}>
                    {(cell) => (
                      <div
                        class="shrink-0 w-[180px] px-3 py-1.5 text-13-regular text-text-base border-r border-border-weaker-base truncate"
                        title={cell}
                        data-testid={`${props.testid}-cell`}
                      >
                        {cell}
                      </div>
                    )}
                  </For>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
