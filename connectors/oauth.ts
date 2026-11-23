/**
 * MCP OAuth, done by Bridge rather than the CLI so it works the same on the Mac, on the sprite and
 * through the Worker, and so the grant sits in secrets.json with everything else:
 *   discover   the server's protected-resource metadata → its authorization server's metadata
 *   register   dynamic client registration (a public client, PKCE, no secret)
 *   authorize  the user signs in at the vendor; the vendor redirects to Bridge's callback page
 *   exchange   code + verifier → access/refresh token; refresh() renews it before a turn
 * Plus GitHub's device flow, which needs a GitHub OAuth App's client id (BRIDGE_GITHUB_CLIENT_ID)
 * because GitHub offers no dynamic registration.
 */
import { createHash, randomBytes } from "node:crypto";
import type { OAuthGrant } from "./store.ts";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const getJSON = async (u: string) => {
  const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(u + " → HTTP " + r.status);
  return r.json() as Promise<any>;
};

export type Discovery = {
  resource: string;
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes?: string[];
  device_authorization_endpoint?: string;
};

/** RFC 9728 + RFC 8414, following the MCP authorization spec's fallbacks */
export async function discover(mcpUrl: string): Promise<Discovery> {
  const u = new URL(mcpUrl);
  let prmUrl = "";
  try {
    const r = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge", version: "1" } } }), signal: AbortSignal.timeout(10_000) });
    const m = /resource_metadata="([^"]+)"/i.exec(r.headers.get("www-authenticate") || "");
    if (m) prmUrl = m[1];
    await r.body?.cancel().catch(() => {});
  } catch {}
  const path = u.pathname.replace(/\/+$/, "");
  const candidates = [prmUrl, u.origin + "/.well-known/oauth-protected-resource" + path, u.origin + "/.well-known/oauth-protected-resource"].filter(Boolean);
  let prm: any = null;
  for (const c of candidates) { try { prm = await getJSON(c); break; } catch {} }
  const as = new URL(prm?.authorization_servers?.[0] || u.origin);
  const asPath = as.pathname.replace(/\/+$/, "");
  const asCandidates = asPath
    ? [as.origin + "/.well-known/oauth-authorization-server" + asPath, as.origin + "/.well-known/openid-configuration" + asPath, as.origin + asPath + "/.well-known/openid-configuration"]
    : [as.origin + "/.well-known/oauth-authorization-server", as.origin + "/.well-known/openid-configuration"];
  let meta: any = null;
  for (const c of asCandidates) { try { meta = await getJSON(c); break; } catch {} }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new Error("This server does not publish OAuth metadata. Use a token instead.");
  return {
    resource: prm?.resource || mcpUrl, issuer: meta.issuer || as.origin,
    authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint, scopes: prm?.scopes_supported || undefined,
    device_authorization_endpoint: meta.device_authorization_endpoint,
  };
}

type Pending = { id: string; verifier: string; clientId: string; clientSecret?: string; tokenEndpoint: string; redirectUri: string; resource: string; at: number };
const pending = new Map<string, Pending>();
const sweep = () => { for (const [k, v] of pending) if (Date.now() - v.at > 20 * 60_000) pending.delete(k); };

/** The user's own OAuth app, for servers with no dynamic registration (Slack, Google): created at the vendor
 *  with Bridge's callback page as its redirect URL. */
export type OwnClient = { id: string; secret?: string };

/** needsClient: the server takes no self-registration and no app was given; the UI asks for one */
export async function startOAuth(id: string, mcpUrl: string, redirectUri: string, own?: OwnClient): Promise<{ authorizeUrl: string; state: string } | { needsClient: true; redirectUri: string; issuer: string }> {
  sweep();
  const d = await discover(mcpUrl);
  let client: { client_id: string; client_secret?: string };
  if (own?.id) client = { client_id: own.id, client_secret: own.secret || undefined };
  else if (!d.registration_endpoint) return { needsClient: true, redirectUri, issuer: d.issuer };
  else {
    const reg = await fetch(d.registration_endpoint, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ client_name: "Bridge", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (!reg.ok) throw new Error("Registering Bridge with the server failed: HTTP " + reg.status + " " + (await reg.text()).slice(0, 200));
    client = await reg.json();
  }
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(18));
  const a = new URL(d.authorization_endpoint);
  a.searchParams.set("response_type", "code");
  a.searchParams.set("client_id", client.client_id);
  a.searchParams.set("redirect_uri", redirectUri);
  a.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  a.searchParams.set("code_challenge_method", "S256");
  a.searchParams.set("state", state);
  a.searchParams.set("resource", d.resource);
  if (d.scopes?.length) a.searchParams.set("scope", d.scopes.join(" "));
  pending.set(state, { id, verifier, clientId: client.client_id, clientSecret: client.client_secret, tokenEndpoint: d.token_endpoint, redirectUri, resource: d.resource, at: Date.now() });
  return { authorizeUrl: a.toString(), state };
}

async function tokenCall(endpoint: string, form: Record<string, string>): Promise<any> {
  const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
  const t = await r.text();
  let j: any = {};
  try { j = JSON.parse(t); } catch { j = Object.fromEntries(new URLSearchParams(t)); }
  if (!r.ok || j.error) throw new Error("Sign-in failed: " + (j.error_description || j.error || "HTTP " + r.status));
  return j;
}

/** finish a sign-in from the callback's code + state; returns which connector it was for */
export async function finishOAuth(code: string, state: string): Promise<{ id: string; grant: OAuthGrant }> {
  const p = pending.get(state);
  if (!p) throw new Error("This sign-in link has expired or was already used. Start again from Connectors.");
  pending.delete(state);
  const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.resource };
  if (p.clientSecret) form.client_secret = p.clientSecret;
  const j = await tokenCall(p.tokenEndpoint, form);
  return { id: p.id, grant: grantFrom(j, { client_id: p.clientId, client_secret: p.clientSecret, token_endpoint: p.tokenEndpoint, resource: p.resource }) };
}

function grantFrom(raw: any, base: { client_id: string; client_secret?: string; token_endpoint: string; resource?: string; refresh_token?: string }): OAuthGrant {
  const j = raw.access_token ? raw : raw.authed_user?.access_token ? raw.authed_user : raw;
  if (!j.access_token) throw new Error("Sign-in failed: the server sent no access token");
  return {
    access_token: String(j.access_token), refresh_token: j.refresh_token || base.refresh_token, token_type: j.token_type, scope: j.scope,
    expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined,
    client_id: base.client_id, client_secret: base.client_secret, token_endpoint: base.token_endpoint, resource: base.resource,
  };
}

export async function refresh(g: OAuthGrant): Promise<OAuthGrant | null> {
  if (!g.refresh_token) return null;
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: g.refresh_token, client_id: g.client_id };
  if (g.client_secret) form.client_secret = g.client_secret;
  if (g.resource) form.resource = g.resource;
  const j = await tokenCall(g.token_endpoint, form);
  return grantFrom(j, g as any);
}

/* ── GitHub device flow ───────────────────────────────────────────── */
export const githubClientId = () => process.env.BRIDGE_GITHUB_CLIENT_ID || "";
type Device = { id: string; device_code: string; user_code: string; verification_uri: string; interval: number; expires: number; state: "waiting" | "done" | "error"; error?: string };
const devices = new Map<string, Device>();

export async function startDevice(id: string, onToken: (token: string) => Promise<void>): Promise<Device> {
  const client_id = githubClientId();
  if (!client_id) throw new Error("GitHub sign-in needs a GitHub OAuth App: set BRIDGE_GITHUB_CLIENT_ID on this Bridge, or paste a token.");
  const j = await tokenCall("https://github.com/login/device/code", { client_id, scope: "repo read:org read:user" });
  const d: Device = { id, device_code: j.device_code, user_code: j.user_code, verification_uri: j.verification_uri, interval: Number(j.interval || 5), expires: Date.now() + Number(j.expires_in || 900) * 1000, state: "waiting" };
  devices.set(id, d);
  (async () => {
    while (d.state === "waiting" && Date.now() < d.expires) {
      await Bun.sleep(d.interval * 1000);
      try {
        const r = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) });
        const t: any = await r.json();
        if (t.access_token) { await onToken(t.access_token); d.state = "done"; break; }
        if (t.error === "slow_down") d.interval += 5;
        else if (t.error && t.error !== "authorization_pending") { d.state = "error"; d.error = t.error_description || t.error; }
      } catch (e: any) { d.error = String(e?.message || e); }
    }
    if (d.state === "waiting") { d.state = "error"; d.error = "The code expired. Start again."; }
  })();
  return d;
}
export const deviceStatus = (id: string) => { const d = devices.get(id); return d ? { state: d.state, user_code: d.user_code, verification_uri: d.verification_uri, error: d.error } : null; };
