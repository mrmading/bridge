/**
 * /api/connectors* — every route sits behind server.ts's Supabase gate (it runs after the check).
 * GET and POST only, so the Cloudflare Worker and CORS rules pass them as they are.
 * Secrets go in (token, OAuth code) and never come out: responses carry masked hints.
 */
import { readFile, writeFile } from "node:fs/promises";
import { CATALOG, catalogEntry } from "./catalog.ts";
import { ConnectorStore } from "./store.ts";
import { probe } from "./mcp-client.ts";
import { startOAuth, finishOAuth, refresh, startDevice, deviceStatus, githubClientId } from "./oauth.ts";
import { generate, isGenerating } from "./generate.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export type ConnectorDeps = {
  dataDir: string;
  claudeBin: string;
  /** extra env for the generator's claude turn (settings.json env) */
  env?: Record<string, string>;
  /** forwards a request to the cloud computer when ?computer=cloud / body.computer === "cloud" */
  proxy?: (path: string, method: string, body: any, auth: string) => Promise<Response>;
  log?: (kind: string, msg: string) => void;
};

export async function createConnectors(deps: ConnectorDeps) {
  const store = new ConnectorStore(deps.dataDir);
  await store.load();
  store.refresher = (_id, g) => refresh(g);
  const log = deps.log || (() => {});

  async function test(id: string) {
    const c = store.get(id);
    if (!c) return { ok: false, error: "no such connector" };
    if (c.kind === "remote" && c.auth !== "none" && !store.has(id)) {
      await store.update(id, { status: "needs-auth", error: undefined });
      return { ok: false, needsAuth: true, error: "not signed in yet" };
    }
    const r = await probe(await store.probeTarget(id), c.kind === "local" ? 20_000 : 15_000);
    if (r.ok) await store.update(id, { status: "connected", tools: r.tools, testedAt: Date.now(), error: undefined });
    else await store.update(id, { status: r.needsAuth ? "needs-auth" : "error", error: (r.needsAuth && store.has(id) ? "The server refused the saved sign-in (" + (r.status || 401) + "). Sign in again or paste a new token." : r.error).slice(0, 400), testedAt: Date.now() });
    log(r.ok ? "connector.ok" : "connector.error", c.name + (r.ok ? ": " + r.tools.length + " tools" : ": " + r.error.slice(0, 120)));
    return r.ok ? { ok: true, tools: r.tools, ms: r.ms } : { ok: false, needsAuth: !!r.needsAuth, error: r.error };
  }
  const gen = { claudeBin: deps.claudeBin, store, test, env: deps.env };
  const view = (id: string) => { const c = store.get(id); return c ? store.view(c) : null; };

  async function route(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname, q = url.searchParams;
    if (p !== "/api/connectors" && !p.startsWith("/api/connectors/")) return null;
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    // the cloud computer keeps its own connectors: the hub forwards there, the token included
    if (deps.proxy && (q.get("computer") === "cloud" || body?.computer === "cloud")) {
      const fwd = new URLSearchParams(q); fwd.delete("computer");
      if (body) delete body.computer;
      return deps.proxy(p + (fwd.toString() ? "?" + fwd : ""), req.method, req.method === "POST" ? body : undefined, req.headers.get("authorization") || "");
    }
    const id = String(body.id || q.get("id") || "");
    const need = () => { if (!store.get(id)) throw Object.assign(new Error("no such connector"), { status: 404 }); };
    try {
      if (p === "/api/connectors" && req.method === "GET")
        return json({ connectors: store.publicList().map((c) => ({ ...c, generating: isGenerating(c.id) })), catalog: CATALOG, device: { github: !!githubClientId() } });

      if (p === "/api/connectors/add" && req.method === "POST") {
        const c = await store.add({ catalogId: body.catalogId, name: body.name, url: body.url, auth: body.auth, params: body.params, tokenHeader: body.tokenHeader, tokenPrefix: body.tokenPrefix, local: body.local });
        log("connector.add", c.name);
        if (body.token) await store.setToken(c.id, String(body.token));
        if (c.kind === "local") generate(gen, c.id, String(body.instructions || "")).catch(() => {});
        else if (c.auth === "none" || body.token) await test(c.id);
        return json({ connector: view(c.id) });
      }
      if (p === "/api/connectors/token" && req.method === "POST") {
        need();
        await store.setToken(id, String(body.token || ""));
        const r = await test(id);
        return json({ connector: view(id), test: r });
      }
      if (p === "/api/connectors/test" && req.method === "POST") { need(); const r = await test(id); return json({ connector: view(id), test: r }); }
      if (p === "/api/connectors/update" && req.method === "POST") {
        need();
        const patch: any = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
        await store.update(id, patch);
        return json({ connector: view(id) });
      }
      if (p === "/api/connectors/disconnect" && req.method === "POST") { need(); await store.disconnect(id); log("connector.disconnect", id); return json({ connector: view(id) }); }
      if (p === "/api/connectors/remove" && req.method === "POST") { need(); await store.remove(id); log("connector.remove", id); return json({ ok: true }); }

      /* OAuth: the client says where it lives so the vendor can send the user back to its callback page */
      if (p === "/api/connectors/oauth/start" && req.method === "POST") {
        need();
        const c = store.get(id)!;
        if (c.kind !== "remote" || !c.url) throw new Error("only remote servers sign in with OAuth");
        const redirect = String(body.redirectUri || "");
        if (!/^https?:\/\/[^/]+\/connectors-callback\.html$/.test(redirect)) throw new Error("bad redirect");
        const r = await startOAuth(id, c.url, redirect);
        if (c.auth !== "oauth") await store.update(id, { auth: "oauth" });
        return json(r);
      }
      if (p === "/api/connectors/oauth/finish" && req.method === "POST") {
        let code = String(body.code || ""), state = String(body.state || "");
        if (body.url) { try { const u = new URL(String(body.url).trim()); code = u.searchParams.get("code") || ""; state = u.searchParams.get("state") || ""; if (u.searchParams.get("error")) throw new Error(u.searchParams.get("error_description") || u.searchParams.get("error") || "denied"); } catch (e: any) { if (e.message !== "Invalid URL") throw e; throw new Error("Paste the whole address of the page you landed on"); } }
        if (!code || !state) throw new Error("That address has no sign-in code in it");
        const { id: cid, grant } = await finishOAuth(code, state);
        await store.setOAuth(cid, grant);
        await store.update(cid, { auth: "oauth", status: "untested" });
        const r = await test(cid);
        return json({ connector: view(cid), test: r });
      }
      if (p === "/api/connectors/device/start" && req.method === "POST") {
        need();
        const d = await startDevice(id, async (token) => { await store.setToken(id, token); await store.update(id, { auth: "device" }); await test(id); });
        return json({ user_code: d.user_code, verification_uri: d.verification_uri, interval: d.interval });
      }
      if (p === "/api/connectors/device" && req.method === "GET") return json({ device: deviceStatus(id), connector: view(id) });

      /* self-made connectors: their code is the user's to read and change */
      if (p === "/api/connectors/generate" && req.method === "POST") {
        need();
        generate(gen, id, String(body.instructions || "")).catch(() => {});
        return json({ connector: view(id) });
      }
      if (p === "/api/connectors/code") {
        need();
        const c = store.get(id)!;
        if (c.kind !== "local") throw new Error("only self-made connectors have code here");
        if (req.method === "GET") return json({ code: await readFile(store.serverFile(id), "utf8").catch(() => ""), path: store.serverFile(id) });
        if (isGenerating(id)) throw new Error("Claude is still writing this connector");
        const code = String(body.code || "");
        if (!code.trim() || code.length > 400_000) throw new Error("empty or too large");
        await writeFile(store.serverFile(id), code);
        const r = await test(id);
        return json({ connector: view(id), test: r });
      }

      /* which connectors a chat gets: default → closest folder switch → chat switch */
      if (p === "/api/connectors/scopes" && req.method === "GET")
        return json({ scopes: store.scopesFor(q.get("session") || "", q.get("cwd") || "/"), connectors: store.publicList().map((c) => ({ id: c.id, name: c.name, glyph: c.glyph, color: c.color, status: c.status, tools: (c.tools || []).length, ready: c.ready })) });
      if (p === "/api/connectors/scope" && req.method === "POST") {
        need();
        const kind = body.kind === "chat" ? "chat" : "folder";
        const key = String(body.key || "");
        if (!key) throw new Error("missing " + (kind === "chat" ? "session" : "folder"));
        await store.setScope(kind, key, id, body.on === null || body.on === undefined ? null : !!body.on);
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message || e) }, e?.status || 400);
    }
  }

  /** the --mcp-config + env + allowed tools for one chat turn (null: no connector applies) */
  const turnConfig = (o: { sessionId?: string; cwd?: string; only?: string[] }) => store.turnConfig(o).catch((e) => { log("connector.error", "turn config: " + String(e?.message || e)); return null; });

  return { store, route, turnConfig, test };
}
export { catalogEntry };
