// bun test media.test.ts — videos are previewable binaries and /api/raw serves them with HTTP Range (seeking, Safari)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let dir = "", data = "", proc: any, base = "";
const BYTES = new Uint8Array(4096).map((_, i) => i % 251);

beforeAll(async () => {
  // roots must live under $HOME, so the scratch folder does too
  await mkdir(join(homedir(), ".cache"), { recursive: true });
  dir = await mkdtemp(join(homedir(), ".cache", "bridge-media-test-"));
  data = join(dir, "data");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "roots.json"), JSON.stringify([dir]));
  for (const ext of ["mp4", "webm", "mov", "m4v", "ogv"]) await writeFile(join(dir, "clip." + ext), BYTES);
  await writeFile(join(dir, "big.mp4"), new Uint8Array(900_000));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = "http://127.0.0.1:" + port;
  const env: Record<string, string> = { ...process.env as any, BRIDGE_PORT: String(port), BRIDGE_DATA: data };
  delete env.BRIDGE_SUPABASE_URL; delete env.BRIDGE_SUPABASE_KEY;   // auth off for this throwaway instance
  proc = Bun.spawn(["bun", "server.ts"], { cwd: import.meta.dir, env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/authconfig")).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, 20000);
afterAll(async () => { proc?.kill(); await rm(dir, { recursive: true, force: true }); });

const file = (name: string) => fetch(base + "/api/file?path=" + encodeURIComponent(join(dir, name))).then((r) => r.json());

test("/api/file marks every video extension binary with a raw url, even when large", async () => {
  for (const n of ["clip.mp4", "clip.webm", "clip.mov", "clip.m4v", "clip.ogv", "big.mp4"]) {
    const d: any = await file(n);
    expect(d.binary).toBe(true);
    expect(d.url).toStartWith("/api/raw?path=");
    expect(d.text).toBeUndefined();
  }
});

test("/api/raw answers a Range request with 206, Content-Range and the exact bytes", async () => {
  const r = await fetch(base + "/api/raw?path=" + encodeURIComponent(join(dir, "clip.mp4")), { headers: { range: "bytes=100-199" } });
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe("bytes 100-199/4096");
  expect(r.headers.get("accept-ranges")).toBe("bytes");
  expect(r.headers.get("content-type")).toBe("video/mp4");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual(Array.from(BYTES.slice(100, 200)));
});

test("/api/raw sets an explicit video content-type per extension", async () => {
  const want: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg" };
  for (const [ext, type] of Object.entries(want)) {
    const r = await fetch(base + "/api/raw?path=" + encodeURIComponent(join(dir, "clip." + ext)));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe(type);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    await r.arrayBuffer();
  }
});

test("/api/raw: an unsatisfiable range is 416; outside the roots is still 403", async () => {
  const r = await fetch(base + "/api/raw?path=" + encodeURIComponent(join(dir, "clip.mp4")), { headers: { range: "bytes=99999-" } });
  expect(r.status).toBe(416);
  const o = await fetch(base + "/api/raw?path=" + encodeURIComponent("/etc/hostname"));
  expect(o.status).toBe(403);
});
