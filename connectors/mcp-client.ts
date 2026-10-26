/**
 * Just enough of an MCP client to answer "does this connector work, and what can it do?":
 * initialize + tools/list against a remote server (streamable HTTP; the JSON or SSE reply forms)
 * or a local stdio server. Bridge uses it for the Test button and the tool count; the real turns
 * are served by the claude CLI itself through --mcp-config.
 */
import { spawn } from "node:child_process";

export type McpTool = { name: string; description?: string };
export type ProbeResult =
  | { ok: true; tools: McpTool[]; server?: string; ms: number }
  | { ok: false; needsAuth?: boolean; error: string; status?: number; wwwAuthenticate?: string; ms: number };

export type HttpTarget = { type: "http"; url: string; headers?: Record<string, string> };
export type StdioTarget = { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string };

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "bridge-connectors", version: "1.0.0" };

/** the JSON-RPC message with this id, from a JSON body or an SSE stream */
async function readReply(r: Response, id: number): Promise<any> {
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    const t = await r.text();
    if (!t.trim()) return null;
    const j = JSON.parse(t);
    return Array.isArray(j) ? j.find((m) => m.id === id) : j;
  }
  const reader = r.body!.getReader(), dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === id) return m; } catch {}
      }
    }
  } finally { reader.cancel().catch(() => {}); }
  return null;
}

export async function probeHttp(t: HttpTarget, timeoutMs = 15_000): Promise<ProbeResult> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  let session = "";
  let n = 0;
  const rpc = async (method: string, params?: unknown, notify = false) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(t.headers || {}) };
    if (session) headers["mcp-session-id"] = session;
    const id = ++n;
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
    const r = await fetch(t.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (r.headers.get("mcp-session-id")) session = r.headers.get("mcp-session-id")!;
    if (r.status === 401 || r.status === 403) {
      const err: any = new Error(r.status === 401 ? "needs sign-in" : "access denied (" + r.status + ")");
      err.status = r.status; err.www = r.headers.get("www-authenticate") || ""; err.needsAuth = true;
      await r.body?.cancel().catch(() => {});
      throw err;
    }
    if (notify) { await r.body?.cancel().catch(() => {}); return null; }
    if (!r.ok) { const txt = (await r.text().catch(() => "")).slice(0, 300); const err: any = new Error("HTTP " + r.status + (txt ? ": " + txt : "")); err.status = r.status; throw err; }
    const m = await readReply(r, id);
    if (!m) throw new Error("no reply to " + method);
    if (m.error) throw new Error(method + ": " + (m.error.message || JSON.stringify(m.error)));
    return m.result;
  };
  try {
    const init = await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
    await rpc("notifications/initialized", undefined, true).catch(() => {});
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await rpc("tools/list", cursor ? { cursor } : {});
      for (const x of res?.tools || []) tools.push({ name: x.name, description: x.description });
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    if (session) fetch(t.url, { method: "DELETE", headers: { "mcp-session-id": session, ...(t.headers || {}) } }).catch(() => {});
    return { ok: true, tools, server: init?.serverInfo?.name, ms: ms() };
  } catch (e: any) {
    return { ok: false, needsAuth: !!e.needsAuth, status: e.status, wwwAuthenticate: e.www, error: String(e?.message || e), ms: ms() };
  }
}

export function probeStdio(t: StdioTarget, timeoutMs = 20_000): Promise<ProbeResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(t.command, t.args || [], { cwd: t.cwd, env: { ...process.env, ...(t.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) { resolve({ ok: false, error: String(e?.message || e), ms: Date.now() - t0 }); return; }
    let out = "", err = "", done = false;
    const pending = new Map<number, (m: any) => void>();
    const finish = (r: ProbeResult) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: "timed out" + (err ? ": " + err.slice(-400) : ""), ms: Date.now() - t0 }), timeoutMs);
    child.on("error", (e) => finish({ ok: false, error: String(e.message || e), ms: Date.now() - t0 }));
    child.on("exit", (code) => finish({ ok: false, error: "server exited (" + code + ")" + (err ? ": " + err.trim().slice(-600) : ""), ms: Date.now() - t0 }));
    child.stderr!.on("data", (c) => (err = (err + c).slice(-4000)));
    child.stdout!.on("data", (c) => {
      out += c;
      let i;
      while ((i = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, i).trim(); out = out.slice(i + 1);
        if (!line) continue;
        try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch {}
      }
    });
    let n = 0;
    const rpc = (method: string, params?: unknown) => new Promise<any>((ok, bad) => {
      const id = ++n;
      pending.set(id, (m) => (m.error ? bad(new Error(method + ": " + m.error.message)) : ok(m.result)));
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    (async () => {
      try {
        const init = await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const res = await rpc("tools/list", {});
        finish({ ok: true, tools: (res?.tools || []).map((x: any) => ({ name: x.name, description: x.description })), server: init?.serverInfo?.name, ms: Date.now() - t0 });
      } catch (e: any) { finish({ ok: false, error: String(e?.message || e), ms: Date.now() - t0 }); }
    })();
  });
}

export const probe = (t: HttpTarget | StdioTarget, timeoutMs?: number) => (t.type === "http" ? probeHttp(t, timeoutMs) : probeStdio(t, timeoutMs));
