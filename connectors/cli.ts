#!/usr/bin/env bun
/**
 * bun connectors/cli.ts <command> [--json]
 *   catalog            the pre-listed connectors (URL, auth, verified)
 *   list               your connectors and their status (no secrets)
 *   test <id>          start/reach the server and list its tools
 *   config [cwd]       the --mcp-config a chat in that folder gets (secrets stay env references)
 * Reads BRIDGE_DATA (default ~/.claude/bridge)/connectors, the same files the server uses.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { CATALOG } from "./catalog.ts";
import { ConnectorStore } from "./store.ts";
import { probe } from "./mcp-client.ts";

const [cmd, arg] = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
const store = new ConnectorStore(join(process.env.BRIDGE_DATA || join(homedir(), ".claude", "bridge"), "connectors"));
await store.load();
const out = (data: unknown, text: string) => console.log(asJson ? JSON.stringify(data, null, 2) : text);

if (cmd === "catalog") out(CATALOG, CATALOG.map((c) => `${c.id.padEnd(16)} ${c.auth.join("/").padEnd(14)} ${c.verified ? "verified" : "UNVERIFIED"}  ${c.availability.padEnd(9)} ${c.url}`).join("\n"));
else if (cmd === "list") { const l = store.publicList(); out(l, l.map((c) => `${c.id.padEnd(20)} ${c.status.padEnd(11)} ${String((c.tools || []).length).padStart(3)} tools  ${c.enabled ? "on " : "off"}  ${c.kind === "local" ? "local " + (c.local?.baseUrl || "") : c.url}`).join("\n") || "no connectors"); }
else if (cmd === "test" && arg) { const r = await probe(await store.probeTarget(arg)); out(r, r.ok ? r.tools.map((t) => "  " + t.name).join("\n") + `\n${r.tools.length} tools in ${r.ms} ms` : "error: " + r.error); process.exit(r.ok ? 0 : 1); }
else if (cmd === "config") { const t = await store.turnConfig({ cwd: arg || process.cwd() }); const cfg = t ? JSON.parse(await readFile(t.file, "utf8")) : null; out({ ...t, env: Object.keys(t?.env || {}), config: cfg }, cfg ? JSON.stringify(cfg, null, 2) : "no connectors apply"); }
else { console.error("usage: bun connectors/cli.ts catalog|list|test <id>|config [cwd] [--json]"); process.exit(2); }
