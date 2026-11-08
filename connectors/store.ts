/**
 * Connector state. Two files under BRIDGE_DATA/connectors/:
 *   connectors.json  what is connected, its status and tools, and the per-folder / per-chat switches
 *   secrets.json     tokens and OAuth grants, mode 600, read only by this process
 * Nothing secret ever leaves through publicList(): the API shows a masked hint of a token, and a
 * turn's --mcp-config refers to secrets as ${BRIDGE_CONN_<ID>} which the CLI expands from the
 * environment Bridge gives that one process.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { catalogEntry } from "./catalog.ts";
import { scaffoldServer, RUNTIME_SOURCE } from "./scaffold.ts";
import type { McpTool } from "./mcp-client.ts";

export type AuthKind = "none" | "token" | "oauth" | "device";
export type LocalAuth = "none" | "bearer" | "header" | "query" | "basic";
export type Connector = {
  id: string;
  name: string;
  kind: "remote" | "local";
  catalogId?: string;
  url?: string;
  auth: AuthKind;
  /** how a token is sent to a remote server */
  tokenHeader?: string;
  tokenPrefix?: string;
  local?: { mode: "api" | "words"; baseUrl?: string; authKind: LocalAuth; authName?: string; spec?: string; description?: string };
  enabled: boolean;
  status: "connected" | "needs-auth" | "error" | "untested" | "generating";
  error?: string;
  tools?: McpTool[];
  testedAt?: number;
  createdAt: number;
  gen?: { state: "running" | "done" | "error"; startedAt: number; endedAt?: number; log: string; cost?: number };
};
export type OAuthGrant = {
  access_token: string; refresh_token?: string; expires_at?: number; token_type?: string; scope?: string;
  client_id: string; client_secret?: string; token_endpoint: string; resource?: string;
};
/** client: the user's own OAuth app for this connector (kept across sign-outs, never shown back) */
export type Secret = { token?: string; oauth?: OAuthGrant; client?: { id: string; secret?: string } };
type State = { connectors: Connector[]; scopes: { chats: Record<string, Record<string, boolean>>; folders: Record<string, Record<string, boolean>> } };

export const slugify = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "connector";
export const envName = (id: string) => "BRIDGE_CONN_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
export const mask = (s?: string) => (!s ? "" : s.length < 12 ? "••••" : s.slice(0, 4) + "…" + s.slice(-4));

export type AddInput = {
  catalogId?: string; name?: string; url?: string; auth?: AuthKind; params?: Record<string, string>;
  tokenHeader?: string; tokenPrefix?: string;
  local?: Connector["local"];
};

export class ConnectorStore {
  readonly dir: string;
  private state: State = { connectors: [], scopes: { chats: {}, folders: {} } };
  private secrets: Record<string, Secret> = {};
  private writing: Promise<unknown> = Promise.resolve();
  /** refreshes an expired OAuth grant; set by the routes layer (oauth.ts) */
  refresher: ((id: string, g: OAuthGrant) => Promise<OAuthGrant | null>) | null = null;

  constructor(dir: string) { this.dir = dir; }
  get stateFile() { return join(this.dir, "connectors.json"); }
  get secretsFile() { return join(this.dir, "secrets.json"); }
  get runtimeFile() { return join(this.dir, "_runtime", "mcp.ts"); }
  serverFile(id: string) { return join(this.dir, id, "server.ts"); }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    try { const s = JSON.parse(await readFile(this.stateFile, "utf8")); this.state = { connectors: s.connectors || [], scopes: { chats: s.scopes?.chats || {}, folders: s.scopes?.folders || {} } }; } catch {}
    try { this.secrets = JSON.parse(await readFile(this.secretsFile, "utf8")); } catch {}
    // a turn that was generating when Bridge stopped will never finish
    for (const c of this.state.connectors) if (c.gen?.state === "running") { c.gen.state = "error"; c.gen.log += "\nBridge restarted while this was being built."; if (c.status === "generating") c.status = "untested"; }
    await mkdir(join(this.dir, "_runtime"), { recursive: true });
    const cur = await readFile(this.runtimeFile, "utf8").catch(() => "");
    if (cur !== RUNTIME_SOURCE) await writeFile(this.runtimeFile, RUNTIME_SOURCE);
  }

  private async atomic(file: string, text: string, mode?: number) {
    const tmp = file + "." + process.pid + ".tmp";
    await writeFile(tmp, text, mode ? { mode } : undefined);
    if (mode) await chmod(tmp, mode);
    await rename(tmp, file);
  }
  private save() { return (this.writing = this.writing.then(() => this.atomic(this.stateFile, JSON.stringify(this.state, null, 2))).catch(() => {})); }
  private saveSecrets() { return (this.writing = this.writing.then(() => this.atomic(this.secretsFile, JSON.stringify(this.secrets, null, 2), 0o600))); }

  all() { return this.state.connectors; }
  get(id: string) { return this.state.connectors.find((c) => c.id === id); }
  secret(id: string): Secret | undefined { return this.secrets[id]; }
  has(id: string) { const s = this.secrets[id]; return !!(s && (s.token || s.oauth?.access_token)); }

  /** what the client may see: no secrets, only a hint that one is set */
  view(c: Connector) {
    const s = this.secrets[c.id];
    const entry = c.catalogId ? catalogEntry(c.catalogId) : undefined;
    return {
      ...c, gen: c.gen ? { ...c.gen, log: c.gen.log.slice(-6000) } : undefined,
      secret: s?.token ? { kind: "token", hint: mask(s.token) } : s?.oauth ? { kind: "oauth", hint: mask(s.oauth.access_token), expiresAt: s.oauth.expires_at || 0, refreshable: !!s.oauth.refresh_token } : null,
      glyph: entry?.glyph || c.name.slice(0, 2), color: entry?.color || "",
      ready: this.ready(c),
      ownApp: !!s?.client,
    };
  }
  publicList() { return this.state.connectors.map((c) => this.view(c)); }

  /** usable in a turn: has what its auth needs */
  ready(c: Connector) {
    if (c.status === "generating") return false;
    if (c.kind === "local") return existsSync(this.serverFile(c.id)) && (c.local?.authKind === "none" || !c.local?.authKind || this.has(c.id));
    // a saved token the server refused (the last test said needs-auth) would only fail the turn
    return c.auth === "none" || (this.has(c.id) && c.status !== "needs-auth");
  }

  private uniqueId(base: string) {
    let id = slugify(base), n = 1;
    const taken = (x: string) => this.state.connectors.some((c) => c.id === x) || x === "_runtime";
    while (taken(n === 1 ? id : id + "-" + n)) n++;
    return n === 1 ? id : id + "-" + n;
  }

  async add(input: AddInput): Promise<Connector> {
    const now = Date.now();
    let c: Connector;
    if (input.catalogId) {
      const e = catalogEntry(input.catalogId);
      if (!e) throw new Error("unknown catalog entry " + input.catalogId);
      const u = new URL(e.url);
      for (const p of e.params || []) { const v = String(input.params?.[p.key] || "").trim(); if (v) u.searchParams.set(p.key, v); }
      const auth = input.auth && e.auth.includes(input.auth as any) ? input.auth : e.auth[0];
      c = { id: this.uniqueId(e.id), name: e.name, kind: "remote", catalogId: e.id, url: u.toString(), auth, tokenHeader: e.token?.header, tokenPrefix: e.token?.prefix,
        enabled: true, status: auth === "none" ? "untested" : "needs-auth", createdAt: now };
    } else if (input.local) {
      const l = input.local;
      if (l.baseUrl && !/^https?:\/\//i.test(l.baseUrl)) throw new Error("The API base URL must start with http:// or https://");
      if (l.spec && !/^https?:\/\//i.test(l.spec)) throw new Error("The OpenAPI spec must be an http(s) URL");
      if (l.mode === "words" && !String(l.description || "").trim()) throw new Error("Describe what the connector should do");
      const name = String(input.name || "").trim() || (l.baseUrl ? new URL(l.baseUrl).hostname.replace(/^(www|api)\./, "").split(".")[0] : "connector");
      const authKind: LocalAuth = (["none", "bearer", "header", "query", "basic"] as LocalAuth[]).includes(l.authKind) ? l.authKind : "none";
      c = { id: this.uniqueId(name), name, kind: "local", auth: authKind === "none" ? "none" : "token",
        local: { mode: l.mode === "words" ? "words" : "api", baseUrl: l.baseUrl ? l.baseUrl.replace(/\/+$/, "") : "", authKind, authName: String(l.authName || "").trim(), spec: l.spec || "", description: String(l.description || "").slice(0, 4000) },
        enabled: true, status: "untested", createdAt: now };
      await mkdir(join(this.dir, c.id), { recursive: true });
      await writeFile(this.serverFile(c.id), scaffoldServer(c));
    } else {
      const url = String(input.url || "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("An MCP server URL must start with http:// or https://");
      const auth: AuthKind = input.auth === "token" || input.auth === "oauth" ? input.auth : "none";
      c = { id: this.uniqueId(input.name || new URL(url).hostname.split(".").slice(-2, -1)[0] || "server"), name: String(input.name || new URL(url).hostname), kind: "remote", url, auth,
        tokenHeader: input.tokenHeader || "Authorization", tokenPrefix: input.tokenPrefix ?? "Bearer ", enabled: true, status: auth === "none" ? "untested" : "needs-auth", createdAt: now };
    }
    this.state.connectors.push(c);
    await this.save();
    return c;
  }

  async update(id: string, patch: Partial<Connector>) {
    const c = this.get(id);
    if (!c) throw new Error("no such connector");
    Object.assign(c, patch, { id: c.id });
    await this.save();
    return c;
  }

  async setToken(id: string, token: string) {
    if (!this.get(id)) throw new Error("no such connector");
    const t = String(token || "").trim();
    if (!t) throw new Error("empty token");
    this.secrets[id] = { token: t, client: this.secrets[id]?.client };
    await this.saveSecrets();
    await this.update(id, { status: "untested", error: undefined });
  }
  async setOAuth(id: string, g: OAuthGrant) {
    this.secrets[id] = { oauth: g, client: this.secrets[id]?.client };
    await this.saveSecrets();
  }
  async setClient(id: string, client: { id: string; secret?: string }) {
    if (!this.get(id)) throw new Error("no such connector");
    this.secrets[id] = { ...this.secrets[id], client };
    await this.saveSecrets();
  }
  async disconnect(id: string) {
    const client = this.secrets[id]?.client;
    if (client) this.secrets[id] = { client }; else delete this.secrets[id];
    await this.saveSecrets();
    const c = this.get(id);
    if (c) await this.update(id, { status: c.auth === "none" || (c.kind === "local" && c.local?.authKind === "none") ? "untested" : "needs-auth", tools: c.tools, error: undefined });
  }
  async remove(id: string) {
    const c = this.get(id);
    if (!c) return;
    this.state.connectors = this.state.connectors.filter((x) => x.id !== id);
    for (const m of [this.state.scopes.chats, this.state.scopes.folders]) for (const k of Object.keys(m)) { delete m[k][id]; if (!Object.keys(m[k]).length) delete m[k]; }
    delete this.secrets[id];
    await this.saveSecrets();
    await this.save();
    if (c.kind === "local") {
      const d = resolve(this.dir, id);
      if (d.startsWith(resolve(this.dir) + sep)) await rm(d, { recursive: true, force: true });
    }
  }

  async setScope(kind: "chat" | "folder", key: string, id: string, on: boolean | null) {
    const m = kind === "chat" ? this.state.scopes.chats : this.state.scopes.folders;
    const k = kind === "folder" ? resolve(key) : key;
    if (on === null) { if (m[k]) { delete m[k][id]; if (!Object.keys(m[k]).length) delete m[k]; } }
    else (m[k] ||= {})[id] = !!on;
    await this.save();
  }
  /** the folder switch that applies: the closest folder at or above cwd */
  private folderSwitch(cwd: string, id: string): boolean | undefined {
    let best = "", v: boolean | undefined;
    const at = resolve(cwd || "/");
    for (const [f, m] of Object.entries(this.state.scopes.folders)) {
      if (!(id in m)) continue;
      if ((at === f || at.startsWith(f.endsWith(sep) ? f : f + sep)) && f.length > best.length) { best = f; v = m[id]; }
    }
    return v;
  }
  scopesFor(sessionId: string, cwd: string) {
    return this.state.connectors.map((c) => {
      const chat = sessionId ? this.state.scopes.chats[sessionId]?.[c.id] : undefined;
      const folder = this.folderSwitch(cwd, c.id);
      return { id: c.id, chat, folder, default: c.enabled, on: chat ?? folder ?? c.enabled, ready: this.ready(c) };
    });
  }

  /** one connector's --mcp-config entry, with its secret as an env reference, refreshing an expiring OAuth grant first */
  async entryFor(c: Connector): Promise<{ entry: any; env: Record<string, string> }> {
    const ev = envName(c.id);
    let s = this.secrets[c.id];
    if (s?.oauth && s.oauth.expires_at && s.oauth.expires_at < Date.now() + 60_000 && this.refresher) {
      const g = await this.refresher(c.id, s.oauth).catch(() => null);
      if (g) { await this.setOAuth(c.id, g); s = this.secrets[c.id]; }
    }
    const secret = s?.token || s?.oauth?.access_token || "";
    const env: Record<string, string> = {};
    if (c.kind === "remote") {
      const entry: any = { type: "http", url: c.url };
      if (secret) {
        entry.headers = { [c.tokenHeader || "Authorization"]: (s?.oauth ? "Bearer " : c.tokenPrefix ?? "Bearer ") + "${" + ev + "}" };
        env[ev] = c.tokenPrefix === "Basic " && !s?.oauth && secret.includes(":") ? Buffer.from(secret).toString("base64") : secret;
      }
      return { entry, env };
    }
    const l = c.local!;
    env[ev] = secret;
    return { entry: { type: "stdio", command: process.execPath, args: [this.serverFile(c.id)],
      env: { API_BASE_URL: l.baseUrl || "", API_AUTH: l.authKind || "none", API_AUTH_NAME: l.authName || "", API_TOKEN: "${" + ev + "}" } }, env };
  }
  /** what the Test button probes: the same entry a turn gets, with the env references filled in */
  async probeTarget(id: string) {
    const c = this.get(id);
    if (!c) throw new Error("no such connector");
    const { entry, env } = await this.entryFor(c);
    const fill = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? "");
    if (entry.type === "http") return { type: "http" as const, url: entry.url, headers: Object.fromEntries(Object.entries(entry.headers || {}).map(([k, v]) => [k, fill(String(v))])) };
    return { type: "stdio" as const, command: entry.command, args: entry.args, cwd: dirname(entry.args[0]), env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, fill(String(v))])) };
  }

  /** the --mcp-config for one turn, or null when no connector applies */
  async turnConfig(o: { sessionId?: string; cwd?: string; only?: string[] }) {
    const pick = o.only
      ? this.state.connectors.filter((c) => o.only!.includes(c.id))
      : this.scopesFor(o.sessionId || "", o.cwd || "/").filter((s) => s.on).map((s) => this.get(s.id)!);
    const servers: Record<string, any> = {}, env: Record<string, string> = {}, names: string[] = [];
    for (const c of pick) {
      if (!this.ready(c)) continue;
      const e = await this.entryFor(c);
      servers[c.id] = e.entry;
      Object.assign(env, e.env);
      names.push(c.id);
    }
    if (!names.length) return null;
    const text = JSON.stringify({ mcpServers: servers }, null, 2);
    const runDir = join(this.dir, "_runtime", "turns");
    await mkdir(runDir, { recursive: true });
    const file = join(runDir, createHash("sha256").update(text).digest("hex").slice(0, 16) + ".json");
    if (!existsSync(file)) await writeFile(file, text);
    return { file, env, names, allowed: names.map((n) => "mcp__" + n) };
  }
}
