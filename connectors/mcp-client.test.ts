import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHttp, probeStdio } from "./mcp-client.ts";
import { handle } from "./runtime.ts";
import { ConnectorStore } from "./store.ts";

describe("runtime", () => {
  const srv = { name: "t", tools: [{ name: "echo", description: "echo", run: (a: any) => ({ got: a.x }) }, { name: "boom", description: "fails", run: () => { throw new Error("nope"); } }] };
  test("speaks initialize, tools/list and tools/call", async () => {
    expect((await handle(srv, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.serverInfo.name).toBe("t");
    expect((await handle(srv, { jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.map((t: any) => t.name)).toEqual(["echo", "boom"]);
    expect((await handle(srv, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { x: 7 } } })).result.content[0].text).toContain('"got": 7');
    const bad = await handle(srv, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom" } });
    expect(bad.result.isError).toBe(true);
    expect(await handle(srv, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
});

describe("probe", () => {
  test("lists the tools of a scaffolded local connector over stdio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-probe-"));
    const store = new ConnectorStore(dir);
    await store.load();
    const c = await store.add({ name: "jp", local: { mode: "api", baseUrl: "https://jsonplaceholder.typicode.com", authKind: "none" } });
    const r = await probeStdio({ type: "stdio", command: process.execPath, args: [store.serverFile(c.id)] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tools.map((t) => t.name)).toEqual(["request"]);
  });

  test("a server that is not MCP reports an error, not a hang", async () => {
    const r = await probeStdio({ type: "stdio", command: process.execPath, args: ["-e", "process.exit(3)"] }, 5000);
    expect(r.ok).toBe(false);
  });

  test.skipIf(!!process.env.OFFLINE)("lists DeepWiki's tools over streamable HTTP, no auth", async () => {
    const r = await probeHttp({ type: "http", url: "https://mcp.deepwiki.com/mcp" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tools.map((t) => t.name)).toContain("read_wiki_structure");
  }, 30_000);

  test.skipIf(!!process.env.OFFLINE)("an OAuth server without a token says it needs sign-in", async () => {
    const r = await probeHttp({ type: "http", url: "https://mcp.linear.app/mcp" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needsAuth).toBe(true);
  }, 30_000);
});
