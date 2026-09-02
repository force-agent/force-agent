import { SessionContextTab } from "@/session/files/session-context-tab"

export function ContextPanel() {
  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <SessionContextTab />
    </div>
  )
}
