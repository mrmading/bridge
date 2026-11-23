// bun test archive.test.ts — the thread archive policy against a throwaway projects folder and a fake describer
import { beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile, appendFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { archivedText, briefInput, createArchiver, fallbackLabel, findImages, looksLikeRefusal, type DescribeFn, type Image, type ImageContext } from "./archive.ts";

const DAY = 86400_000;
const NOW = Date.parse("2026-11-24T12:00:00Z");
// a 1×1 PNG; a second image is the same PNG with one byte of pixel data flipped
const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let root = "", projects = "", data = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bridge-archive-test-"));
  projects = join(root, "projects"); data = join(root, "bridge");
  await mkdir(projects, { recursive: true }); await mkdir(data, { recursive: true });
});

const iso = (ms: number) => new Date(ms).toISOString();
const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
/** a thread: a question, a screenshot tool call and its image result, a reply — timestamps `ageDays` old */
function threadLines(id: string, ageDays: number, opts: { images?: string[]; upload?: string; cwd?: string } = {}) {
  const t = NOW - ageDays * DAY, cwd = opts.cwd || "/w/alpha";
  const imgs = opts.images ?? [PNG_A];
  const lines: any[] = [
    { type: "user", cwd, sessionId: id, uuid: id + "-1", timestamp: iso(t - 60_000), message: { role: "user", content: opts.upload ? [{ type: "text", text: "what is this?" }, image(opts.upload)] : "check the login page" } },
    { type: "assistant", cwd, sessionId: id, uuid: id + "-2", timestamp: iso(t - 50_000), message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_" + id + "_1", name: "mcp__playwright__browser_take_screenshot", input: { url: "https://app.example.test/login" } }] } },
    { type: "user", cwd, sessionId: id, uuid: id + "-3", timestamp: iso(t - 40_000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_" + id + "_1", content: [{ type: "text", text: "Screenshot taken" }, ...imgs.map(image)] }] }, toolUseResult: { ok: true } },
    { type: "assistant", cwd, sessionId: id, uuid: id + "-4", timestamp: iso(t), message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text: "The login page shows an error banner." }] } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
async function writeThread(key: string, id: string, ageDays: number, opts: { images?: string[]; upload?: string; subagent?: { ageDays: number; images?: string[] }; mtimeDays?: number } = {}) {
  const dir = join(projects, key);
  await mkdir(dir, { recursive: true });
  const file = join(dir, id + ".jsonl");
  await writeFile(file, threadLines(id, ageDays, opts));
  const m = new Date(NOW - (opts.mtimeDays ?? ageDays) * DAY);
  await utimes(file, m, m);
  if (opts.subagent) {
    const sub = join(dir, id, "subagents");
    await mkdir(sub, { recursive: true });
    const sf = join(sub, "agent-1.jsonl");
    await writeFile(sf, threadLines(id + "-sub", opts.subagent.ageDays, { images: opts.subagent.images ?? [PNG_A] }));
    const sm = new Date(NOW - opts.subagent.ageDays * DAY);
    await utimes(sf, sm, sm);
    return { file, sub: sf };
  }
  return { file, sub: "" };
}
const KEY = "-w-alpha";
const fake = (): DescribeFn & { calls: ImageContext[] } => {
  const fn: any = async (img: Image, ctx: ImageContext) => { fn.calls.push(ctx); return "Login page with a red error banner saying wrong password."; };
  fn.calls = [];
  return fn;
};
const make = (describe: DescribeFn, extra: Partial<Parameters<typeof createArchiver>[0]> = {}) =>
  createArchiver({ projectsDir: projects, dataDir: data, now: () => NOW, describe, concurrency: 2, ...extra });
const lines = async (f: string) => (await readFile(f, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
async function gunzip(p: string) { const chunks: Buffer[] = []; for await (const c of createReadStream(p).pipe(createGunzip())) chunks.push(c as Buffer); return Buffer.concat(chunks).toString("utf8"); }

test("qualification by age: 30 days default, --days overrides, young threads stay", async () => {
  await writeThread(KEY, "old-40", 40);
  await writeThread(KEY, "young-5", 5);
  await writeThread(KEY, "mid-20", 20);
  const a = make(fake());
  const s = await a.scan();
  expect(s.qualifying.map((q) => q.sessionId)).toEqual(["old-40"]);
  expect(s.excluded.find((e) => e.sessionId === "young-5")?.reason).toBe("active");
  expect(s.images).toBe(1); expect(s.bytes).toBe(PNG_A.length);
  expect((await a.scan({ days: 10 })).qualifying.map((q) => q.sessionId).sort()).toEqual(["mid-20", "old-40"]);
  // scan is dry: the file is untouched and nothing was indexed
  expect((await readFile(join(projects, KEY, "old-40.jsonl"), "utf8"))).toContain(PNG_A);
  expect(existsSync(join(data, "archive", "index.json"))).toBe(false);
  const r = await a.run();
  expect(r.archived.map((e) => e.sessionId)).toEqual(["old-40"]);
  expect((await a.run({ days: 10 })).archived.map((e) => e.sessionId)).toEqual(["mid-20"]);
});

test("the last line's timestamp decides, not a fresher mtime; mtime stands in when no line has one", async () => {
  await writeThread(KEY, "ts-old-mtime-new", 45, { mtimeDays: 1 });
  const dir = join(projects, KEY); await mkdir(dir, { recursive: true });
  const nots = join(dir, "no-ts.jsonl");
  await writeFile(nots, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  const m = new Date(NOW - 50 * DAY); await utimes(nots, m, m);
  const s = await make(fake()).scan();
  expect(s.qualifying.map((q) => q.sessionId).sort()).toEqual(["no-ts", "ts-old-mtime-new"]);
});

test("a parent and its subagent files archive together; inactivity counts the newest of them", async () => {
  await writeThread(KEY, "p1", 60, { subagent: { ageDays: 3 } });          // parent old, subagent fresh → not yet
  await writeThread(KEY, "p2", 60, { subagent: { ageDays: 35, images: [PNG_B] } });
  const d = fake();
  const a = make(d);
  const s = await a.scan();
  expect(s.qualifying.map((q) => q.sessionId)).toEqual(["p2"]);
  expect(s.qualifying[0].files).toBe(2); expect(s.qualifying[0].images).toBe(2); expect(s.qualifying[0].unique).toBe(2);
  const r = await a.run();
  expect(r.archived).toHaveLength(1);
  const e = r.archived[0];
  expect(e.files.map((f) => f.rel).sort()).toEqual(["p2.jsonl", "p2/subagents/agent-1.jsonl"]);
  for (const f of ["p2.jsonl", "p2/subagents/agent-1.jsonl"]) expect(await readFile(join(projects, KEY, f), "utf8")).not.toContain("iVBOR");
  expect(await readFile(join(projects, KEY, "p1.jsonl"), "utf8")).toContain(PNG_A);
  expect(await readFile(join(projects, KEY, "p1", "subagents", "agent-1.jsonl"), "utf8")).toContain(PNG_A);
  expect(a.isArchived("p2")).toBe(true); expect(a.isArchived("p1")).toBe(false);
});

test("images are described once per sha: repeats inside a thread and across threads hit the cache", async () => {
  await writeThread(KEY, "d1", 40, { images: [PNG_A, PNG_A, PNG_B], subagent: { ageDays: 40, images: [PNG_A] } });
  await writeThread(KEY, "d2", 41, { images: [PNG_B] });
  const d = fake();
  const r = await make(d).run();
  expect(r.images).toBe(5);
  expect(d.calls).toHaveLength(2);
  const cache = JSON.parse(await readFile(join(data, "archive", "descriptions.json"), "utf8"));
  expect(Object.keys(cache)).toHaveLength(2);
  expect(r.archived.find((e) => e.sessionId === "d1")?.unique).toBe(2);
  // the context handed to the describer names the tool and the lines around the image
  const ctx = d.calls[0];
  expect(ctx.tool?.name).toBe("mcp__playwright__browser_take_screenshot");
  expect(ctx.before).toContain("browser_take_screenshot");
  expect(ctx.before).toContain("url: https://app.example.test/login");
  expect(ctx.after).toContain("error banner");
});

test("rewrite: other lines byte-identical, image block → text block, tool_use/tool_result pairing intact, dates kept", async () => {
  const { file } = await writeThread(KEY, "rw", 40, { images: [PNG_A, PNG_B] });
  const before = (await readFile(file, "utf8")).split("\n");
  const st0 = await stat(file);
  const r = await make(fake()).run();
  expect(r.archived).toHaveLength(1);
  const raw = await readFile(file, "utf8");
  const after = raw.split("\n");
  expect(after).toHaveLength(before.length);                 // same line count, same trailing newline
  expect(raw.endsWith("\n")).toBe(true);
  for (const i of [0, 1, 3, 4]) expect(after[i]).toBe(before[i]);   // every non-image line unchanged byte for byte
  const parsed = after.filter(Boolean).map((l) => JSON.parse(l));
  const res = parsed[2].message.content[0];
  expect(res.type).toBe("tool_result"); expect(res.tool_use_id).toBe("toolu_rw_1");
  expect(res.content[0]).toEqual({ type: "text", text: "Screenshot taken" });
  expect(res.content[1]).toEqual({ type: "text", text: "[screenshot archived: Login page with a red error banner saying wrong password.]" });
  expect(res.content[2].type).toBe("text");
  expect(parsed[2].toolUseResult).toEqual({ ok: true });     // the rest of the line survives
  expect(parsed[2].uuid).toBe("rw-3"); expect(parsed[2].timestamp).toBe(JSON.parse(before[2]).timestamp);
  // every tool_result still answers a tool_use that precedes it, and nothing else changed shape
  const uses = new Set(parsed.flatMap((l) => (l.type === "assistant" ? l.message.content.filter((c: any) => c.type === "tool_use").map((c: any) => c.id) : [])));
  const results = parsed.flatMap((l) => (l.type === "user" && Array.isArray(l.message.content) ? l.message.content.filter((c: any) => c.type === "tool_result").map((c: any) => c.tool_use_id) : []));
  expect(results).toHaveLength(1); for (const id of results) expect(uses.has(id)).toBe(true);
  expect(JSON.stringify(raw)).not.toContain("iVBOR");
  const st1 = await stat(file);
  expect(st1.mtimeMs).toBe(st0.mtimeMs);
  expect(st1.size).toBeLessThan(st0.size);
  const e = r.archived[0];
  expect(e.bytesBefore).toBe(st0.size); expect(e.bytesAfter).toBe(st1.size); expect(e.images).toBe(2); expect(e.failed).toBe(0);
});

test("a pasted image in a user message becomes an [image archived: …] block", async () => {
  const { file } = await writeThread(KEY, "up", 40, { upload: PNG_B, images: [] });
  const d = fake();
  await make(d).run();
  const l = await lines(file);
  expect(l[0].message.content[1]).toEqual({ type: "text", text: archivedText("upload", "Login page with a red error banner saying wrong password.") });
  expect(d.calls[0].tool).toBeUndefined();
});

test("a file that changes while it is being processed is skipped and picked up next run", async () => {
  const { file } = await writeThread(KEY, "race", 40);
  let raced = false;
  const d: DescribeFn = async () => {
    if (!raced) { raced = true; await appendFile(file, JSON.stringify({ type: "user", timestamp: iso(NOW - 40 * DAY), message: { role: "user", content: "resumed" } }) + "\n"); }
    return "A page.";
  };
  const a = make(d);
  const r1 = await a.run();
  expect(r1.archived).toHaveLength(0);
  expect(r1.skipped).toEqual([{ sessionId: "race", reason: "changed during processing" }]);
  expect(await readFile(file, "utf8")).toContain(PNG_A);
  expect((await readdir(join(projects, KEY))).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  expect(a.isArchived("race")).toBe(false);
  const r2 = await a.run();
  expect(r2.archived.map((e) => e.sessionId)).toEqual(["race"]);
  expect((await lines(file))).toHaveLength(5);
});

test("originals are kept gzipped by default; restore puts them back byte for byte and holds the thread", async () => {
  const { file } = await writeThread(KEY, "keep", 40, { subagent: { ageDays: 40 } });
  const orig = await readFile(file, "utf8");
  const st0 = await stat(file);
  const a = make(fake());
  const r = await a.run();
  expect(r.archived[0].originals).toBe(true);
  const gz = join(data, "archive", "originals", KEY, "keep.jsonl.gz");
  expect(existsSync(gz)).toBe(true);
  expect(existsSync(join(data, "archive", "originals", KEY, "keep", "subagents", "agent-1.jsonl.gz"))).toBe(true);
  expect(await gunzip(gz)).toBe(orig);
  const st = await a.status();
  expect(st.archived).toBe(1); expect(st.originals).toBe(1); expect(st.originalsBytes).toBeGreaterThan(0);
  const res = await a.restore("keep");
  expect(res).toEqual({ ok: true, files: 2 });
  expect(await readFile(file, "utf8")).toBe(orig);
  expect((await stat(file)).mtimeMs).toBe(st0.mtimeMs);
  expect(existsSync(gz)).toBe(false);
  expect(a.isArchived("keep")).toBe(false);
  // a restored thread is not re-archived until it is active again
  expect((await a.scan()).excluded.find((e) => e.sessionId === "keep")?.reason).toBe("restored");
  expect((await a.run()).archived).toHaveLength(0);
  expect((await a.restore("keep")).error).toBe("already restored");
});

test("BRIDGE_ARCHIVE_KEEP_ORIGINALS=0: no copy, restore refuses", async () => {
  await writeThread(KEY, "nokeep", 40);
  const a = make(fake(), { keepOriginals: false });
  const r = await a.run();
  expect(r.archived[0].originals).toBe(false);
  expect(existsSync(join(data, "archive", "originals"))).toBe(false);
  expect((await a.restore("nokeep")).ok).toBe(false);
});

test("purge-originals deletes only originals older than the given age — nothing else does", async () => {
  await writeThread(KEY, "purge", 40);
  const a = make(fake());
  await a.run();
  const gz = join(data, "archive", "originals", KEY, "purge.jsonl.gz");
  expect(await a.purgeOriginals(1)).toEqual({ threads: 0, files: 0, bytes: 0 });  // archived just now: too young
  expect(existsSync(gz)).toBe(true);
  const p = await a.purgeOriginals(0);
  expect(p.threads).toBe(1); expect(p.files).toBe(1); expect(p.bytes).toBeGreaterThan(0);
  expect(existsSync(gz)).toBe(false);
  expect((await a.restore("purge")).ok).toBe(false);
  expect((await a.status()).originals).toBe(0);
});

test("describe failure: retried once, then a context label stands in, logged as describe_failed; --redo-failed fixes it from the original", async () => {
  const { file } = await writeThread(KEY, "fail", 40);
  let calls = 0;
  const broken: DescribeFn = async () => { calls++; throw new Error("claude exited 1"); };
  const a = make(broken);
  const r = await a.run();
  expect(calls).toBe(2);
  expect(r.failed).toBe(1); expect(r.archived[0].failed).toBe(1);
  const l = await lines(file);
  const block = l[2].message.content[0].content[1];
  expect(block.type).toBe("text");
  expect(block.text).toBe("[screenshot archived: screenshot from browser_take_screenshot of https://app.example.test/login (image/png, ~1 KB; not described)]");
  const cache = JSON.parse(await readFile(join(data, "archive", "descriptions.json"), "utf8"));
  expect(Object.values(cache)[0]).toMatchObject({ failed: true, model: "fallback" });
  const log = (await readFile(join(data, "archive", "log.jsonl"), "utf8")).split("\n").filter(Boolean).map((x) => JSON.parse(x));
  expect(log.find((x) => x.event === "describe_failed")).toMatchObject({ sessionId: "fail", file: "fail.jsonl", line: 3, error: "claude exited 1" });
  expect((await a.status()).failed).toBe(1);
  // a plain run leaves it alone (already archived); --redo-failed with a working describer rewrites from the kept original
  expect((await a.run()).archived).toHaveLength(0);
  const good = fake();
  const b = make(good);
  const r2 = await b.run({ redoFailed: true });
  expect(r2.archived).toHaveLength(1); expect(r2.archived[0].failed).toBe(0); expect(r2.archived[0].redoneAt).toBe(NOW);
  expect(good.calls).toHaveLength(1);
  const l2 = await lines(file);
  expect(l2[2].message.content[0].content[1].text).toBe("[screenshot archived: Login page with a red error banner saying wrong password.]");
  expect(await readFile(file, "utf8")).not.toContain("iVBOR");
  expect(existsSync(join(data, "archive", "originals", KEY, "fail.jsonl.gz"))).toBe(true);   // the original is still there
  expect((await b.status()).failed).toBe(0);
  expect((await b.run({ redoFailed: true })).archived).toHaveLength(0);                     // nothing left to redo
});

test("a thread the server is running is never archived, even when old", async () => {
  await writeThread(KEY, "live", 40);
  await writeThread(KEY, "idle", 40);
  const a = make(fake(), { isRunning: (id) => id === "live" });
  const s = await a.scan();
  expect(s.excluded.find((e) => e.sessionId === "live")?.reason).toBe("running");
  const r = await a.run();
  expect(r.archived.map((e) => e.sessionId)).toEqual(["idle"]);
  expect(await readFile(join(projects, KEY, "live.jsonl"), "utf8")).toContain(PNG_A);
});

test("--limit and --session narrow a run; the index records what the app needs", async () => {
  await writeThread(KEY, "a1", 40); await writeThread(KEY, "a2", 41); await writeThread(KEY, "a3", 42);
  const a = make(fake());
  expect((await a.run({ limit: 1 })).archived.map((e) => e.sessionId)).toEqual(["a3"]);   // oldest first
  expect((await a.run({ session: "a1" })).archived.map((e) => e.sessionId)).toEqual(["a1"]);
  const idx = JSON.parse(await readFile(join(data, "archive", "index.json"), "utf8"));
  expect(Object.keys(idx.threads).sort()).toEqual(["a1", "a3"]);
  expect(idx.threads.a1).toMatchObject({ sessionId: "a1", key: KEY, archivedAt: NOW, images: 1, failed: 0 });
  expect(idx.threads.a1.bytesBefore).toBeGreaterThan(idx.threads.a1.bytesAfter);
  expect(idx.runs).toHaveLength(2);
  const st = await a.status();
  expect(st.lastRun?.threads).toBe(1); expect(st.archived).toBe(2);
});

test("a thread without images still counts as archived, with nothing rewritten or copied", async () => {
  await writeThread(KEY, "plain", 40, { images: [] });
  const file = join(projects, KEY, "plain.jsonl");
  const before = await readFile(file, "utf8");
  const a = make(fake());
  const r = await a.run();
  expect(r.archived[0]).toMatchObject({ images: 0, originals: false, bytesBefore: before.length, bytesAfter: before.length });
  expect(await readFile(file, "utf8")).toBe(before);
  expect(a.isArchived("plain")).toBe(true);
});

test("helpers: image discovery, brief inputs, fallback labels", () => {
  const r = { type: "user", message: { role: "user", content: [image(PNG_A), { type: "tool_result", tool_use_id: "t1", is_error: true, content: [image(PNG_B)] }] }, toolUseResult: { nested: [image(PNG_A)] } };
  const found = findImages(r);
  expect(found.map((f) => f.image.kind)).toEqual(["upload", "screenshot", "screenshot"]);
  expect(found[1].toolUseId).toBe("t1"); expect(found[1].isError).toBe(true);
  expect(found[0].image.sha).toBe(found[2].image.sha);
  found[0].replace("x");
  expect(r.message.content[0]).toEqual({ type: "text", text: "x" });
  expect(briefInput({ url: "https://a.test/p", file_path: "/x/y.png", big: "z".repeat(999) })).toBe("url: https://a.test/p · file_path: /x/y.png");
  const img: Image = { sha: "s", mediaType: "image/png", data: PNG_A, kind: "screenshot", bytes: PNG_A.length };
  expect(fallbackLabel(img, { sessionId: "s", key: "k", file: "f", line: 1, before: "", after: "", tool: { name: "Read", input: { file_path: "/shots/a.png" } } })).toBe("screenshot from Read of /shots/a.png (image/png, ~1 KB; not described)");
  expect(fallbackLabel({ ...img, kind: "upload" }, { sessionId: "s", key: "k", file: "f", line: 1, before: "", after: "" })).toContain("image pasted by the user");
  // an answer about not seeing the image is a failure, not a description (seen for real: "Could not process image")
  expect(looksLikeRefusal("I couldn't describe the screenshot because the image failed to load. The API rejected the file with \"Could not process image\".")).toBe(true);
  expect(looksLikeRefusal("Unable to read the file: unsupported format.")).toBe(true);
  expect(looksLikeRefusal("Login page for app.example.test with an email field, a password field and a red banner reading Wrong password.")).toBe(false);
  expect(looksLikeRefusal("A terminal showing bun test output: 91 pass, 2 fail; the failures could not be reproduced locally.")).toBe(false);
});
