import { Show, type JSX } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"

export type SessionHeaderActionsState = {
  status?: { label: string; content: () => JSX.Element }
}

export function SessionHeaderActions(props: { state: SessionHeaderActionsState }) {
  return (
    <div class="flex items-center gap-2">
      <Show when={props.state.status}>
        {(status) => (
          <Tooltip appearance="standard" placement="bottom" value={status().label}>
            {status().content()}
          </Tooltip>
        )}
      </Show>
    </div>
  )
}
