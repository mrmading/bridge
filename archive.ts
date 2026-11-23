// archive.ts — Bridge's thread archive policy.
//
// A thread that has been inactive for BRIDGE_ARCHIVE_DAYS (default 30) becomes archived: every base64
// image in its transcript — the screenshots tools return inside tool_result blocks, and the rare image
// the user pasted — is replaced by a short text description, the original file is kept gzipped so the
// step is reversible, and the thread is written to an index the server reads to flag it. Claude Code
// still resumes an archived thread: a text block inside tool_result content is valid API content.
//
//   bun archive.ts scan   [--days 30] [--session ID]                         dry run — nothing is written
//   bun archive.ts run    [--days 30] [--limit N] [--session ID] [--redo-failed] [--concurrency 2]
//   bun archive.ts status
//   bun archive.ts restore --session ID                                      put the original back
//   bun archive.ts purge-originals --older-than DAYS                        the only path that deletes originals
//
// Env: BRIDGE_ARCHIVE_DAYS · BRIDGE_ARCHIVE_CONCURRENCY · BRIDGE_ARCHIVE_KEEP_ORIGINALS (0 deletes) ·
//      BRIDGE_ARCHIVE_TIMEOUT_MS · BRIDGE_DATA · BRIDGE_CLAUDE_BIN · BRIDGE_PROJECTS_DIR (tests)

import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/* ───────────────────────────── types ───────────────────────────── */

export type ImageKind = "screenshot" | "upload";
export type Image = { sha: string; mediaType: string; data: string; kind: ImageKind; bytes: number };
/** what surrounds an image in the transcript: the tool that produced it and the text lines beside it */
export type ImageContext = { sessionId: string; key: string; file: string; line: number; tool?: { name: string; input: any }; before: string; after: string; isError?: boolean };
export type DescribeFn = (image: Image, ctx: ImageContext) => Promise<string>;

export type Options = {
  projectsDir: string;
  dataDir: string;
  days?: number;
  concurrency?: number;
  keepOriginals?: boolean;
  timeoutMs?: number;
  describe?: DescribeFn;
  isRunning?: (sessionId: string) => boolean;
  now?: () => number;
  log?: (kind: string, msg: string, extra?: Record<string, any>) => void;
  claudeBin?: string;
};

export type ThreadFile = { path: string; rel: string; size: number; mtime: number; last: number };
export type Thread = { sessionId: string; key: string; dir: string; files: ThreadFile[]; lastActive: number };

type FileRecord = { rel: string; images: number; bytesBefore: number; bytesAfter: number; mtime: number; original: boolean };
export type IndexEntry = {
  sessionId: string; key: string; archivedAt: number; images: number; unique: number; bytesBefore: number; bytesAfter: number; failed: number;
  files: FileRecord[]; originals: boolean; restoredAt?: number; redoneAt?: number;
};
type RunRecord = { at: number; ms: number; mode: "run" | "redo"; threads: number; images: number; bytesSaved: number; failed: number; skipped: number; error?: string };
type Index = { version: 1; threads: Record<string, IndexEntry>; runs: RunRecord[] };
type Description = { text: string; kind: ImageKind; at: number; model: string; failed?: boolean };

export type ScanRow = { sessionId: string; key: string; lastActive: number; days: number; files: number; images: number; unique: number; bytes: number; reason?: string };
export type ScanResult = { days: number; qualifying: ScanRow[]; excluded: ScanRow[]; images: number; unique: number; bytes: number; bytesSaved: number };
export type RunResult = { archived: IndexEntry[]; skipped: { sessionId: string; reason: string }[]; images: number; bytesSaved: number; failed: number; ms: number };

/* ───────────────────────── small utilities ───────────────────────── */

const DAY = 86400_000;
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const isImageBlock = (o: any) => !!o && typeof o === "object" && o.type === "image" && o.source?.type === "base64" && typeof o.source.data === "string" && o.source.data.length > 0;

/** lines of a file, streamed; `trailingNewline` is known once the generator is done */
class LineReader {
  trailingNewline = false;
  count = 0;
  constructor(private path: string) {}
  async *lines(): AsyncGenerator<string> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of Bun.file(this.path).stream()) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { this.count++; yield buf.slice(0, i); buf = buf.slice(i + 1); }
    }
    buf += dec.decode();
    if (buf.length) { this.count++; this.trailingNewline = false; yield buf; } else this.trailingNewline = this.count > 0;
  }
}

/** the newest `timestamp` in the file's last 64 KB, else its mtime */
async function lastTimestamp(path: string, mtime: number): Promise<number> {
  try {
    const f = Bun.file(path);
    const start = Math.max(0, f.size - 65536);
    const tail = (await f.slice(start, f.size).text()).split("\n").filter(Boolean);
    for (let i = tail.length - 1; i >= 0; i--) {
      try { const ts = Date.parse(JSON.parse(tail[i]).timestamp); if (ts > 0) return ts; } catch {}
    }
  } catch {}
  return mtime;
}

const INPUT_KEYS = ["url", "file_path", "path", "notebook_path", "command", "description", "selector", "element", "query", "pattern", "prompt", "name", "ref"];
/** the parts of a tool input a description needs: URL, path, command — never the whole payload */
export function briefInput(input: any): string {
  if (!input || typeof input !== "object") return "";
  const out: string[] = [];
  for (const k of INPUT_KEYS) {
    const v = (input as any)[k];
    if (v === undefined || v === null || v === "") continue;
    out.push(k + ": " + (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").slice(0, 160));
  }
  return out.join(" · ");
}
function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === "text" ? b.text : b?.type === "tool_use" ? b.name + " " + briefInput(b.input) : b?.type === "tool_result" ? textOf(b.content) : "")).filter(Boolean).join(" ");
  return "";
}
/** one short line of plain text for a transcript record — context for the describer */
export function snippet(r: any): string {
  const s = textOf(r?.message?.content);
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
const shortTool = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(/^mcp__/, "");

/** the cheap label used when no description could be produced: what made the image, of what */
export function fallbackLabel(image: Image, ctx: ImageContext): string {
  const kb = Math.max(1, Math.round((image.bytes * 3) / 4 / 1024));
  if (image.kind === "upload") return `image pasted by the user (${image.mediaType}, ~${kb} KB; not described)`;
  const t = ctx.tool;
  const target = t ? String(t.input?.url || t.input?.file_path || t.input?.path || t.input?.command || "").replace(/\s+/g, " ").slice(0, 160) : "";
  return `screenshot${t ? " from " + shortTool(t.name) : ""}${target ? " of " + target : ""} (${image.mediaType}, ~${kb} KB; not described)`;
}
export const archivedText = (kind: ImageKind, description: string) => `[${kind === "upload" ? "image" : "screenshot"} archived: ${description}]`;

/** every base64 image in one parsed transcript line, with a setter that swaps it for a text block */
type Found = { image: Image; toolUseId?: string; isError?: boolean; replace: (text: string) => void };
export function findImages(r: any): Found[] {
  const out: Found[] = [];
  const content = r?.message?.content;
  const walk = (node: any, set: (v: any) => void, topLevelUser: boolean, toolUseId?: string, isError?: boolean) => {
    if (!node || typeof node !== "object") return;
    if (isImageBlock(node)) {
      const data: string = node.source.data;
      const image: Image = { sha: sha256(data), mediaType: String(node.source.media_type || "image/png"), data, kind: topLevelUser ? "upload" : "screenshot", bytes: data.length };
      out.push({ image, toolUseId, isError, replace: (text) => set({ type: "text", text }) });
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, (nv) => { node[i] = nv; }, false, toolUseId, isError)); return; }
    const tid = node.type === "tool_result" ? String(node.tool_use_id || "") : toolUseId;
    const err = node.type === "tool_result" ? !!node.is_error : isError;
    for (const k of Object.keys(node)) walk(node[k], (nv) => { node[k] = nv; }, false, tid, err);
  };
  if (Array.isArray(content) && r.type === "user") {
    content.forEach((block: any, i: number) => {
      if (isImageBlock(block)) walk(block, (nv) => { content[i] = nv; }, true);
      else walk(block, (nv) => { content[i] = nv; }, false);
    });
    for (const k of Object.keys(r)) if (k !== "message") walk(r[k], (nv) => { r[k] = nv; }, false);
  } else {
    for (const k of Object.keys(r || {})) walk(r[k], (nv) => { r[k] = nv; }, false);
  }
  return out;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) await fn(items[i++]); });
  await Promise.all(workers);
}
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}
async function writeJsonAtomic(path: string, value: any) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}
async function gzipTo(src: string, dest: string) {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(tmp));
  await rename(tmp, dest);
}
async function gunzipTo(src: string, dest: string) {
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

/* ───────────────────── the default describer: claude -p ───────────────────── */

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export function contextText(ctx: ImageContext): string {
  const lines: string[] = [];
  if (ctx.tool) lines.push("Tool that produced it: " + ctx.tool.name + (briefInput(ctx.tool.input) ? " — " + briefInput(ctx.tool.input) : ""));
  if (ctx.isError) lines.push("The tool reported an error.");
  if (ctx.before) lines.push("Line before: " + ctx.before);
  if (ctx.after) lines.push("Line after: " + ctx.after);
  return lines.join("\n");
}
/** an answer that is about failing to see the image, not about the image — stored as a description it would be worse than the fallback */
const REFUSAL = /\b(?:I (?:can(?:'t|not)|couldn't|could not|was unable to|am unable to|'m unable to|don't have access)|unable to (?:read|load|view|see|open|process)|failed to (?:load|read|open|process)|could not (?:be )?(?:process|load|read)|no image (?:was )?(?:provided|attached|found)|image (?:is )?(?:corrupt|unsupported|missing))\b/i;
export const looksLikeRefusal = (text: string) => REFUSAL.test(text.slice(0, 240));
/** one `claude -p --model haiku` call per image: the signed-in CLI reads the image from a temp file and answers in plain text */
export function claudeDescribe(opts: { claudeBin?: string; timeoutMs?: number; env?: Record<string, string>; model?: string } = {}): DescribeFn {
  const bin = opts.claudeBin || process.env.BRIDGE_CLAUDE_BIN || "claude";
  const timeoutMs = opts.timeoutMs || Number(process.env.BRIDGE_ARCHIVE_TIMEOUT_MS) || 120_000;
  const model = opts.model || "haiku";
  return async (image, ctx) => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-archive-"));
    try {
      const file = join(dir, "image." + (EXT[image.mediaType] || "png"));
      await writeFile(file, Buffer.from(image.data, "base64"));
      const prompt = `Use the Read tool on ${file}, then describe what the ${image.kind === "upload" ? "image" : "screenshot"} shows in at most 3 sentences of plain text: ` +
        "the UI or page, the key visible text, and any error or notable state. Reply with the description only — no preamble, no markdown, no quotes.\n\n" +
        "Context from the chat transcript this image came from:\n" + (contextText(ctx) || "(none)");
      const proc = Bun.spawn([bin, "-p", "--model", model, "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
        "--tools", "Read", "--allowedTools", "Read", "--max-turns", "4"],
        { cwd: dir, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(opts.env || {}) } as any });
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      if (code !== 0) throw new Error("claude exited " + code + (err.trim() ? ": " + err.trim().slice(0, 200) : ""));
      const text = out.replace(/^["'`*#\s]+|["'`*\s]+$/g, "").replace(/\s+/g, " ").trim();
      if (!text) throw new Error("claude returned no text");
      if (looksLikeRefusal(text)) throw new Error("claude could not read the image: " + text.slice(0, 160));
      return text.slice(0, 600);
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  };
}

/* ───────────────────────────── the archiver ───────────────────────────── */

export function createArchiver(o: Options) {
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const days = o.days ?? (Number(process.env.BRIDGE_ARCHIVE_DAYS) || 30);
  const concurrency = o.concurrency ?? (Number(process.env.BRIDGE_ARCHIVE_CONCURRENCY) || 2);
  const keepOriginals = o.keepOriginals ?? process.env.BRIDGE_ARCHIVE_KEEP_ORIGINALS !== "0";
  const timeoutMs = o.timeoutMs ?? (Number(process.env.BRIDGE_ARCHIVE_TIMEOUT_MS) || 120_000);
  const isRunning = o.isRunning || (() => false);
  const describe: DescribeFn = o.describe || claudeDescribe({ claudeBin: o.claudeBin, timeoutMs });
  const root = join(o.dataDir, "archive");
  const INDEX = join(root, "index.json"), DESCRIPTIONS = join(root, "descriptions.json"), LOG = join(root, "log.jsonl"), LOCK = join(root, "lock"), ORIGINALS = join(root, "originals");

  let index: Index | null = null, indexMtime = 0, indexChecked = 0;
  let descriptions: Record<string, Description> | null = null;
  let busy: Promise<any> | null = null;
  let lastRun: RunRecord | null = null;

  async function loadIndex(force = false): Promise<Index> {
    if (index && !force) return index;
    index = await readJson<Index>(INDEX, { version: 1, threads: {}, runs: [] });
    index.threads ||= {}; index.runs ||= [];
    indexMtime = (await stat(INDEX).catch(() => null))?.mtimeMs || 0;
    return index;
  }
  async function saveIndex() { await writeJsonAtomic(INDEX, index); indexMtime = (await stat(INDEX).catch(() => null))?.mtimeMs || 0; }
  async function loadDescriptions() { return (descriptions ||= await readJson<Record<string, Description>>(DESCRIPTIONS, {})); }
  async function saveDescriptions() { if (descriptions) await writeJsonAtomic(DESCRIPTIONS, descriptions); }
  async function appendLog(row: Record<string, any>) {
    await mkdir(root, { recursive: true });
    await writeFile(LOG, JSON.stringify({ ts: now(), ...row }) + "\n", { flag: "a" });
  }

  /** synchronous view for the server's listings; re-read when another process (the CLI) rewrote index.json */
  function isArchived(sessionId: string): boolean {
    const t = now();
    if (t - indexChecked > 15_000) {
      indexChecked = t;
      try { const m = statSync(INDEX).mtimeMs; if (m !== indexMtime) { index = null; loadIndex().catch(() => {}); } } catch {}
    }
    const e = index?.threads[sessionId];
    return !!e && !e.restoredAt;
  }

  /* ── discovery ── */
  async function listThreads(onlySession?: string): Promise<Thread[]> {
    const out: Thread[] = [];
    const dirs = await readdir(o.projectsDir, { withFileTypes: true }).catch(() => [] as any[]);
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = join(o.projectsDir, d.name);
      const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
      for (const f of names) {
        const sessionId = basename(f, ".jsonl");
        if (onlySession && sessionId !== onlySession) continue;
        const paths = [join(dir, f)];
        const subDir = join(dir, sessionId, "subagents");
        for (const s of (await readdir(subDir).catch(() => [])).filter((x) => x.endsWith(".jsonl")).sort()) paths.push(join(subDir, s));
        const files: ThreadFile[] = [];
        for (const p of paths) {
          const st = await stat(p).catch(() => null);
          if (!st || !st.isFile()) continue;
          files.push({ path: p, rel: p.slice(dir.length + 1), size: st.size, mtime: st.mtimeMs, last: await lastTimestamp(p, st.mtimeMs) });
        }
        if (!files.length) continue;
        out.push({ sessionId, key: d.name, dir, files, lastActive: Math.max(...files.map((x) => x.last)) });
      }
    }
    return out.sort((a, b) => a.lastActive - b.lastActive);
  }
  function excluded(t: Thread, idx: Index, maxDays: number): string {
    const e = idx.threads[t.sessionId];
    if (e && !e.restoredAt) return "archived";
    if (e?.restoredAt && t.lastActive <= e.restoredAt) return "restored";
    if (isRunning(t.sessionId)) return "running";
    if (now() - t.lastActive < maxDays * DAY) return "active";
    return "";
  }

  /* ── one file: find the images, describe the new ones, write the rewritten copy beside it ── */
  type Prepared = { file: ThreadFile; tmp: string | null; images: number; unique: Set<string>; bytesAfter: number; failed: number; lines: number };
  async function prepareFile(t: Thread, file: ThreadFile, opts: { redo: boolean; seen: Set<string> }): Promise<Prepared> {
    const descs = await loadDescriptions();
    const ctxOf = (line: number, tool: any, isError?: boolean): ImageContext => ({ sessionId: t.sessionId, key: t.key, file: file.rel, line, tool, before: "", after: "", isError });
    // pass 1: which lines carry images, which shas still need a description (and the context to describe them with)
    const toolUses = new Map<string, { name: string; input: any }>();
    const need = new Map<string, { image: Image; ctx: ImageContext }>();
    const imageLines = new Set<number>();
    const unique = new Set<string>();
    let images = 0, prev = "", pendingAfter: ImageContext[] = [], n = 0;
    const r1 = new LineReader(file.path);
    for await (const raw of r1.lines()) {
      n++;
      if (!raw.trim()) continue;
      let r: any; try { r = JSON.parse(raw); } catch { prev = ""; continue; }
      const snip = snippet(r);
      for (const c of pendingAfter) c.after = snip;
      pendingAfter = [];
      if (r.type === "assistant" && Array.isArray(r.message?.content))
        for (const b of r.message.content) if (b?.type === "tool_use" && b.id) toolUses.set(String(b.id), { name: String(b.name || ""), input: b.input });
      if (raw.includes('"base64"')) {
        for (const f of findImages(r)) {
          images++; imageLines.add(n); unique.add(f.image.sha);
          const have = descs[f.image.sha];
          if (have && !(opts.redo && have.failed)) continue;
          if (need.has(f.image.sha)) continue;
          const ctx = ctxOf(n, f.toolUseId ? toolUses.get(f.toolUseId) : undefined, f.isError);
          ctx.before = prev; pendingAfter.push(ctx);
          need.set(f.image.sha, { image: f.image, ctx });
        }
      }
      prev = snip;
    }
    const prepared: Prepared = { file, tmp: null, images, unique, bytesAfter: file.size, failed: 0, lines: n };
    for (const s of unique) opts.seen.add(s);
    if (!images) return prepared;
    // describe what is new, a bounded number at a time, each with one retry and a cheap fallback
    let since = 0;
    await pool([...need.values()], concurrency, async ({ image, ctx }) => {
      let text = "", failed = false, error = "";
      for (let attempt = 0; attempt < 2 && !text; attempt++) {
        try { text = await describe(image, ctx); } catch (e: any) { error = String(e?.message || e).slice(0, 300); }
      }
      if (!text) { text = fallbackLabel(image, ctx); failed = true; }
      descs[image.sha] = { text, kind: image.kind, at: now(), model: failed ? "fallback" : "describe", ...(failed ? { failed: true } : {}) };
      if (failed) { await appendLog({ event: "describe_failed", sha: image.sha, sessionId: t.sessionId, file: file.rel, line: ctx.line, error }); log("archive.describe_failed", file.rel + ":" + ctx.line + " " + error, { session: t.sessionId }); }
      if (++since % 10 === 0) await saveDescriptions();
    });
    await saveDescriptions();
    // pass 2: rewrite — image lines re-serialised with text blocks in place of the images, every other line copied byte for byte
    const tmp = file.path + ".archive-" + process.pid + ".tmp";
    const w = Bun.file(tmp).writer();
    const r2 = new LineReader(file.path);
    let m = 0, failed = 0;
    for await (const raw of r2.lines()) {
      m++;
      let out = raw;
      if (imageLines.has(m)) {
        const r = JSON.parse(raw);
        for (const f of findImages(r)) {
          const d = descs[f.image.sha];
          if (d?.failed) failed++;
          f.replace(archivedText(f.image.kind, d?.text || fallbackLabel(f.image, ctxOf(m, undefined))));
        }
        out = JSON.stringify(r);
      }
      // newlines go between lines; whether the file ends with one is known only after the last chunk
      w.write(m > 1 ? "\n" + out : out);
    }
    if (r2.trailingNewline) w.write("\n");
    await w.end();
    // the file grew or shrank between the two passes: someone is writing it
    if (m !== n || r2.trailingNewline !== r1.trailingNewline) { await rm(tmp, { force: true }); throw Object.assign(new Error("changed"), { skipped: "changed during processing" }); }
    // verify: same number of lines, every non-blank one still JSON
    const r3 = new LineReader(tmp);
    let k = 0;
    for await (const line of r3.lines()) { k++; if (line.trim()) { try { JSON.parse(line); } catch { await rm(tmp, { force: true }); throw new Error("rewritten line " + k + " is not JSON in " + file.rel); } } }
    if (k !== n || r3.trailingNewline !== r1.trailingNewline) { await rm(tmp, { force: true }); throw new Error("rewritten " + file.rel + " has " + k + " lines, expected " + n); }
    return { ...prepared, tmp, bytesAfter: (await stat(tmp)).size, failed };
  }

  /** archive one thread: prepare every file, re-check nothing moved, then keep the originals and swap the files in */
  async function archiveThread(t: Thread, opts: { redo?: boolean } = {}): Promise<IndexEntry | { skipped: string }> {
    const idx = await loadIndex();
    const seen = new Set<string>();
    const prepared: Prepared[] = [];
    try {
      for (const f of t.files) prepared.push(await prepareFile(t, f, { redo: !!opts.redo, seen }));
      // a thread that moved under us (a resume, a sync) is left alone and tried again next run
      for (const f of t.files) {
        const st = await stat(f.path).catch(() => null);
        if (!st || st.mtimeMs !== f.mtime || st.size !== f.size) throw Object.assign(new Error("changed"), { skipped: "changed during processing" });
      }
      if (isRunning(t.sessionId)) throw Object.assign(new Error("running"), { skipped: "running" });
      const files: FileRecord[] = [];
      let images = 0, failed = 0, bytesBefore = 0, bytesAfter = 0;
      for (const p of prepared) {
        const rewritten = !!p.tmp, after = rewritten ? p.bytesAfter : p.file.size;
        images += p.images; failed += p.failed; bytesBefore += p.file.size; bytesAfter += after;
        let original = false;
        if (p.tmp) {
          const existing = idx.threads[t.sessionId];
          const alreadyKept = !!opts.redo && !!existing?.files.find((x) => x.rel === p.file.rel)?.original;
          if (keepOriginals && !alreadyKept) { await gzipTo(p.file.path, join(ORIGINALS, t.key, p.file.rel + ".gz")); original = true; }
          else original = alreadyKept;
          // the file keeps its dates: an archived thread must not jump to the top of every list sorted by mtime
          const st = await stat(p.file.path);
          await utimes(p.tmp, st.atime, st.mtime);
          await rename(p.tmp, p.file.path);
          p.tmp = null;
        }
        files.push({ rel: p.file.rel, images: p.images, bytesBefore: p.file.size, bytesAfter: after, mtime: p.file.mtime, original });
      }
      const prevEntry = idx.threads[t.sessionId];
      const entry: IndexEntry = {
        sessionId: t.sessionId, key: t.key, archivedAt: opts.redo && prevEntry ? prevEntry.archivedAt : now(), images, unique: seen.size,
        bytesBefore: opts.redo && prevEntry ? prevEntry.bytesBefore : bytesBefore, bytesAfter, failed, files, originals: files.some((f) => f.original),
        ...(opts.redo ? { redoneAt: now() } : {}),
      };
      idx.threads[t.sessionId] = entry;
      await saveIndex();
      await appendLog({ event: opts.redo ? "redone" : "archived", sessionId: t.sessionId, key: t.key, images, failed, bytesBefore, bytesAfter });
      log("archive.thread", t.sessionId.slice(0, 8) + " " + images + " images, " + fmtBytes(bytesBefore - bytesAfter) + " saved" + (failed ? ", " + failed + " not described" : ""), { session: t.sessionId });
      return entry;
    } catch (e: any) {
      for (const p of prepared) if (p.tmp) await rm(p.tmp, { force: true }).catch(() => {});
      const reason = e?.skipped || "error: " + String(e?.message || e).slice(0, 200);
      await appendLog({ event: "skipped", sessionId: t.sessionId, reason });
      log("archive.skip", t.sessionId.slice(0, 8) + " " + reason, { session: t.sessionId });
      return { skipped: reason };
    }
  }

  /* ── commands ── */
  async function scan(opts: { days?: number; session?: string } = {}): Promise<ScanResult> {
    const maxDays = opts.days ?? days;
    const idx = await loadIndex(true);
    const threads = await listThreads(opts.session);
    const res: ScanResult = { days: maxDays, qualifying: [], excluded: [], images: 0, unique: 0, bytes: 0, bytesSaved: 0 };
    const seen = new Set<string>();
    for (const t of threads) {
      const reason = excluded(t, idx, maxDays);
      const row: ScanRow = { sessionId: t.sessionId, key: t.key, lastActive: t.lastActive, days: Math.floor((now() - t.lastActive) / DAY), files: t.files.length, images: 0, unique: 0, bytes: 0 };
      if (reason) { res.excluded.push({ ...row, reason }); continue; }
      const u = new Set<string>();
      for (const f of t.files) {
        const r = new LineReader(f.path);
        for await (const raw of r.lines()) {
          if (!raw.includes('"base64"')) continue;
          let rec: any; try { rec = JSON.parse(raw); } catch { continue; }
          for (const img of findImages(rec)) { row.images++; row.bytes += img.image.bytes; u.add(img.image.sha); seen.add(img.image.sha); }
        }
      }
      row.unique = u.size;
      res.qualifying.push(row); res.images += row.images; res.bytes += row.bytes;
    }
    res.unique = seen.size;
    // what the rewrite leaves behind: a ~100-byte text block per image
    res.bytesSaved = Math.max(0, res.bytes - res.images * 120);
    return res;
  }

  async function run(opts: { days?: number; limit?: number; session?: string; redoFailed?: boolean } = {}): Promise<RunResult> {
    if (busy) return busy;
    busy = (async () => {
      const t0 = now();
      await mkdir(root, { recursive: true });
      try { await writeFile(LOCK, JSON.stringify({ pid: process.pid, at: t0 }), { flag: "wx" }); }
      catch {
        const lock = await readJson<{ at: number }>(LOCK, { at: 0 });
        if (now() - lock.at < 12 * 3600_000) throw new Error("another archive run holds " + LOCK);
        await writeFile(LOCK, JSON.stringify({ pid: process.pid, at: t0 }));
      }
      const result: RunResult = { archived: [], skipped: [], images: 0, bytesSaved: 0, failed: 0, ms: 0 };
      try {
        const idx = await loadIndex(true);
        descriptions = null; await loadDescriptions();
        const threads = await listThreads(opts.session);
        let todo: Thread[];
        if (opts.redoFailed) todo = threads.filter((t) => { const e = idx.threads[t.sessionId]; return e && !e.restoredAt && e.failed > 0; });
        else todo = threads.filter((t) => !excluded(t, idx, opts.days ?? days));
        if (opts.limit) todo = todo.slice(0, opts.limit);
        for (const t of todo) {
          if (opts.redoFailed) {
            const e = idx.threads[t.sessionId];
            if (!e.originals) { result.skipped.push({ sessionId: t.sessionId, reason: "originals purged — cannot redo" }); continue; }
            // the images live only in the originals now: stage them back, re-run the rewrite with the failed shas retried
            const staged = await stageOriginals(e);
            if (!staged) { result.skipped.push({ sessionId: t.sessionId, reason: "originals missing" }); continue; }
            const r = await archiveThread(staged, { redo: true });
            if ("skipped" in r) result.skipped.push({ sessionId: t.sessionId, reason: r.skipped }); else { result.archived.push(r); result.failed += r.failed; }
            continue;
          }
          const r = await archiveThread(t);
          if ("skipped" in r) result.skipped.push({ sessionId: t.sessionId, reason: r.skipped });
          else { result.archived.push(r); result.images += r.images; result.bytesSaved += r.bytesBefore - r.bytesAfter; result.failed += r.failed; }
        }
        result.ms = now() - t0;
        lastRun = { at: t0, ms: result.ms, mode: opts.redoFailed ? "redo" : "run", threads: result.archived.length, images: result.images, bytesSaved: result.bytesSaved, failed: result.failed, skipped: result.skipped.length };
        idx.runs = [...(idx.runs || []), lastRun].slice(-30);
        await saveIndex();
        return result;
      } catch (e: any) {
        lastRun = { at: t0, ms: now() - t0, mode: opts.redoFailed ? "redo" : "run", threads: 0, images: 0, bytesSaved: 0, failed: 0, skipped: 0, error: String(e?.message || e).slice(0, 300) };
        throw e;
      } finally {
        await rm(LOCK, { force: true }).catch(() => {});
      }
    })().finally(() => { busy = null; });
    return busy;
  }

  /** for --redo-failed: the archived thread's files, with the originals unpacked over them in place */
  async function stageOriginals(e: IndexEntry): Promise<Thread | null> {
    const dir = join(o.projectsDir, e.key);
    const files: ThreadFile[] = [];
    for (const f of e.files) {
      const path = join(dir, f.rel);
      if (f.original) {
        const gz = join(ORIGINALS, e.key, f.rel + ".gz");
        if (!existsSync(gz)) return null;
        const cur = await stat(path).catch(() => null);
        const tmp = path + ".restore-" + process.pid + ".tmp";
        await gunzipTo(gz, tmp);
        if (cur) await utimes(tmp, cur.atime, cur.mtime);
        await rename(tmp, path);
      }
      const st = await stat(path).catch(() => null);
      if (!st) return null;
      files.push({ path, rel: f.rel, size: st.size, mtime: st.mtimeMs, last: await lastTimestamp(path, st.mtimeMs) });
    }
    return { sessionId: e.sessionId, key: e.key, dir, files, lastActive: Math.max(...files.map((x) => x.last)) };
  }

  async function restore(sessionId: string): Promise<{ ok: boolean; files: number; error?: string }> {
    const idx = await loadIndex(true);
    const e = idx.threads[sessionId];
    if (!e) return { ok: false, files: 0, error: "not archived" };
    if (e.restoredAt) return { ok: false, files: 0, error: "already restored" };
    if (!e.originals) return { ok: false, files: 0, error: "originals were not kept (BRIDGE_ARCHIVE_KEEP_ORIGINALS=0) or were purged" };
    if (isRunning(sessionId)) return { ok: false, files: 0, error: "running" };
    let n = 0;
    for (const f of e.files) {
      if (!f.original) continue;
      const gz = join(ORIGINALS, e.key, f.rel + ".gz");
      if (!existsSync(gz)) return { ok: false, files: n, error: "original missing: " + gz };
      const path = join(o.projectsDir, e.key, f.rel);
      const tmp = path + ".restore-" + process.pid + ".tmp";
      await gunzipTo(gz, tmp);
      const d = new Date(f.mtime);
      await utimes(tmp, d, d);
      await rename(tmp, path);
      await rm(gz, { force: true });
      n++;
    }
    e.restoredAt = now(); e.originals = false;
    await saveIndex();
    await appendLog({ event: "restored", sessionId, files: n });
    log("archive.restore", sessionId.slice(0, 8) + " " + n + " files restored", { session: sessionId });
    return { ok: true, files: n };
  }

  async function purgeOriginals(olderThanDays: number): Promise<{ threads: number; files: number; bytes: number }> {
    const idx = await loadIndex(true);
    const out = { threads: 0, files: 0, bytes: 0 };
    for (const e of Object.values(idx.threads)) {
      if (!e.originals || e.restoredAt || now() - e.archivedAt < olderThanDays * DAY) continue;
      for (const f of e.files) {
        if (!f.original) continue;
        const gz = join(ORIGINALS, e.key, f.rel + ".gz");
        const st = await stat(gz).catch(() => null);
        if (st) { out.bytes += st.size; await rm(gz, { force: true }); }
        f.original = false; out.files++;
      }
      e.originals = false; out.threads++;
    }
    if (out.threads) { await saveIndex(); await appendLog({ event: "purged", ...out, olderThanDays }); }
    return out;
  }

  async function status() {
    const idx = await loadIndex(true);
    const entries = Object.values(idx.threads).filter((e) => !e.restoredAt);
    let originalsBytes = 0;
    for (const e of entries) if (e.originals) for (const f of e.files) if (f.original) originalsBytes += (await stat(join(ORIGINALS, e.key, f.rel + ".gz")).catch(() => null))?.size || 0;
    const descs = await readJson<Record<string, Description>>(DESCRIPTIONS, {});
    return {
      days, concurrency, keepOriginals,
      archived: entries.length, images: entries.reduce((a, e) => a + e.images, 0), bytesSaved: entries.reduce((a, e) => a + (e.bytesBefore - e.bytesAfter), 0),
      failed: entries.reduce((a, e) => a + e.failed, 0), descriptions: Object.keys(descs).length, descriptionsFailed: Object.values(descs).filter((d) => d.failed).length,
      originals: entries.filter((e) => e.originals).length, originalsBytes,
      restored: Object.values(idx.threads).filter((e) => e.restoredAt).length,
      running: !!busy, lastRun: lastRun || idx.runs?.[idx.runs.length - 1] || null, runs: (idx.runs || []).slice(-10),
      paths: { index: INDEX, descriptions: DESCRIPTIONS, log: LOG, originals: ORIGINALS },
    };
  }

  loadIndex().catch(() => {});   // so the server's first listing already knows which threads are archived
  return { scan, run, restore, purgeOriginals, status, isArchived, listThreads, loadIndex };
}

export function fmtBytes(n: number) {
  if (!isFinite(n)) return "0 B";
  const a = Math.abs(n);
  return a >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : a >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : a >= 1e3 ? (n / 1e3).toFixed(0) + " KB" : n + " B";
}

/* ───────────────────────────── CLI ───────────────────────────── */

function args(argv: string[]) {
  const flags: Record<string, string | boolean> = {}; const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith("--")) { flags[k] = v; i++; } else flags[k] = true; }
    else rest.push(a);
  }
  return { cmd: rest[0] || "", flags };
}

if (import.meta.main) {
  const { cmd, flags } = args(process.argv.slice(2));
  const home = homedir();
  const projectsDir = process.env.BRIDGE_PROJECTS_DIR || join(home, ".claude", "projects");
  const dataDir = process.env.BRIDGE_DATA || join(home, ".claude", "bridge");
  const num = (k: string) => (flags[k] !== undefined && flags[k] !== true ? Number(flags[k]) : undefined);
  const a = createArchiver({ projectsDir, dataDir, days: num("days"), concurrency: num("concurrency"), log: (k, m) => console.error(k + "  " + m) });
  const json = !!flags.json;
  const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  try {
    if (cmd === "scan") {
      const r = await a.scan({ days: num("days"), session: typeof flags.session === "string" ? flags.session : undefined });
      if (json) { console.log(JSON.stringify(r, null, 2)); }
      else {
        console.log(`Threads inactive ≥ ${r.days} days and not yet archived: ${r.qualifying.length}  (excluded: ${r.excluded.length} — ${count(r.excluded.map((e) => e.reason!))})`);
        for (const q of r.qualifying) console.log(`  ${q.sessionId}  ${q.key.slice(0, 40).padEnd(40)}  last ${when(q.lastActive)} (${q.days}d)  files ${q.files}  images ${q.images} (${q.unique} unique, ${fmtBytes(q.bytes)})`);
        console.log(`Images: ${r.images} (${r.unique} unique across threads) · base64 ${fmtBytes(r.bytes)} · would save ≈ ${fmtBytes(r.bytesSaved)} · descriptions to generate ≈ ${r.unique}`);
        console.log("Dry run — nothing was written.");
      }
    } else if (cmd === "run") {
      const r = await a.run({ days: num("days"), limit: num("limit"), session: typeof flags.session === "string" ? flags.session : undefined, redoFailed: !!flags["redo-failed"] });
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        for (const e of r.archived) console.log(`  archived ${e.sessionId}  ${e.images} images  ${fmtBytes(e.bytesBefore)} → ${fmtBytes(e.bytesAfter)}${e.failed ? "  " + e.failed + " not described" : ""}`);
        for (const s of r.skipped) console.log(`  skipped  ${s.sessionId}  ${s.reason}`);
        console.log(`${r.archived.length} threads · ${r.images} images · saved ${fmtBytes(r.bytesSaved)} · ${r.failed} fallback labels · ${(r.ms / 1000).toFixed(0)}s`);
      }
    } else if (cmd === "status") {
      const s = await a.status();
      if (json) console.log(JSON.stringify(s, null, 2));
      else {
        console.log(`policy: archive after ${s.days} days · concurrency ${s.concurrency} · originals ${s.keepOriginals ? "kept (gzip)" : "DELETED"}`);
        console.log(`archived threads: ${s.archived} · images replaced: ${s.images} · saved ${fmtBytes(s.bytesSaved)} · fallback labels pending redo: ${s.failed}`);
        console.log(`descriptions cached: ${s.descriptions} (${s.descriptionsFailed} failed) · originals kept for ${s.originals} threads (${fmtBytes(s.originalsBytes)}) · restored: ${s.restored}`);
        console.log(s.lastRun ? `last run: ${when(s.lastRun.at)} ${s.lastRun.mode} · ${s.lastRun.threads} threads · ${s.lastRun.images} images · ${(s.lastRun.ms / 1000).toFixed(0)}s${s.lastRun.error ? " · ERROR " + s.lastRun.error : ""}` : "last run: never");
        console.log(`index: ${s.paths.index}`);
      }
    } else if (cmd === "restore") {
      if (typeof flags.session !== "string") throw new Error("restore needs --session ID");
      const r = await a.restore(flags.session);
      console.log(r.ok ? `restored ${r.files} files for ${flags.session}` : `not restored: ${r.error}`);
      if (!r.ok) process.exit(1);
    } else if (cmd === "purge-originals") {
      const d = num("older-than");
      if (d === undefined || !isFinite(d)) throw new Error("purge-originals needs --older-than DAYS");
      const r = await a.purgeOriginals(d);
      console.log(`purged originals of ${r.threads} threads · ${r.files} files · ${fmtBytes(r.bytes)}`);
    } else {
      console.log("usage: bun archive.ts scan|run|status|restore|purge-originals  [--days N] [--limit N] [--session ID] [--redo-failed] [--concurrency N] [--older-than DAYS] [--json]");
      process.exit(cmd ? 2 : 0);
    }
  } catch (e: any) { console.error("archive: " + String(e?.message || e)); process.exit(1); }
}
function count(xs: string[]) { const m: Record<string, number> = {}; for (const x of xs) m[x] = (m[x] || 0) + 1; return Object.entries(m).map(([k, v]) => `${v} ${k}`).join(", ") || "none"; }
