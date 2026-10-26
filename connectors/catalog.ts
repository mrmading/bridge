/**
 * The pre-listed connectors. Every URL and auth method below was checked against the vendor's own
 * docs on 2026-10-27 (`verified`); where a detail could not be confirmed it says so in `note`.
 *
 * auth:
 *   "oauth"  the server does MCP OAuth with dynamic client registration; Bridge runs that flow itself
 *   "token"  a static secret sent as a header (a PAT, an API key)
 *   "none"   public, nothing to sign in to
 * A connector can offer several; the first is the default in the UI.
 */
export type CatalogParam = { key: string; label: string; placeholder?: string; help?: string; required?: boolean };
export type CatalogEntry = {
  id: string;
  name: string;
  blurb: string;
  url: string;
  transport: "http";
  auth: ("oauth" | "token" | "none" | "device")[];
  token?: { header: string; prefix: string; label: string; help: string; placeholder?: string; basic?: boolean };
  /** optional query parameters appended to the URL (Supabase project_ref, PostHog project_id…) */
  params?: CatalogParam[];
  docs: string;
  verified: boolean;
  note?: string;
  /** "available" works from Bridge today; "limited" needs something only the vendor can grant */
  availability: "available" | "limited";
  color: string;
  glyph: string;
};

export const CATALOG: CatalogEntry[] = [
  {
    id: "github", name: "GitHub", blurb: "Repos, issues, pull requests, Actions and code search.",
    url: "https://api.githubcopilot.com/mcp/", transport: "http", auth: ["token", "device"],
    token: { header: "Authorization", prefix: "Bearer ", label: "Personal access token", placeholder: "github_pat_…", help: "https://github.com/settings/personal-access-tokens/new" },
    docs: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md", verified: true, availability: "available",
    note: "GitHub's OAuth has no dynamic client registration, so sign-in is a fine-grained token, or the device flow when this Bridge has a GitHub OAuth App (BRIDGE_GITHUB_CLIENT_ID).",
    color: "#e6edf3", glyph: "GH",
  },
  {
    id: "linear", name: "Linear", blurb: "Issues, projects, cycles and comments.",
    url: "https://mcp.linear.app/mcp", transport: "http", auth: ["oauth", "token"],
    token: { header: "Authorization", prefix: "Bearer ", label: "API key", placeholder: "lin_api_…", help: "https://linear.app/settings/account/security" },
    docs: "https://linear.app/docs/mcp", verified: true, availability: "available", color: "#5e6ad2", glyph: "Li",
  },
  {
    id: "notion", name: "Notion", blurb: "Search, read and write pages and databases.",
    url: "https://mcp.notion.com/mcp", transport: "http", auth: ["oauth", "token"],
    token: { header: "Authorization", prefix: "Bearer ", label: "MCP token (Business and Enterprise plans)", help: "https://developers.notion.com/docs/get-started-with-mcp" },
    docs: "https://developers.notion.com/docs/get-started-with-mcp", verified: true, availability: "available", color: "#ffffff", glyph: "N",
  },
  {
    id: "supabase", name: "Supabase", blurb: "Tables, SQL, migrations, edge functions, logs and docs.",
    url: "https://mcp.supabase.com/mcp", transport: "http", auth: ["oauth", "token"],
    token: { header: "Authorization", prefix: "Bearer ", label: "Personal access token", placeholder: "sbp_…", help: "https://supabase.com/dashboard/account/tokens" },
    params: [
      { key: "project_ref", label: "Project ref", placeholder: "abcdefghijklmnop", help: "Scope to one project (recommended)" },
      { key: "read_only", label: "Read only", placeholder: "true", help: "true keeps it from changing anything" },
    ],
    docs: "https://supabase.com/docs/guides/getting-started/mcp", verified: true, availability: "available", color: "#3ecf8e", glyph: "Sb",
  },
  {
    id: "stripe", name: "Stripe", blurb: "Customers, payments, invoices, subscriptions and docs.",
    url: "https://mcp.stripe.com", transport: "http", auth: ["oauth", "token"],
    token: { header: "Authorization", prefix: "Bearer ", label: "Agent API key (restricted key with the Agent tag)", placeholder: "rk_…", help: "https://dashboard.stripe.com/apikeys" },
    docs: "https://docs.stripe.com/mcp", verified: true, availability: "available", color: "#635bff", glyph: "S",
    note: "From 30 Nov 2026 plain secret and untagged restricted keys get 401: use an agent key or OAuth. Prefer a test-mode key.",
  },
  {
    id: "cloudflare", name: "Cloudflare", blurb: "Workers, DNS, R2, D1, KV and the whole Cloudflare API.",
    url: "https://mcp.cloudflare.com/mcp", transport: "http", auth: ["oauth", "token"],
    token: { header: "Authorization", prefix: "Bearer ", label: "API token", help: "https://dash.cloudflare.com/profile/api-tokens" },
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/", verified: true, availability: "available", color: "#f38020", glyph: "CF",
  },
  {
    id: "cloudflare-docs", name: "Cloudflare Docs", blurb: "Search Cloudflare's documentation. No sign-in.",
    url: "https://docs.mcp.cloudflare.com/mcp", transport: "http", auth: ["none"],
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/", verified: true, availability: "available", color: "#f38020", glyph: "CD",
  },
  {
    id: "posthog", name: "PostHog", blurb: "Insights, feature flags, experiments, errors and SQL.",
    url: "https://mcp.posthog.com/mcp", transport: "http", auth: ["oauth", "token"],
    token: { header: "Authorization", prefix: "Bearer ", label: "Personal API key (MCP preset)", placeholder: "phx_…", help: "https://app.posthog.com/settings/user-api-keys?preset=mcp_server" },
    params: [{ key: "project_id", label: "Project id", placeholder: "12345", help: "Pin one project" }],
    docs: "https://posthog.com/docs/model-context-protocol", verified: true, availability: "available", color: "#f9bd2b", glyph: "PH",
  },
  {
    id: "sentry", name: "Sentry", blurb: "Issues, errors, traces and releases.",
    url: "https://mcp.sentry.dev/mcp", transport: "http", auth: ["oauth"],
    docs: "https://mcp.sentry.dev", verified: true, availability: "available", color: "#a78bfa", glyph: "Se",
  },
  {
    id: "atlassian", name: "Jira & Confluence", blurb: "Atlassian Rovo: Jira issues and Confluence pages.",
    url: "https://mcp.atlassian.com/v2/mcp", transport: "http", auth: ["oauth", "token"],
    token: { header: "Authorization", prefix: "Basic ", basic: true, label: "email:API token (your admin must allow token access)", placeholder: "you@company.com:ATATT…", help: "https://id.atlassian.com/manage-profile/security/api-tokens" },
    docs: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/authentication-and-authorization/", verified: true, availability: "available", color: "#2684ff", glyph: "At",
  },
  {
    id: "context7", name: "Context7", blurb: "Up-to-date library and framework docs. No sign-in.",
    url: "https://mcp.context7.com/mcp", transport: "http", auth: ["none", "token"],
    token: { header: "Authorization", prefix: "Bearer ", label: "API key (optional, higher limits)", help: "https://context7.com/dashboard" },
    docs: "https://github.com/upstash/context7", verified: true, availability: "available", color: "#10b981", glyph: "C7",
  },
  {
    id: "deepwiki", name: "DeepWiki", blurb: "Ask questions about any public GitHub repo. No sign-in.",
    url: "https://mcp.deepwiki.com/mcp", transport: "http", auth: ["none"],
    docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp", verified: true, availability: "available", color: "#38bdf8", glyph: "DW",
  },
  {
    id: "vercel", name: "Vercel", blurb: "Projects, deployments and logs.",
    url: "https://mcp.vercel.com", transport: "http", auth: ["oauth"],
    docs: "https://vercel.com/docs/agent-resources/vercel-mcp", verified: true, availability: "limited", color: "#ffffff", glyph: "▲",
    note: "OAuth only for clients on Vercel's approved list. Bridge registers as its own client, which Vercel may refuse.",
  },
  {
    id: "slack", name: "Slack", blurb: "Search messages, read channels, post.",
    url: "https://mcp.slack.com/mcp", transport: "http", auth: ["oauth"],
    docs: "https://docs.slack.dev/ai/mcp-server", verified: true, availability: "limited",
    note: "Slack's server only accepts OAuth from a registered Slack app (no dynamic registration). Use Slack from Claude.ai, or build a connector on the Slack Web API with a bot token below.",
    color: "#e01e5a", glyph: "Sl",
  },
  {
    id: "google", name: "Gmail & Google Drive", blurb: "Google's Workspace MCP servers (developer preview).",
    url: "https://gmailmcp.googleapis.com/mcp/v1", transport: "http", auth: ["oauth"],
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers", verified: true, availability: "limited",
    note: "Developer preview: needs the Workspace Developer Preview Program and your own Google Cloud OAuth client. Drive is https://drivemcp.googleapis.com/mcp/v1.",
    color: "#4285f4", glyph: "G",
  },
];

export const catalogEntry = (id: string) => CATALOG.find((c) => c.id === id);
