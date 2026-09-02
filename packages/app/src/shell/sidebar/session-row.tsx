import type { SessionInfo } from "@opencode-ai/client/promise"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Menu } from "@opencode-ai/ui/menu"
import { TextInput } from "@opencode-ai/ui/text-input"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { getRelativeTime } from "@/shell/time"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { sessionLabel, sessionTitle } from "@/session/title"

export function NavSessionRow(props: {
  conn: ServerConnection.Any
  session: SessionInfo
  active: boolean
  onOpen: () => void
  onRename: (title: string) => Promise<boolean>
  onDelete: () => Promise<boolean>
  onExport: () => Promise<void>
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const avatar = useSessionTabAvatarState(
    () => ServerConnection.key(props.conn),
    () => props.session.id,
    () => true,
  )

  // A dialog, not window.prompt: Electron's renderer throws on prompt(), which would
  // make rename impossible in the desktop build.
  const showRename = () => {
    void dialog.show(() => {
      const [value, setValue] = createSignal(sessionLabel(props.session))
      const [pending, setPending] = createSignal(false)
      const submit = async () => {
        const next = value().trim()
        if (!next || pending()) return
        setPending(true)
        const ok = await props.onRename(next)
        setPending(false)
        if (ok) dialog.close()
      }
      return (
        <Dialog fit>
          <DialogHeader hideClose>
            <DialogTitleGroup title={language.t("common.rename")} description={sessionLabel(props.session)} />
          </DialogHeader>
          <DialogBody>
            <TextInput
              class="!w-full min-w-0"
              value={value()}
              autofocus
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => setValue(event.currentTarget.value)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                void submit()
              }}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="contrast" disabled={pending()} onClick={() => void submit()}>
              {language.t("common.rename")}
            </Button>
          </DialogFooter>
        </Dialog>
      )
    })
  }

  const showDelete = () => {
    const name = sessionTitle(props.session.title) ?? language.t("command.session.new")
    void dialog.show(() => (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.delete.title")}
            description={language.t("session.delete.confirm", { name })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              await props.onDelete()
              dialog.close()
            }}
          >
            {language.t("session.delete.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    ))
  }

  return (
    <div
      data-slot="nav-sidebar-session-row"
      data-active={props.active ? "" : undefined}
      class="group/session relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[6px] pl-2 pr-1 text-[12px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover data-[active]:bg-v2-overlay-simple-overlay-pressed data-[active]:text-v2-text-text-base"
    >
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={props.onOpen}
      >
        <Show when={avatar.unread()}>
          <span
            data-slot="nav-sidebar-session-unread"
            class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-accent"
            aria-label={language.t("navSidebar.session.unread")}
          />
        </Show>
        <span class="min-w-0 flex-1 truncate">{sessionLabel(props.session)}</span>
        <span class="shrink-0 text-[11px] text-v2-text-text-faint group-hover/session:hidden">
          {getRelativeTime(
            new Date(props.session.time.updated ?? props.session.time.created).toISOString(),
            language.t,
          )}
        </span>
      </button>
      <div
        class="hidden shrink-0 group-hover/session:flex"
        classList={{ "!flex": menuOpen() }}
      >
        <Menu gutter={4} modal={false} placement="bottom-end" open={menuOpen()} onOpenChange={setMenuOpen}>
          <Menu.Trigger
            as={IconButton}
            data-action="nav-sidebar-session-menu"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="outline-dots" />}
            aria-label={language.t("common.moreOptions")}
          />
          <Menu.Portal>
            <Menu.Content>
              <Menu.Item onSelect={showRename}>{language.t("common.rename")}</Menu.Item>
              <Menu.Item onSelect={() => void props.onExport()}>{language.t("command.session.export")}</Menu.Item>
              <Menu.Separator />
              <Menu.Item onSelect={showDelete}>{language.t("session.delete.title")}</Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </div>
    </div>
  )
}
