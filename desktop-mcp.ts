#!/usr/bin/env bun
/* The screen tools for a turn on the cloud computer: a tiny stdio MCP server (no dependencies) that looks at and
 * acts on the X display Bridge runs (desktop.ts). Each call first asks Bridge to make sure the desktop is up
 * (BRIDGE_DESKTOP_URL/ensure), and refuses while the user holds control, so agent and human never fight over
 * the mouse. Web pages are better driven with the browser tools (Playwright MCP); these are for everything else.
 *
 *   screenshot · click · type · key · scroll · move
 *
 * Env: DISPLAY, BRIDGE_DESKTOP_URL (http://127.0.0.1:<port>/desktop/<key>). BRIDGE_DESKTOP_DRY=1 records the
 * commands instead of running them (tests). */
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BRIDGE_DESKTOP_URL || "";
const DRY = process.env.BRIDGE_DESKTOP_DRY === "1";

export const TOOLS = [
  { name: "screenshot", description: "Take a screenshot of the whole screen (the user sees the same screen live). Returns a PNG.", inputSchema: { type: "object", properties: {} } },
  { name: "click", description: "Click at screen pixel x,y. button: left (default), right or middle. double: double-click.",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right", "middle"] }, double: { type: "boolean" } }, required: ["x", "y"] } },
  { name: "move", description: "Move the mouse to screen pixel x,y without clicking (hover).",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "type", description: "Type text into whatever has keyboard focus.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "key", description: "Press a key or chord, xdotool syntax: Return, Escape, Tab, ctrl+l, ctrl+shift+t, BackSpace, Down.",
    inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] } },
  { name: "scroll", description: "Scroll at screen pixel x,y. direction: up or down (default) / left / right; amount: wheel clicks (default 5).",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" } }, required: ["x", "y"] } },
];

const BUTTON: Record<string, string> = { left: "1", middle: "2", right: "3" };
const WHEEL: Record<string, string> = { up: "4", down: "5", left: "6", right: "7" };
const int = (v: any) => String(Math.max(0, Math.round(Number(v) || 0)));

/** the xdotool argv for an action tool (exported for tests) */
export function commandFor(name: string, a: any): string[][] {
  switch (name) {
    case "click": return [["xdotool", "mousemove", int(a.x), int(a.y), "click", ...(a.double ? ["--repeat", "2", "--delay", "80"] : []), BUTTON[a.button] || "1"]];
    case "move": return [["xdotool", "mousemove", int(a.x), int(a.y)]];
    case "type": return [["xdotool", "type", "--delay", "12", "--", String(a.text ?? "")]];
    case "key": return [["xdotool", "key", "--", ...String(a.keys ?? a.key ?? "").trim().split(/\s+/).filter(Boolean)]];
    case "scroll": return [["xdotool", "mousemove", int(a.x), int(a.y), "click", "--repeat", String(Math.min(30, Math.max(1, Math.round(Number(a.amount) || 5)))), WHEEL[a.direction] || "5"]];
  }
  throw new Error("unknown tool " + name);
}

const dryLog: string[][] = [];
async function run(argv: string[]) {
  if (DRY) { dryLog.push(argv); return; }
  const p = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(argv[0] + " failed: " + err.trim().slice(0, 300));
}
/** desktop up, and whose turn it is on the screen */
async function ensure(): Promise<{ control: boolean }> {
  if (!BASE || DRY) return { control: process.env.BRIDGE_DESKTOP_DRY_CONTROL === "1" };
  const r = await fetch(BASE + "/ensure", { method: "POST", signal: AbortSignal.timeout(30_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "the desktop did not start (" + r.status + ")");
  return { control: !!j.control };
}

async function call(name: string, args: any) {
  const { control } = await ensure();
  if (control) return { isError: true, content: [{ type: "text", text: "The user has taken control of the screen. Do not act on it now: tell them what you were about to do, or wait until they give control back." }] };
  if (name === "screenshot") {
    if (DRY) return { content: [{ type: "image", data: "", mimeType: "image/png" }] };
    const f = join(tmpdir(), "bridge-shot-" + process.pid + "-" + Date.now() + ".png");
    await run(["scrot", "--overwrite", "--pointer", f]);
    const data = (await readFile(f)).toString("base64");
    await rm(f, { force: true });
    return { content: [{ type: "image", data, mimeType: "image/png" }] };
  }
  for (const argv of commandFor(name, args || {})) await run(argv);
  return { content: [{ type: "text", text: "ok: " + name + (DRY ? " " + JSON.stringify(dryLog.at(-1)) : "") }] };
}

/* ── MCP over stdio: newline-delimited JSON-RPC ── */
function reply(id: any, result?: any, error?: { code: number; message: string }) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\n");
}
async function handle(m: any) {
  if (!m || m.id === undefined || m.id === null) return; // notifications
  try {
    switch (m.method) {
      case "initialize":
        return reply(m.id, { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bridge-computer", version: "1.0.0" } });
      case "ping": return reply(m.id, {});
      case "tools/list": return reply(m.id, { tools: TOOLS });
      case "tools/call": {
        const name = String(m.params?.name || "");
        if (!TOOLS.some((t) => t.name === name)) return reply(m.id, undefined, { code: -32602, message: "unknown tool " + name });
        try { return reply(m.id, await call(name, m.params?.arguments)); }
        catch (e: any) { return reply(m.id, { isError: true, content: [{ type: "text", text: String(e?.message || e) }] }); }
      }
      default: return reply(m.id, undefined, { code: -32601, message: "method not found: " + m.method });
    }
  } catch (e: any) { reply(m.id, undefined, { code: -32603, message: String(e?.message || e) }); }
}

if (import.meta.main) {
  let buf = "";
  const inflight = new Set<Promise<void>>();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c: string) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m: any; try { m = JSON.parse(line); } catch { continue; }
      const p = handle(m).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  });
  process.stdin.on("end", async () => { await Promise.allSettled([...inflight]); process.exit(0); });
}
