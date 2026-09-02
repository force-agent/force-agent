// @refresh reload

import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { loadInitialLocale } from "@/runtime/i18n/language"
import { PlatformProvider } from "@/runtime/platform/platform"
import { createWebPlatform } from "@/runtime/platform/web"
import en from "@/runtime/i18n/en"
import zh from "@/runtime/i18n/zh"
import { authFromToken } from "@/runtime/server/api"
import pkg from "../package.json"
import { ServerConnection } from "@/runtime/server/registry"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const STARTUP_TOKEN_KEY = "force.web.auth_token"

function readStartupToken(): string | null {
  try {
    return sessionStorage.getItem(STARTUP_TOKEN_KEY)
  } catch {
    return null
  }
}

function writeStartupToken(token: string) {
  try {
    sessionStorage.setItem(STARTUP_TOKEN_KEY, token)
  } catch {}
}

// The updater talks to the server outside the API client, so it needs the same credential
// the page carries (the token is in sessionStorage by the time anyone clicks Update).
const web = createWebPlatform(pkg.version, { authorization: readStartupToken })

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"), { once: true })
}

if (import.meta.env.VITE_SENTRY_DSN) {
  void import("@sentry/solid").then(({ init }) =>
    init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
      release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
      initialScope: {
        tags: {
          platform: "web",
        },
      },
      integrations: (integrations) => {
        return integrations.filter(
          (i) =>
            i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
        )
      },
    }),
  )
}

if (root instanceof HTMLElement && root.dataset.opencodeMounted === undefined) {
  // Lazy chunks can import the entry chunk back under a distinct URL, so claim the root before async startup.
  root.dataset.opencodeMounted = ""
  void loadInitialLocale().then((locale) => {
    // The token arrives once in the URL and is scrubbed from it; keep it for this
    // tab so a reload (HMR, F5) does not drop the app into a 401 loop. sessionStorage
    // is per-tab and dies with it, which matches the lifetime of the URL it came from.
    const fromUrl = new URLSearchParams(location.search).get("auth_token")
    const auth = authFromToken(fromUrl ?? readStartupToken())
    if (fromUrl && auth) writeStartupToken(fromUrl)
    clearAuthToken()
    const server: ServerConnection.Http = {
      type: "http",
      authToken: !!auth,
      http: {
        url: web.currentServerUrl,
        ...auth,
      },
    }
    render(
      () => (
        <PlatformProvider value={web.platform}>
          <AppBaseProviders locale={locale}>
            <AppInterface
              defaultServer={ServerConnection.Key.make(web.defaultServerUrl)}
              canonicalLocalServer={ServerConnection.key(server)}
              servers={[server]}
            />
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root,
    )
  })
}
