/**
 * Self-made connectors: a Claude turn writes BRIDGE_DATA/connectors/<id>/server.ts against the
 * runtime in ../_runtime/mcp.ts, then Bridge lists its tools to prove it starts. One repair turn
 * follows when the first version does not start. The generator never sees the user's token.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Connector, ConnectorStore } from "./store.ts";

function brief(c: Connector, extra: string): string {
  const l = c.local!;
  const authLine = {
    none: "The API needs no authentication.",
    bearer: "Auth: a bearer token, already added by api() as `Authorization: Bearer $API_TOKEN`.",
    header: "Auth: the token goes in the `" + (l.authName || "x-api-key") + "` header; api() adds it.",
    query: "Auth: the token goes in the `" + (l.authName || "api_key") + "` query parameter; api() adds it.",
    basic: "Auth: HTTP Basic with `user:password` from API_TOKEN; api() adds it.",
  }[l.authKind || "none"];
  return [
    "You are writing a small MCP server (a \"connector\") that lets an AI assistant use " + (l.baseUrl ? "the API at " + l.baseUrl : "a capability the user described") + ".",
    "",
    "Write exactly one file: ./server.ts (it exists already as a generic first version; replace it). Use Bun + TypeScript, no npm packages.",
    "Import the runtime with: import { serve, api, sh } from \"../_runtime/mcp.ts\";  Read ../_runtime/mcp.ts first; it defines:",
    "  serve({ name, tools: [{ name, description, inputSchema, run(args) }] })  starts the stdio MCP server",
    "  api(path, { method, query, body, headers })  fetches API_BASE_URL + path with the user's auth, returns parsed JSON, throws on HTTP errors",
    "  sh([cmd, ...args], { cwd, stdin, timeoutMs })  runs a command, returns stdout",
    "The connector name must be \"" + c.id + "\". " + authLine + " Never hard-code secrets; never print process.env.",
    "",
    l.baseUrl ? "API base URL: " + l.baseUrl : "",
    l.spec ? "OpenAPI spec: " + l.spec + "  (fetch it with WebFetch or curl; pick the operations most useful to an assistant)" : "",
    l.description ? "What the user wants, in their words:\n<<<\n" + l.description + "\n>>>" : "",
    extra ? "Extra instructions:\n<<<\n" + extra + "\n>>>" : "",
    "",
    "Guidelines:",
    "- 3 to 15 focused tools with snake_case names, clear one-line descriptions that say what comes back, and a JSON-Schema inputSchema with `required` set.",
    "- Return compact JSON: pick the useful fields of big responses, and support paging/limits where the API has them.",
    "- Prefer read tools; add write tools only when the user asked for changes. Keep a generic `request` tool as an escape hatch when there is a base URL.",
    "- If it runs scripts or commands, use sh() with an argument array (no shell string interpolation of user input).",
    "- You may try public, unauthenticated endpoints with curl to check response shapes. Do not ask questions; make sensible choices.",
    "- When done, run `bun build ./server.ts --target=bun --outfile=/dev/null` to check it compiles, fix any error, and reply with one paragraph listing the tools.",
  ].filter((x) => x !== "").join("\n");
}

type Gen = { claudeBin: string; store: ConnectorStore; test: (id: string) => Promise<{ ok: boolean; error?: string }>; env?: Record<string, string | undefined> };

function runTurn(g: Gen, c: Connector, prompt: string, onLog: (s: string) => void): Promise<{ ok: boolean; text: string; cost?: number }> {
  return new Promise((resolve) => {
    const dir = dirname(g.store.serverFile(c.id));
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--permission-mode", "acceptEdits",
      "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--add-dir", join(g.store.dir, "_runtime"),
      "--allowedTools", "Read,Write,Edit,Glob,Grep,WebFetch,Bash(curl:*),Bash(bun build:*),Bash(bun run:*),Bash(cat:*),Bash(ls:*)"];
    const env = { ...process.env, ...(g.env || {}), FORCE_COLOR: "0" };
    for (const k of Object.keys(env)) if (k.startsWith("BRIDGE_CONN_") || k === "API_TOKEN") delete (env as any)[k];
    const child = spawn(g.claudeBin, args, { cwd: dir, env: env as any, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "", text = "", cost: number | undefined, isErr = false;
    const kill = setTimeout(() => { onLog("\nStopped after 10 minutes."); child.kill("SIGTERM"); }, 600_000);
    child.stdout.on("data", (ch) => {
      buf += ch;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "assistant") for (const x of m.message?.content || []) {
          if (x.type === "text" && x.text?.trim()) onLog("\n" + x.text.trim());
          if (x.type === "tool_use") onLog("\n› " + x.name + " " + String(x.input?.file_path || x.input?.command || x.input?.url || x.input?.pattern || "").slice(0, 140));
        }
        if (m.type === "result") { text = String(m.result || ""); cost = m.total_cost_usd; isErr = !!m.is_error; }
      }
    });
    child.stderr.on("data", (d) => { const s = String(d).trim(); if (s && !/connectors are disabled/i.test(s)) onLog("\n[stderr] " + s.slice(0, 400)); });
    child.on("error", (e) => { clearTimeout(kill); resolve({ ok: false, text: String(e) }); });
    child.on("close", (code) => { clearTimeout(kill); resolve({ ok: code === 0 && !isErr, text, cost }); });
  });
}

const generating = new Set<string>();
export const isGenerating = (id: string) => generating.has(id);

/** build (or rebuild) a local connector's server with a Claude turn; resolves when done */
export async function generate(g: Gen, id: string, extra = ""): Promise<void> {
  const c = g.store.get(id);
  if (!c || c.kind !== "local") throw new Error("not a self-made connector");
  if (generating.has(id)) throw new Error("already being built");
  generating.add(id);
  const started = Date.now();
  let log = "Writing the connector with Claude…";
  let flushT: any = null;
  const flush = () => { flushT = null; const cur = g.store.get(id); if (cur?.gen) g.store.update(id, { gen: { ...cur.gen, log } }).catch(() => {}); };
  const onLog = (s: string) => { log = (log + s).slice(-20_000); if (!flushT) flushT = setTimeout(flush, 800); };
  await g.store.update(id, { status: "generating", error: undefined, gen: { state: "running", startedAt: started, log } });
  let cost = 0;
  try {
    const before = await readFile(g.store.serverFile(id), "utf8").catch(() => "");
    let r = await runTurn(g, c, brief(c, extra), onLog);
    cost += r.cost || 0;
    if (!r.ok) throw new Error(r.text || "the Claude turn failed");
    const after = await readFile(g.store.serverFile(id), "utf8").catch(() => "");
    if (after === before) onLog("\n(Claude left server.ts unchanged.)");
    onLog("\n\nTesting: starting the server and listing its tools…");
    let t = await g.test(id);
    if (!t.ok) {
      onLog("\nIt did not start: " + t.error + "\nAsking Claude to fix it…");
      r = await runTurn(g, c, "The MCP server in ./server.ts fails to start or list its tools with this error:\n" + t.error + "\nFix server.ts (keep the same runtime import and tools), then check it compiles with `bun build ./server.ts --target=bun --outfile=/dev/null`.", onLog);
      cost += r.cost || 0;
      t = await g.test(id);
    }
    if (!t.ok) throw new Error(t.error || "the server does not start");
    const cur = g.store.get(id)!;
    onLog("\nReady: " + (cur.tools || []).length + " tools.");
    clearTimeout(flushT);
    await g.store.update(id, { gen: { state: "done", startedAt: started, endedAt: Date.now(), log, cost } });
  } catch (e: any) {
    clearTimeout(flushT);
    onLog("\nFailed: " + String(e?.message || e));
    await g.store.update(id, { status: "error", error: String(e?.message || e).slice(0, 500), gen: { state: "error", startedAt: started, endedAt: Date.now(), log, cost } });
  } finally {
    generating.delete(id);
  }
}
