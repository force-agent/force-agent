import { Argument, Flag, GlobalFlag } from "effect/unstable/cli"
import { Schema } from "effect"
import { Spec } from "../framework/spec"

export const PrintLogs = GlobalFlag.setting("print-logs")({
  flag: Flag.boolean("print-logs").pipe(
    Flag.withDescription("Print logs to stderr (server logs require --standalone)"),
    Flag.withDefault(false),
  ),
})

declare const OPENCODE_CLI_NAME: string | undefined

const ServerParams = {
  standalone: Flag.boolean("standalone").pipe(
    Flag.withDescription("Run with a private server instead of the background service"),
    Flag.withDefault(false),
  ),
  server: Flag.string("server").pipe(
    Flag.withDescription("Connect to a server URL instead of the background service"),
    Flag.optional,
  ),
}

const PermissionParams = {
  auto: Flag.boolean("auto").pipe(
    Flag.withDescription("Auto-approve permissions that are not explicitly denied"),
    Flag.withDefault(false),
  ),
  yolo: Flag.boolean("yolo").pipe(Flag.withDefault(false), Flag.withHidden),
  dangerouslySkipPermissions: Flag.boolean("dangerously-skip-permissions").pipe(
    Flag.withDefault(false),
    Flag.withHidden,
  ),
}

const Root = Spec.make(typeof OPENCODE_CLI_NAME === "string" ? OPENCODE_CLI_NAME : "opencode", {
  description: "force agent — agente de codigo com servidor e UI no navegador",
  params: {
    ...ServerParams,
    ...PermissionParams,
    directory: Argument.string("directory").pipe(
      Argument.withDescription("Directory to start force in"),
      Argument.optional,
    ),
    continue: Flag.boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("Continue the last session"),
      Flag.withDefault(false),
    ),
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Session ID to continue"),
      Flag.optional,
    ),
    prompt: Flag.string("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
  },
  commands: [
    Spec.make("acp", { description: "Start an Agent Client Protocol server" }),
    Spec.make("api", {
      description: "Make a request to the running server",
      params: {
        ...ServerParams,
        request: Argument.string("operation | method path").pipe(
          Argument.withDescription("OpenAPI operation ID, or an HTTP method followed by a path"),
          Argument.variadic({ min: 1, max: 2 }),
        ),
        data: Flag.string("data").pipe(Flag.withAlias("d"), Flag.withDescription("Request body"), Flag.optional),
        header: Flag.string("header").pipe(
          Flag.withAlias("H"),
          Flag.withDescription("Request header in name:value form"),
          Flag.atMost(100),
        ),
        param: Flag.keyValuePair("param").pipe(Flag.withDescription("OpenAPI path or query parameter"), Flag.optional),
      },
    }),
    Spec.make("debug", {
      description: "Debugging and troubleshooting tools",
      commands: [
        Spec.make("agents", { description: "List all agents" }),
        Spec.make("config", { description: "List configuration sources" }),
        Spec.make("paths", { description: "Show global paths (data, config, cache, state)" }),
      ],
    }),
    Spec.make("console", {
      description: "Manage OpenCode Console access",
      commands: [
        Spec.make("login", {
          description: "Log in to OpenCode Console",
          params: {
            url: Argument.string("url").pipe(Argument.withDescription("Console server URL"), Argument.optional),
          },
        }),
      ],
    }),
    Spec.make("auth", {
      description: "manage AI providers and credentials",
      commands: [
        Spec.make("list", {
          description: "list providers and credentials",
          params: {
            ...ServerParams,
            format: Flag.choice("format", ["default", "json"]).pipe(
              Flag.withDescription("Output format"),
              Flag.withDefault("default"),
            ),
          },
        }),
        Spec.make("login", {
          description: "log in to a provider",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID, name, or well-known provider URL"),
              Argument.optional,
            ),
            method: Flag.string("method").pipe(Flag.withDescription("Authentication method ID"), Flag.optional),
          },
        }),
        Spec.make("logout", {
          description: "log out from a configured provider",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("mcp", {
      description: "Manage MCP (Model Context Protocol) servers",
      commands: [
        Spec.make("list", { description: "List configured MCP servers and their status" }),
        Spec.make("add", {
          description: "Add an MCP server to your configuration",
          params: {
            name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server")),
            command: Argument.string("command").pipe(
              Argument.withDescription("Command and arguments for a local server, passed after --"),
              Argument.variadic({ min: 0 }),
            ),
            url: Flag.string("url").pipe(Flag.withDescription("URL for a remote MCP server"), Flag.optional),
            header: Flag.keyValuePair("header").pipe(
              Flag.withDescription("HTTP header for a remote server, as name=value"),
              Flag.optional,
            ),
            env: Flag.keyValuePair("env").pipe(
              Flag.withDescription("Environment variable for a local server, as name=value"),
              Flag.optional,
            ),
            global: Flag.boolean("global").pipe(
              Flag.withDescription("Write to the global config instead of the project config"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("auth", {
          description: "Authenticate with an OAuth-capable remote MCP server",
          params: { name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server")) },
        }),
        Spec.make("logout", {
          description: "Remove stored OAuth credentials for an MCP server",
          params: { name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server")) },
        }),
      ],
    }),
    Spec.make("browser", {
      description: "Drive the shared agent browser",
      commands: [
        Spec.make("status", {
          description: "Show tabs and who controls the browser",
          params: { json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)) },
        }),
        Spec.make("navigate", {
          description: "Open a URL and print a short snapshot",
          params: {
            url: Argument.string("url").pipe(Argument.withDescription("URL to open")),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id (default: active tab)"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("snapshot", {
          description: "Print the accessibility tree with refs",
          params: {
            mode: Flag.choice("mode", ["full", "interactive", "diff"]).pipe(
              Flag.withDescription("Tree mode"),
              Flag.withDefault("full"),
            ),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id (default: active tab)"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("act", {
          description: "Act on an element ref: click, type, press, select, scroll, hover, upload",
          params: {
            action: Argument.string("action").pipe(
              Argument.withDescription("click|type|press|select|scroll|hover|upload"),
            ),
            ref: Argument.string("ref").pipe(Argument.withDescription("Element ref, e.g. e12"), Argument.optional),
            text: Flag.string("text").pipe(Flag.withDescription("Text for type"), Flag.optional),
            key: Flag.string("key").pipe(Flag.withDescription("Key for press, e.g. Enter"), Flag.optional),
            value: Flag.string("value").pipe(Flag.withDescription("Option for select"), Flag.optional),
            file: Flag.string("file").pipe(Flag.withDescription("File for upload"), Flag.atMost(20)),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id (default: active tab)"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("read", {
          description: "Print the page as markdown",
          params: {
            selector: Flag.string("selector").pipe(Flag.withDescription("CSS selector (default: main)"), Flag.optional),
            page: Flag.integer("page").pipe(Flag.withDescription("Page number"), Flag.optional),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id (default: active tab)"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("screenshot", {
          description: "Save a JPEG screenshot",
          params: {
            out: Flag.string("out").pipe(Flag.withDescription("Output path (default: screenshot.jpg)"), Flag.optional),
            fullPage: Flag.boolean("full-page").pipe(
              Flag.withDescription("Capture the whole page"),
              Flag.withDefault(false),
            ),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id (default: active tab)"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("tabs", {
          description: "List, open, close or activate tabs",
          params: {
            op: Argument.string("op").pipe(Argument.withDescription("list|open|close|activate"), Argument.optional),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id for close/activate"), Flag.optional),
            url: Flag.string("url").pipe(Flag.withDescription("URL for open"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("control", {
          description: "Take, hand over or release control of the browser",
          params: {
            owner: Argument.string("owner").pipe(Argument.withDescription("human|agent|release")),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("network", {
          description: "List requests the tab has made; --body <id> prints one response body",
          params: {
            host: Flag.string("host").pipe(Flag.withDescription("Only hosts containing this"), Flag.optional),
            path: Flag.string("path").pipe(Flag.withDescription("Only paths containing this"), Flag.optional),
            xhr: Flag.boolean("xhr").pipe(Flag.withDescription("Only XHR/fetch requests"), Flag.withDefault(false)),
            since: Flag.integer("since").pipe(Flag.withDescription("Only after this Unix time (ms)"), Flag.optional),
            limit: Flag.integer("limit").pipe(Flag.withDescription("Max entries (default 50)"), Flag.optional),
            body: Flag.string("body").pipe(Flag.withDescription("Entry id whose response body to print"), Flag.optional),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id (default: active tab)"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("fetch", {
          description: "Run fetch(url) inside the page, with its cookies",
          params: {
            url: Argument.string("url").pipe(Argument.withDescription("Absolute or page-relative URL")),
            method: Flag.string("method").pipe(Flag.withDescription("HTTP method (default GET)"), Flag.optional),
            header: Flag.string("header").pipe(Flag.withDescription("Header as 'Name: value'"), Flag.atMost(20)),
            body: Flag.string("body").pipe(Flag.withDescription("Request body"), Flag.optional),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id (default: active tab)"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("eval", {
          description: "Evaluate JavaScript in the page and print the result as JSON",
          params: {
            expression: Argument.string("expression").pipe(Argument.withDescription("JavaScript to evaluate")),
            tab: Flag.string("tab").pipe(Flag.withDescription("Tab id (default: active tab)"), Flag.optional),
            json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)),
          },
        }),
        Spec.make("install", {
          description: "Download a Chromium build with playwright-core (opt-in)",
          params: {
            yes: Flag.boolean("yes").pipe(
              Flag.withAlias("y"),
              Flag.withDescription("Skip confirmation"),
              Flag.withDefault(false),
            ),
          },
        }),
      ],
    }),
    Spec.make("plugin", {
      description: "Manage plugins",
      commands: [
        Spec.make("list", {
          description: "List plugins",
          params: {
            builtin: Flag.boolean("builtin").pipe(
              Flag.withDescription("Include built-in server plugins"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("add", {
          description: "Install a plugin and add it to the global configuration",
          params: {
            package: Argument.string("package").pipe(Argument.withDescription("npm registry or Git package specifier")),
          },
        }),
        Spec.make("remove", {
          description: "Remove a plugin from global configuration",
          params: {
            package: Argument.string("package").pipe(Argument.withDescription("configured package specifier")),
          },
        }),
      ],
    }),
    Spec.make("models", {
      description: "List all available models",
      params: ServerParams,
    }),
    Spec.make("stats", {
      description: "Show shareable usage statistics",
      params: {
        ...ServerParams,
        days: Flag.integer("days").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          Flag.withDescription("Show the last N days; 0 means today"),
          Flag.optional,
        ),
        year: Flag.integer("year").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1970, maximum: 9_999 }))),
          Flag.withDescription("Show a calendar year"),
          Flag.optional,
        ),
        all: Flag.boolean("all").pipe(Flag.withDescription("Show lifetime statistics"), Flag.withDefault(false)),
        project: Flag.string("project").pipe(
          Flag.withDescription('Filter by project ID, or use "." for the current project'),
          Flag.optional,
        ),
        models: Flag.boolean("models").pipe(Flag.withDescription("Show model usage"), Flag.withDefault(false)),
        tools: Flag.boolean("tools").pipe(Flag.withDescription("Show tool reliability"), Flag.withDefault(false)),
        cost: Flag.boolean("cost").pipe(Flag.withDescription("Show cost and token details"), Flag.withDefault(false)),
        full: Flag.boolean("full").pipe(Flag.withDescription("Show every detailed section"), Flag.withDefault(false)),
        limit: Flag.integer("limit").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          Flag.withDescription("Number of rows in detailed sections"),
          Flag.withDefault(5),
        ),
        json: Flag.boolean("json").pipe(Flag.withDescription("Output statistics as JSON"), Flag.withDefault(false)),
      },
    }),
    Spec.make("export", {
      description: "Export session data as JSON",
      params: {
        ...ServerParams,
        session: Argument.string("session").pipe(Argument.withDescription("Session ID to export"), Argument.optional),
        sanitize: Flag.boolean("sanitize").pipe(
          Flag.withDescription("Redact sensitive transcript and file data"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("import", {
      description: "Import session data from a JSON file or URL",
      params: {
        ...ServerParams,
        file: Argument.string("file").pipe(Argument.withDescription("JSON file or URL to import")),
        directory: Flag.string("directory").pipe(
          Flag.withDescription("Directory in which to import the session"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("mini", {
      description: "Start the minimal interactive interface",
      params: {
        ...ServerParams,
        continue: Flag.boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.string("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue"),
          Flag.optional,
        ),
        fork: Flag.boolean("fork").pipe(
          Flag.withDescription("Fork the session when continuing"),
          Flag.withDefault(false),
        ),
        replay: Flag.boolean("replay").pipe(
          Flag.withDescription("Restore session history on resume and resize (disable with --no-replay)"),
          Flag.optional,
        ),
        replayLimit: Flag.integer("replay-limit").pipe(
          Flag.withDescription("Limit replay to the newest N messages (default: 200)"),
          Flag.optional,
        ),
        model: Flag.string("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model"),
          Flag.optional,
        ),
        agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        prompt: Flag.string("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
        demo: Flag.boolean("demo").pipe(Flag.withDefault(false), Flag.withHidden),
      },
    }),
    Spec.make("run", {
      description: "Run force with a message",
      params: {
        ...ServerParams,
        message: Argument.string("message").pipe(
          Argument.withDescription("Message to send"),
          Argument.variadic({ min: 0 }),
        ),
        continue: Flag.boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.string("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue"),
          Flag.optional,
        ),
        fork: Flag.boolean("fork").pipe(
          Flag.withDescription("Fork the session before continuing"),
          Flag.withDefault(false),
        ),
        model: Flag.string("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model#variant"),
          Flag.optional,
        ),
        agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        format: Flag.choice("format", ["default", "json"]).pipe(
          Flag.withDescription("Output format"),
          Flag.withDefault("default"),
        ),
        file: Flag.string("file").pipe(
          Flag.withAlias("f"),
          Flag.withDescription("File to attach to the message"),
          Flag.atMost(100),
        ),
        title: Flag.string("title").pipe(Flag.withDescription("Session title"), Flag.optional),
        thinking: Flag.boolean("thinking").pipe(Flag.withDescription("Show thinking blocks"), Flag.withDefault(false)),
        ...PermissionParams,
      },
    }),
    Spec.make("service", {
      description: "Manage the background server",
      commands: [
        Spec.make("start", { description: "Start the background server" }),
        Spec.make("restart", { description: "Restart the background server" }),
        Spec.make("status", { description: "Show background server status" }),
        Spec.make("stop", { description: "Stop the background server" }),
        Spec.make("get", {
          description: "Get service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env"), Argument.optional),
            name: Argument.string("name").pipe(
              Argument.withDescription("Environment variable name"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("set", {
          description: "Set service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env")),
            value: Argument.string("value").pipe(
              Argument.withDescription("Setting value or environment variable name"),
            ),
            nestedValue: Argument.string("env-value").pipe(
              Argument.withDescription("Environment variable value"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("unset", {
          description: "Unset service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env")),
            name: Argument.string("name").pipe(
              Argument.withDescription("Environment variable name"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("pair", { description: "Show server pairing information" }),
    Spec.make("serve", {
      description: "Start the v2 API and web server",
      params: {
        hostname: Flag.string("hostname").pipe(Flag.optional),
        port: Flag.integer("port").pipe(Flag.optional),
        service: Flag.boolean("service").pipe(Flag.withDefault(false)),
        stdio: Flag.boolean("stdio").pipe(Flag.withDefault(false)),
        showCredentials: Flag.boolean("show-credentials").pipe(
          Flag.withDescription("Print the generated password even when stdout is not a terminal"),
          Flag.withDefault(false),
        ),
      },
    }),
    // force-agent overlay: `serve` prints a listen line for a client operator. `web` runs the
    // same server and prints what a person opening a browser needs — the reachable URLs and
    // the credential the embedded UI demands.
    Spec.make("web", {
      description: "Start the server and print how to open the web UI in a browser",
      params: {
        hostname: Flag.string("hostname").pipe(
          Flag.withDescription("Interface to bind; a reachable one requires LABHARNESS_PASSWORD"),
          Flag.optional,
        ),
        port: Flag.integer("port").pipe(
          Flag.withDescription("Port to bind; defaults to the first free port from 4096"),
          Flag.optional,
        ),
        showCredentials: Flag.boolean("show-credentials").pipe(
          Flag.withDescription("Print the password and auth token even when stdout is not a terminal"),
          Flag.withDefault(false),
        ),
      },
    }),
  ],
})

export const Commands = Root
