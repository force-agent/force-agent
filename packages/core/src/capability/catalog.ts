export * as CapabilityCatalog from "./catalog.js"

/**
 * Declarative product catalog. Detection composes three channels per product:
 * - `mcpMatch` is tested against the MCP server name, every token of a local `command`, and the host
 *   of a remote `url` (strings are case-insensitive substrings, RegExps are tested as-is).
 * - `envKeys` are exact environment variable names; `integrationID` links a stored credential.
 * - `binaries` are the only executables ever probed with `which` (never a PATH scan).
 */
export interface Product {
  readonly id: string
  readonly name: string
  readonly mcpMatch: readonly (RegExp | string)[]
  readonly envKeys: readonly string[]
  readonly integrationID?: string
  readonly binaries: readonly string[]
  readonly hosts: readonly string[]
}

export const products: readonly Product[] = [
  {
    id: "posthog",
    name: "PostHog",
    mcpMatch: ["posthog"],
    envKeys: ["POSTHOG_API_KEY", "POSTHOG_PERSONAL_API_KEY"],
    binaries: ["posthog"],
    hosts: ["posthog.com", "us.posthog.com", "eu.posthog.com", "us.i.posthog.com", "eu.i.posthog.com"],
  },
  {
    id: "github",
    name: "GitHub",
    mcpMatch: ["github"],
    envKeys: ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"],
    binaries: ["gh"],
    hosts: ["github.com", "api.github.com"],
  },
  {
    id: "supabase",
    name: "Supabase",
    mcpMatch: ["supabase"],
    envKeys: ["SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"],
    binaries: ["supabase"],
    hosts: ["supabase.com", "supabase.co"],
  },
  {
    id: "vercel",
    name: "Vercel",
    mcpMatch: ["vercel"],
    envKeys: ["VERCEL_TOKEN", "VERCEL_API_TOKEN"],
    binaries: ["vercel"],
    hosts: ["vercel.com", "api.vercel.com"],
  },
  {
    id: "stripe",
    name: "Stripe",
    mcpMatch: ["stripe"],
    envKeys: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"],
    binaries: ["stripe"],
    hosts: ["stripe.com", "api.stripe.com"],
  },
  {
    id: "tavily",
    name: "Tavily",
    mcpMatch: ["tavily"],
    envKeys: ["TAVILY_API_KEY"],
    binaries: [],
    hosts: ["tavily.com", "api.tavily.com"],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    mcpMatch: ["firecrawl"],
    envKeys: ["FIRECRAWL_API_KEY"],
    binaries: ["firecrawl"],
    hosts: ["firecrawl.dev", "api.firecrawl.dev"],
  },
  {
    id: "exa",
    name: "Exa",
    mcpMatch: [/(^|[^a-z])exa([^a-z]|$)/i],
    envKeys: ["EXA_API_KEY"],
    binaries: [],
    hosts: ["exa.ai", "api.exa.ai"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    mcpMatch: ["cloudflare", "wrangler"],
    envKeys: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN"],
    binaries: ["wrangler"],
    hosts: ["cloudflare.com", "api.cloudflare.com"],
  },
  {
    id: "openai",
    name: "OpenAI",
    mcpMatch: ["openai"],
    envKeys: ["OPENAI_API_KEY"],
    integrationID: "openai",
    binaries: ["codex"],
    hosts: ["openai.com", "api.openai.com"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    mcpMatch: ["anthropic"],
    envKeys: ["ANTHROPIC_API_KEY"],
    integrationID: "anthropic",
    binaries: ["claude"],
    hosts: ["anthropic.com", "api.anthropic.com"],
  },
  {
    id: "google",
    name: "Google",
    mcpMatch: ["google", "gemini"],
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    integrationID: "google",
    binaries: ["gcloud", "gemini"],
    hosts: ["googleapis.com", "generativelanguage.googleapis.com"],
  },
  {
    id: "slack",
    name: "Slack",
    mcpMatch: ["slack"],
    envKeys: ["SLACK_BOT_TOKEN", "SLACK_TOKEN", "SLACK_API_TOKEN"],
    binaries: [],
    hosts: ["slack.com", "api.slack.com"],
  },
  {
    id: "discord",
    name: "Discord",
    mcpMatch: ["discord"],
    envKeys: ["DISCORD_BOT_TOKEN", "DISCORD_TOKEN"],
    binaries: [],
    hosts: ["discord.com", "discord.gg"],
  },
  {
    id: "notion",
    name: "Notion",
    mcpMatch: ["notion"],
    envKeys: ["NOTION_API_KEY", "NOTION_TOKEN"],
    binaries: [],
    hosts: ["notion.so", "api.notion.com"],
  },
  {
    id: "linear",
    name: "Linear",
    mcpMatch: ["linear"],
    envKeys: ["LINEAR_API_KEY"],
    binaries: [],
    hosts: ["linear.app", "api.linear.app"],
  },
  {
    id: "sentry",
    name: "Sentry",
    mcpMatch: ["sentry"],
    envKeys: ["SENTRY_AUTH_TOKEN", "SENTRY_DSN"],
    binaries: ["sentry-cli"],
    hosts: ["sentry.io"],
  },
  {
    id: "aws",
    name: "AWS",
    mcpMatch: [/(^|[^a-z])aws([^a-z]|$)/i, "awslabs"],
    envKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    binaries: ["aws"],
    hosts: ["amazonaws.com"],
  },
  {
    id: "docker",
    name: "Docker",
    mcpMatch: ["docker"],
    envKeys: ["DOCKER_HUB_TOKEN"],
    binaries: ["docker"],
    hosts: ["hub.docker.com"],
  },
  {
    id: "playwright",
    name: "Playwright",
    mcpMatch: ["playwright"],
    envKeys: [],
    binaries: ["playwright"],
    hosts: [],
  },
]

export const byID = new Map(products.map((product) => [product.id, product]))

export function matchesMcp(product: Product, candidates: readonly string[]) {
  return product.mcpMatch.some((matcher) =>
    candidates.some((candidate) =>
      typeof matcher === "string" ? candidate.toLowerCase().includes(matcher.toLowerCase()) : matcher.test(candidate),
    ),
  )
}
