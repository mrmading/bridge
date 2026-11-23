// bun test desktop.test.ts
import { describe, expect, test } from "bun:test";
import { RfbInputFilter, desktopConfig, mcpConfig, isDesktopTool } from "./desktop.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...xs: (Uint8Array | number[])[]) => {
  const parts = xs.map((x) => (x instanceof Uint8Array ? x : Uint8Array.from(x)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const flat = (xs: Uint8Array[]) => cat(...xs);
// a 3.8 client handshake: version, security type None (1), ClientInit shared=1
const HANDSHAKE = cat(enc("RFB 003.008\n"), [1], [1]);
const key = (down: number, sym: number) => [4, down, 0, 0, (sym >>> 24) & 255, (sym >>> 16) & 255, (sym >>> 8) & 255, sym & 255];
const pointer = (mask: number, x: number, y: number) => [5, mask, x >> 8, x & 255, y >> 8, y & 255];
const fbur = [3, 1, 0, 0, 0, 0, 5, 0, 3, 32];
const encodings = [2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21];
const cut = (s: string) => cat([6, 0, 0, 0, 0, 0, 0, s.length], enc(s));

describe("RfbInputFilter", () => {
  test("view-only passes the handshake and update requests, drops keys, pointer and clipboard", () => {
    const f = new RfbInputFilter(() => false);
    const out = flat(f.push(cat(HANDSHAKE, encodings, fbur, key(1, 0x61), pointer(1, 10, 20), cut("hi"), fbur)));
    expect(f.error).toBe("");
    expect(Array.from(out)).toEqual(Array.from(cat(HANDSHAKE, encodings, fbur, fbur)));
    expect(f.dropped).toBe(3);
  });

  test("in control everything passes through unchanged", () => {
    const f = new RfbInputFilter(() => true);
    const all = cat(HANDSHAKE, fbur, key(1, 0x61), key(0, 0x61), pointer(0, 300, 400), cut("hello"));
    expect(Array.from(flat(f.push(all)))).toEqual(Array.from(all));
  });

  test("messages split across frames are reassembled", () => {
    const f = new RfbInputFilter(() => true);
    const all = cat(HANDSHAKE, encodings, pointer(1, 1, 2), cut("abc"), fbur);
    const got: number[] = [];
    for (let i = 0; i < all.length; i += 3) got.push(...flat(f.push(all.slice(i, i + 3))));
    expect(got).toEqual(Array.from(all));
  });

  test("taking control mid-stream applies from the next message", () => {
    let control = false;
    const f = new RfbInputFilter(() => control);
    expect(flat(f.push(cat(HANDSHAKE, key(1, 0x61)))).length).toBe(HANDSHAKE.length);
    control = true;
    expect(Array.from(flat(f.push(Uint8Array.from(key(1, 0x62)))))).toEqual(key(1, 0x62));
  });

  test("an unknown message type closes the stream instead of guessing its length", () => {
    const f = new RfbInputFilter(() => true);
    f.push(HANDSHAKE);
    expect(flat(f.push(Uint8Array.from([99, 1, 2, 3]))).length).toBe(0);
    expect(f.error).toMatch(/unknown/);
  });

  test("RFB 3.3 (no client security byte) is understood", () => {
    const f = new RfbInputFilter(() => false);
    const all = cat(enc("RFB 003.003\n"), [1], fbur, key(1, 0x61));
    expect(Array.from(flat(f.push(all)))).toEqual(Array.from(cat(enc("RFB 003.003\n"), [1], fbur)));
  });
});

describe("config", () => {
  test("defaults and env overrides", () => {
    const d = desktopConfig({});
    expect(d.display).toBe(":99");
    expect(d.vncPort).toBe(5999);
    const o = desktopConfig({ BRIDGE_DESKTOP_DISPLAY: ":98", BRIDGE_DESKTOP_VNC_PORT: "5998", BRIDGE_DESKTOP_CDP_PORT: "9228", BRIDGE_DESKTOP_IDLE_MIN: "2" });
    expect([o.display, o.vncPort, o.cdpPort, o.idleMs]).toEqual([":98", 5998, 9228, 120_000]);
  });

  test("the MCP config points Playwright at Bridge's lazy CDP endpoint and gives both servers the display", () => {
    const cfg = desktopConfig({ HOME: "/home/sprite" });
    const m = mcpConfig(cfg, { base: "http://127.0.0.1:8080/desktop/k1", node: "/usr/bin/node", bun: "/usr/bin/bun", repo: "/r" });
    expect(m.mcpServers.browser.args).toContain("http://127.0.0.1:8080/desktop/k1/cdp");
    expect(m.mcpServers.browser.args[0]).toBe("/home/sprite/.bridge-desktop/mcp/node_modules/@playwright/mcp/cli.js");
    expect(m.mcpServers.browser.env.DISPLAY).toBe(":99");
    expect(m.mcpServers.computer.args).toEqual(["/r/desktop-mcp.ts"]);
    expect(m.mcpServers.computer.env.BRIDGE_DESKTOP_URL).toBe("http://127.0.0.1:8080/desktop/k1");
  });

  test("desktop tools are recognised by name", () => {
    expect(isDesktopTool("mcp__browser__browser_navigate")).toBe(true);
    expect(isDesktopTool("mcp__computer__screenshot")).toBe(true);
    expect(isDesktopTool("Bash")).toBe(false);
    expect(isDesktopTool("mcp__claude-in-chrome__navigate")).toBe(false);
  });
});
