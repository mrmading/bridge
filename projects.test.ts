// bun test projects.test.ts — delete and merge projects against a throwaway $HOME and a real server
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home = "", proc: any, base = "";
const key = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
let alpha = "", beta = "", gamma = "";

async function thread(cwd: string, id: string, text: string) {
  const dir = join(home, ".claude", "projects", key(cwd));
  await mkdir(dir, { recursive: true });
  const lines = [
    { type: "user", cwd, sessionId: id, message: { role: "user", content: text }, timestamp: new Date().toISOString() },
    { type: "assistant", cwd, sessionId: id, message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, timestamp: new Date().toISOString() },
  ];
  await writeFile(join(dir, id + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const post = (p: string, b: any) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const projects = async () => (await (await fetch(base + "/api/projects")).json()) as any[];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "bridge-projects-test-"));
  alpha = join(home, "work", "alpha"); beta = join(home, "work", "beta"); gamma = join(home, "work", "gamma");
  for (const d of [alpha, beta, gamma]) await mkdir(d, { recursive: true });
  await thread(alpha, "11111111-1111-4111-8111-111111111111", "alpha one");
  await thread(alpha, "22222222-2222-4222-8222-222222222222", "alpha two");
  await thread(beta, "33333333-3333-4333-8333-333333333333", "beta one");
  await thread(gamma, "44444444-4444-4444-8444-444444444444", "gamma one");
  const data = join(home, ".claude", "bridge");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "roots.json"), JSON.stringify([alpha, beta, gamma]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = "http://127.0.0.1:" + port;
  const env: Record<string, string> = { ...process.env as any, HOME: home, BRIDGE_PORT: String(port), BRIDGE_DATA: data };
  delete env.BRIDGE_SUPABASE_URL; delete env.BRIDGE_SUPABASE_KEY;
  proc = Bun.spawn(["bun", "server.ts"], { cwd: import.meta.dir, env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/authconfig")).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, 20000);
afterAll(async () => { proc?.kill(); await rm(home, { recursive: true, force: true }); });

test("merge moves every thread into the existing project, which keeps its own folder", async () => {
  const r = await post("/api/projects/merge", { from: key(alpha), fromPath: alpha, into: key(beta), intoPath: beta });
  expect(r.status).toBe(200);
  expect((await r.json()).threads).toBe(2);
  const list = await projects();
  expect(list.find((p) => p.path === alpha)).toBeUndefined();
  const b = list.find((p) => p.path === beta);
  expect(b.sessions).toBe(3);
  // the merged threads now resume in beta's folder
  const sessions = (await (await fetch(base + "/api/sessions?key=" + key(beta))).json()) as any[];
  expect(sessions.length).toBe(3);
  for (const s of sessions) expect(s.cwd).toBe(beta);
  // alpha's work folder is untouched; it is only gone from Bridge's folders
  expect(existsSync(alpha)).toBe(true);
  expect(await (await fetch(base + "/api/roots")).json()).toEqual([beta, gamma]);
});

test("delete moves the threads to Bridge's trash and leaves the folder on disk", async () => {
  const r = await post("/api/projects/delete", { key: key(gamma), path: gamma });
  expect(r.status).toBe(200);
  const j: any = await r.json();
  expect(j.threads).toBe(1);
  expect((await projects()).find((p) => p.path === gamma)).toBeUndefined();
  expect(existsSync(gamma)).toBe(true);
  expect(await readdir(j.trash)).toContain("44444444-4444-4444-8444-444444444444.jsonl");
  expect(await (await fetch(base + "/api/roots")).json()).toEqual([beta]);
});

test("bad input is refused", async () => {
  expect((await post("/api/projects/delete", { key: "../../etc", path: "/etc" })).status).toBe(409);
  expect((await post("/api/projects/merge", { from: key(beta), into: key(beta), intoPath: beta })).status).toBe(409);
});
