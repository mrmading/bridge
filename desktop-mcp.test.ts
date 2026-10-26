// bun test desktop-mcp.test.ts: the screen tools speak MCP over stdio and map to xdotool
import { expect, test } from "bun:test";
import { join } from "node:path";
import { commandFor } from "./desktop-mcp.ts";

async function session(lines: any[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", join(import.meta.dir, "desktop-mcp.ts")], { stdin: "pipe", stdout: "pipe", env: { ...process.env, BRIDGE_DESKTOP_DRY: "1", ...env } });
  for (const l of lines) p.stdin.write(JSON.stringify(l) + "\n");
  p.stdin.end();
  const out = await new Response(p.stdout).text();
  return out.trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
}

test("initialize, list and call over stdio", async () => {
  const r = await session([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { x: 10, y: 20 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
  ]);
  expect(r.map((x) => x.id)).toEqual([1, 2, 3, 4]);
  expect(r[0].result.serverInfo.name).toBe("bridge-computer");
  expect(r[1].result.tools.map((t: any) => t.name)).toEqual(["screenshot", "click", "move", "type", "key", "scroll"]);
  expect(r[2].result.content[0].text).toContain("mousemove");
  expect(r[3].error.code).toBe(-32602);
});

test("while the user holds control every tool refuses", async () => {
  const r = await session([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "type", arguments: { text: "x" } } }], { BRIDGE_DESKTOP_DRY_CONTROL: "1" });
  expect(r[0].result.isError).toBe(true);
  expect(r[0].result.content[0].text).toMatch(/taken control/);
});

test("xdotool argv", () => {
  expect(commandFor("click", { x: 10.4, y: 20, button: "right" })).toEqual([["xdotool", "mousemove", "10", "20", "click", "3"]]);
  expect(commandFor("click", { x: 1, y: 2, double: true })[0]).toContain("--repeat");
  expect(commandFor("type", { text: "-rf hi" })).toEqual([["xdotool", "type", "--delay", "12", "--", "-rf hi"]]);
  expect(commandFor("key", { keys: "ctrl+l Return" })).toEqual([["xdotool", "key", "--", "ctrl+l", "Return"]]);
  expect(commandFor("scroll", { x: 5, y: 6, direction: "up", amount: 99 })).toEqual([["xdotool", "mousemove", "5", "6", "click", "--repeat", "30", "4"]]);
});
