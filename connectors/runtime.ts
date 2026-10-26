/**
 * The runtime every Bridge-generated connector imports: a dependency-free MCP server over stdio
 * (newline-delimited JSON-RPC 2.0, the transport Claude Code launches local servers with).
 *
 * A generated connector is one file that calls `serve({ name, tools })`. Each tool is a name, a
 * description, a JSON-Schema input and a `run(args)` that returns text or JSON. Bridge copies this
 * file to BRIDGE_DATA/connectors/_runtime/mcp.ts so connectors import it as "../_runtime/mcp.ts".
 *
 * The connector's settings arrive as environment variables, set by Bridge per turn:
 *   API_BASE_URL         the API root the user gave
 *   API_TOKEN            the secret (never written into the connector's files)
 *   API_AUTH             "bearer" | "header" | "query" | "none"
 *   API_AUTH_NAME        the header or query parameter name for "header" / "query"
 * `api()` below turns those into a fetch, so a tool is usually one line.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Tool = {
  name: string;
  description: string;
  inputSchema?: { type: "object"; properties?: Record<string, any>; required?: string[] };
  run: (args: Record<string, any>) => Promise<unknown> | unknown;
};

const env = (k: string) => (typeof process !== "undefined" ? process.env[k] || "" : "");

/** the auth the user configured, as headers and query params (empty when there is no token) */
export function auth(): { headers: Record<string, string>; query: Record<string, string> } {
  const token = env("API_TOKEN"), kind = env("API_AUTH") || (token ? "bearer" : "none"), name = env("API_AUTH_NAME");
  if (!token || kind === "none") return { headers: {}, query: {} };
  if (kind === "header") return { headers: { [name || "x-api-key"]: token }, query: {} };
  if (kind === "query") return { headers: {}, query: { [name || "api_key"]: token } };
  if (kind === "basic") return { headers: { authorization: "Basic " + Buffer.from(token).toString("base64") }, query: {} };
  return { headers: { authorization: "Bearer " + token }, query: {} };
}

/** call the configured API. `path` is relative to API_BASE_URL (an absolute URL is used as is). */
export async function api(path: string, opts: { method?: string; query?: Record<string, any>; body?: unknown; headers?: Record<string, string> } = {}): Promise<unknown> {
  const base = env("API_BASE_URL").replace(/\/+$/, "");
  const url = new URL(/^https?:\/\//.test(path) ? path : base + "/" + String(path).replace(/^\/+/, ""));
  const a = auth();
  for (const [k, v] of Object.entries({ ...(opts.query || {}), ...a.query })) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "bridge-connector", ...a.headers, ...(opts.headers || {}) };
  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] ||= "application/json";
  }
  const r = await fetch(url, { method: opts.method || (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error("HTTP " + r.status + " " + r.statusText + ": " + text.slice(0, 600));
  return data;
}

/** run a shell command and return its output; for connectors that wrap a script or CLI */
export async function sh(cmd: string[], opts: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill(), opts.timeoutMs || 60_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(t);
  if (code !== 0) throw new Error("exit " + code + ": " + (err || out).slice(0, 600));
  return out;
}

const MAX_TEXT = 60_000;
function asText(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n…(truncated " + (s.length - MAX_TEXT) + " chars)" : s;
}

/** handle one JSON-RPC message; exported so tests can drive a server without a process */
export async function handle(server: { name: string; version?: string; tools: Tool[] }, msg: any): Promise<any | null> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined || id === null) return null;                                   // a notification
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server.name, version: server.version || "1.0.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: server.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: "object", properties: {} } })) });
    case "tools/call": {
      const t = server.tools.find((x) => x.name === msg.params?.name);
      if (!t) return fail(-32602, "unknown tool " + msg.params?.name);
      try {
        return reply({ content: [{ type: "text", text: asText(await t.run(msg.params?.arguments || {})) }] });
      } catch (e: any) {
        return reply({ content: [{ type: "text", text: String(e?.message || e) }], isError: true });
      }
    }
    default:
      return fail(-32601, "method not found: " + msg.method);
  }
}

/** start the server on stdin/stdout. Logs go to stderr: stdout is the protocol. */
export function serve(server: { name: string; version?: string; tools: Tool[] }) {
  let buf = "";
  const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
      handle(server, msg).then((r) => r && out(r)).catch((e) => console.error(e));
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
