import { createEffect, createMemo, on } from "solid-js"
import type { UpdaterState } from "./types"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import { formatServerError } from "@/runtime/server/errors"
import { WebUpdateTimeoutError } from "@/runtime/platform/web-updater"

export function updaterAction(state: UpdaterState | undefined) {
  if (!state) return { label: "settings.updates.action.checkNow" as const }
  switch (state.status) {
    case "checking":
      return { label: "settings.updates.action.checking" as const }
    case "downloading":
      return { label: "settings.updates.action.downloading" as const }
    case "ready":
      return { label: "toast.update.action.installRestart" as const, run: "install" as const }
    case "installing":
      return { label: "settings.updates.action.installing" as const }
    case "restarting":
      return { label: "settings.updates.action.restarting" as const }
    case "manual":
      return { label: "toast.update.action.installRestart" as const, run: "manual" as const }
    case "disabled":
      return { label: "settings.updates.action.checkNow" as const }
    default:
      return { label: "settings.updates.action.checkNow" as const, run: "check" as const }
  }
}

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))

  return {
    action,
    async run() {
      const run = action().run
      if (run === "install") {
        return platform.updater?.install().catch((error) => {
          if (error instanceof WebUpdateTimeoutError) {
            showToast({
              title: language.t("settings.updates.toast.timeout.title", { version: error.version }),
              description: error.command
                ? language.t("settings.updates.toast.manual.description", { command: error.command })
                : language.t("settings.updates.toast.timeout.description"),
            })
            return
          }
          showToast({
            title: language.t("common.requestFailed"),
            description: formatServerError(error, language.t, language.t("common.requestFailed")),
          })
        })
      }
      if (run === "manual") {
        const state = platform.updater?.state()
        if (state?.status !== "manual") return
        showToast({
          title: language.t("settings.updates.toast.manual.title", { version: state.version }),
          description: state.command
            ? language.t("settings.updates.toast.manual.description", { command: state.command })
            : language.t("settings.updates.toast.manual.noCommand"),
        })
        return
      }
      if (run !== "check") return

      const state = await platform.updater?.check()
      if (state?.status === "up-to-date") {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.updates.toast.latest.title"),
          description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
        })
      }
      if (state?.status === "error") {
        showToast({ title: language.t("common.requestFailed"), description: state.message })
      }
    },
  }
}

/**
 * One toast per phase of a self-update, wherever it was started from (nav button, Settings).
 * Mount once in the shell; the page reloads by itself when the new server is up.
 */
export function useUpdaterToasts() {
  const platform = usePlatform()
  const language = useLanguage()
  createEffect(
    on(
      () => platform.updater?.state(),
      (state, previous) => {
        if (!state || state.status === previous?.status) return
        if (state.status === "installing") {
          showToast({
            icon: "arrow-down-to-line",
            title: language.t("settings.updates.toast.installing.title", { version: state.version }),
            description: language.t("settings.updates.toast.installing.description"),
          })
        }
        if (state.status === "restarting") {
          showToast({
            icon: "arrow-down-to-line",
            title: language.t("settings.updates.toast.restarting.title", { version: state.version }),
            description: language.t("settings.updates.toast.restarting.description"),
          })
        }
      },
    ),
  )
}
