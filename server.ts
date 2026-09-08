#!/usr/bin/env bun
/**
 * Bridge — a native chat client for Claude Code + PAI.
 * Reads ~/.claude directly (projects, sessions, agents, skills, memory, instructions)
 * and drives the real `claude` CLI in stream-json mode. No cloud, no build step.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const PORT = Number(process.env.BRIDGE_PORT || 4270);
const UI_DIR = join(dirname(Bun.fileURLToPath(import.meta.url)), "public");
const CLAUDE_BIN = process.env.BRIDGE_CLAUDE_BIN || "claude";
/** Bridge is a GUI: interactive tools (AskUserQuestion, ExitPlanMode) are unavailable in -p mode,
 *  so the model hands choices and plans back in a shape the client renders as buttons and cards. */
const BRIDGE_PROTOCOL = [
  "You are running inside Bridge, a desktop GUI for Claude Code. The session is non-interactive: AskUserQuestion and",
  "ExitPlanMode are not available. Two conventions replace them:",
  "1. When you need the user to choose between options, end your reply with a fenced block whose info string is",
  "   `choices`, one short option per line (2-6 lines). Bridge renders them as buttons; the click becomes the next message.",
  "2. In plan mode, finish your reply with the complete plan as markdown under a heading that starts with `Plan`.",
  "   Bridge renders it as a plan card with Approve / Revise buttons; Approve sends the next message with edits enabled.",
].join("\n");

/* ────────────────────────────── helpers ────────────────────────────── */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const SENSITIVE = [/\/\.ssh\//, /\/\.aws\//, /\/\.gnupg\//, /\.credentials/, /id_rsa/, /\/\.env/, /\.pem$/, /keychain/i];
/** Bridge only ever touches the folders you have added — not the whole machine. */
let ROOTS: string[] = [];
function guard(p: string): string | null {
  const abs = resolve(p);
  for (const r of ROOTS) if (abs === r || abs.startsWith(r + sep)) return abs;
  return null;
}
const isSensitive = (p: string) => SENSITIVE.some((r) => r.test(p));

function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  let key = "";
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      key = m[1];
      out[key] = m[2].replace(/^["']|["']$/g, "").trim();
    } else if (key && /^\s+\S/.test(line)) {
      out[key] += " " + line.trim();
    }
  }
  return out;
}

const LANGS: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".json": "json",
  ".md": "markdown", ".html": "html", ".css": "css", ".py": "python", ".sh": "bash",
  ".yml": "yaml", ".yaml": "yaml", ".sql": "sql", ".dart": "dart", ".rs": "rust", ".go": "go",
  ".toml": "toml", ".jsonl": "json", ".txt": "text", ".svg": "xml",
};

/* ───────────────────────── projects & sessions ─────────────────────── */

type SessionMeta = {
  id: string; key: string; title: string; preview: string; mtime: number;
  size: number; turns: number; model?: string; cwd?: string; branch?: string; named?: boolean;
};

async function firstLines(file: string, bytes = 65536): Promise<string[]> {
  const f = Bun.file(file);
  const slice = await f.slice(0, Math.min(bytes, f.size)).text();
  return slice.split("\n").filter(Boolean);
}
async function lastLines(file: string, bytes = 40000): Promise<string[]> {
  const f = Bun.file(file);
  const start = Math.max(0, f.size - bytes);
  const slice = await f.slice(start, f.size).text();
  return slice.split("\n").slice(start ? 1 : 0).filter(Boolean);
}

/** Where Bridge keeps its own state. One store under ~/.claude, shared by the checkout and the
 *  packaged .app: a bundle-local dir would give the two copies different roots and titles, and
 *  would be wiped by every reinstall. A legacy .cache beside the source is migrated once. */
const LEGACY_DATA_DIRS = [
  join(dirname(Bun.fileURLToPath(import.meta.url)), ".cache"),                 // a checkout
  join(HOME, "Library", "Application Support", "Bridge"),                      // the pre-7.x packaged app
];
const DATA_DIR = process.env.BRIDGE_DATA || join(CLAUDE_DIR, "bridge");
try {
  await mkdir(DATA_DIR, { recursive: true });
  for (const f of ["roots.json", "titles.json", "session-meta.json"]) {
    if (existsSync(join(DATA_DIR, f))) continue;
    const from = LEGACY_DATA_DIRS.find((d) => existsSync(join(d, f)));
    if (from) await Bun.write(join(DATA_DIR, f), Bun.file(join(from, f)));
  }
} catch {}
const ROOTS_FILE = join(DATA_DIR, "roots.json");
const CACHE_FILE = join(DATA_DIR, "session-meta.json");
/** user-chosen session names. Claude Code owns the transcripts, so Bridge never rewrites
 *  them; a sidecar keyed by session id survives resume, compaction and cache eviction. */
const TITLES_FILE = join(DATA_DIR, "titles.json");
const customTitles = new Map<string, string>();
try {
  const disk = JSON.parse(await Bun.file(TITLES_FILE).text());
  for (const [k, v] of Object.entries(disk)) if (typeof v === "string") customTitles.set(k, v);
} catch {}
async function setTitle(id: string, title: string) {
  const t = title.trim().slice(0, 120);
  if (t) customTitles.set(id, t); else customTitles.delete(id);
  await Bun.write(TITLES_FILE, JSON.stringify(Object.fromEntries(customTitles), null, 2));
  return t;
}
const metaCache = new Map<string, { m: number; v: SessionMeta }>();
try {
  const disk = JSON.parse(await Bun.file(CACHE_FILE).text());
  for (const [k, v] of Object.entries(disk)) metaCache.set(k, v as any);
} catch {}
/** Defaults touch ~/Desktop, which macOS gates behind a TCC prompt. Resolving them at
 *  import time hangs a Finder-launched app before it can present that prompt, so the
 *  first-run defaults are computed lazily, on the first request. */
function defaultRoots(): string[] {
  return [join(HOME, "Desktop"), join(HOME, "Documents"), CLAUDE_DIR].filter((d) => existsSync(d));
}
async function readRoots(): Promise<string[]> {
  try {
    const r = JSON.parse(await Bun.file(ROOTS_FILE).text());
    if (Array.isArray(r) && r.length) return r.filter((x: string) => typeof x === "string");
  } catch {}
  return [];
}
let rootsReady = false;
async function ensureRoots() {
  if (rootsReady) return;
  rootsReady = true;
  if (!ROOTS.length) {
    ROOTS = defaultRoots();
    try { await Bun.write(ROOTS_FILE, JSON.stringify(ROOTS, null, 2)); } catch {}
  }
}
let saveTimer: any = null;
function persistCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await Bun.write(CACHE_FILE, JSON.stringify(Object.fromEntries(metaCache))); } catch {}
  }, 1500);
}
/** derived title + custom name, applied after the cache so a rename shows up without a rescan */
async function sessionMeta(key: string, file: string): Promise<SessionMeta | null> {
  const m = await computeMeta(key, file);
  if (!m) return null;
  const custom = customTitles.get(m.id);
  return custom ? { ...m, title: custom, named: true } : m;
}
async function computeMeta(key: string, file: string): Promise<SessionMeta | null> {
  const st = await stat(file).catch(() => null);
  if (!st || st.size === 0) return null;
  const cached = metaCache.get(file);
  if (cached && cached.m === st.mtimeMs) return cached.v;
  const id = basename(file, ".jsonl");
  const meta: SessionMeta = { id, key, title: "", preview: "", mtime: st.mtimeMs, size: st.size, turns: 0 };
  for (const line of await firstLines(file, 300_000)) {
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.cwd && !meta.cwd) { meta.cwd = r.cwd; meta.branch = r.gitBranch; }
    if (r.type === "ai-title" && r.aiTitle) meta.title = r.aiTitle;
    if (r.type === "user" && !r.isSidechain && typeof r.message?.content === "string") meta.turns++;
    if (!meta.preview && r.type === "user" && !r.isSidechain && typeof r.message?.content === "string")
      meta.preview = r.message.content.replace(/<[^>]+>/g, " ").slice(0, 220).trim();
    if (!meta.preview && r.type === "user" && Array.isArray(r.message?.content)) {
      const t = r.message.content.find((c: any) => c.type === "text");
      if (t) meta.preview = String(t.text).slice(0, 220).trim();
    }
  }
  // tail scan for the freshest title + model
  for (const line of await lastLines(file)) {
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "ai-title" && r.aiTitle) meta.title = r.aiTitle;
    if (r.type === "assistant" && r.message?.model) meta.model = r.message.model;
  }
  meta.title ||= meta.preview.slice(0, 60) || "Untitled session";
  metaCache.set(file, { m: st.mtimeMs, v: meta });
  persistCache();
  return meta;
}

async function listProjects() {
  const dirs = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const out: any[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, d.name);
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) continue;
    let latest = 0, cwd = "";
    for (const f of files) {
      const st = await stat(join(dir, f)).catch(() => null);
      if (st && st.mtimeMs > latest) latest = st.mtimeMs;
    }
    // resolve real cwd from the newest transcript
    const newest = (await Promise.all(files.map(async (f) => ({ f, m: (await stat(join(dir, f))).mtimeMs }))))
      .sort((a, b) => b.m - a.m)[0];
    if (newest) {
      for (const line of await firstLines(join(dir, newest.f), 20000)) {
        try { const r = JSON.parse(line); if (r.cwd) { cwd = r.cwd; break; } } catch {}
      }
    }
    if (!cwd) cwd = "/" + d.name.replace(/^-/, "").split("-").join("/");
    out.push({ key: d.name, path: cwd, name: basename(cwd) || cwd, sessions: files.length, lastActivity: latest, exists: existsSync(cwd) });
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

async function listSessions(key: string, limit = 200) {
  const dir = join(PROJECTS_DIR, key);
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
  const metas = (await Promise.all(files.map((f) => sessionMeta(key, join(dir, f))))).filter(Boolean) as SessionMeta[];
  return metas.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/* ────────────────── transcript → normalized chat events ────────────── */

type Ev = any;

function normalizeTranscript(lines: string[]) {
  const { events, meta } = normalizeLines(lines);
  return { events, meta };
}
/** One pass over a run of transcript lines. Used for whole files and, by the follower, for
 *  the lines appended since last time — so a tool result can arrive for a tool_use that was
 *  emitted in an earlier batch. Those come back as `patches` keyed by tool_use id. */
function normalizeLines(lines: string[]) {
  const events: Ev[] = [];
  const results = new Map<string, any>();
  const outputs: any[] = [];
  let model = "", cwd = "", branch = "", title = "";
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  const seenReq = new Set<string>();
  let hookCount = 0;

  for (const line of lines) {
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.cwd && !cwd) { cwd = r.cwd; branch = r.gitBranch; }
    if (r.type === "ai-title" && r.aiTitle) title = r.aiTitle;

    if (r.type === "user" && Array.isArray(r.message?.content)) {
      for (const c of r.message.content) {
        if (c.type === "tool_result") {
          results.set(c.tool_use_id, {
            content: flattenResult(c.content),
            isError: !!c.is_error,
            structured: r.toolUseResult ?? null,
            ts: r.timestamp,
          });
        }
      }
    }
  }

  for (const line of lines) {
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    const side = !!r.isSidechain;

    if (r.type === "user" && !side) {
      const c = r.message?.content;
      if (typeof c === "string") {
        const clean = c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        if (clean) events.push({ kind: "user", text: clean, ts: r.timestamp, uuid: r.uuid });
      } else if (Array.isArray(c)) {
        const texts = c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n").trim();
        const cleaned = texts.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        if (cleaned) events.push({ kind: "user", text: cleaned, ts: r.timestamp, uuid: r.uuid });
      }
    }

    if (r.type === "assistant") {
      if (r.message?.model) model = r.message.model;
      const req = r.requestId;
      if (req && !seenReq.has(req) && r.message?.usage) {
        seenReq.add(req);
        const u = r.message.usage;
        usage.input += u.input_tokens || 0;
        usage.output += u.output_tokens || 0;
        usage.cacheRead += u.cache_read_input_tokens || 0;
        usage.cacheWrite += u.cache_creation_input_tokens || 0;
        usage.thinking += u.output_tokens_details?.thinking_tokens || 0;
      }
      for (const c of r.message?.content || []) {
        if (c.type === "text" && c.text?.trim())
          events.push({ kind: side ? "agent_text" : "assistant", text: c.text, ts: r.timestamp, uuid: r.uuid, model: r.message.model });
        else if (c.type === "thinking" && c.thinking?.trim())
          events.push({ kind: "thinking", text: c.thinking, ts: r.timestamp, uuid: r.uuid, side });
        else if (c.type === "tool_use") {
          const res = results.get(c.id);
          const ev = { kind: "tool", name: c.name, input: c.input, id: c.id, ts: r.timestamp, side, result: res || null };
          events.push(ev);
          const path = c.input?.file_path || c.input?.notebook_path;
          if (path && ["Write", "Edit", "NotebookEdit"].includes(c.name)) outputs.push({ path, tool: c.name, ts: r.timestamp });
          if (c.name === "Artifact" && c.input?.file_path) outputs.push({ path: c.input.file_path, tool: "Artifact", ts: r.timestamp });
        }
      }
    }

    if (r.type === "attachment" && r.attachment?.type === "hook_success") hookCount++;
  }
  const seenTool = new Set(events.filter((e) => e.kind === "tool").map((e) => e.id));
  const patches = [...results.entries()].filter(([id]) => !seenTool.has(id)).map(([id, result]) => ({ id, result }));
  return { events, patches, meta: { model, cwd, branch, title, usage, outputs, hookCount } };
}

function flattenResult(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

/* ──────────────────── agents / skills / instructions ───────────────── */

/** group agents by what they are actually for.
 *  Teams are discovered, not hardcoded: when several agents share a leading name segment
 *  (PolarisSEO, PolarisContent, …) they become one group. */
const BY_NAME: [RegExp, string][] = [
  [/researcher$/i, "Research"],
  [/^(architect|engineer|plan|explore)$/i, "Engineering & architecture"],
  [/^(designer|artist)$/i, "Design & media"],
  [/^pentester$/i, "Security"],
  [/^qatester$/i, "Quality & testing"],
  [/^algorithm$/i, "Thinking & method"],
  [/^(intern|claude|general-purpose)$/i, "General purpose"],
  [/statusline|claude-code-guide/i, "Tooling"],
];
const BY_DESC: [RegExp, string][] = [
  [/pentest|offensive security|vulnerabilit/i, "Security"],
  [/quality assurance|regression|test suite/i, "Quality & testing"],
  [/cross-vendor|openai|xai grok|google gemini/i, "Cross-vendor models"],
  [/sales|prospect|pipeline|cold email/i, "Sales"],
  [/growth|marketing|instagram|social media|seo|copywrit/i, "Growth & marketing"],
  [/research|investigat|osint/i, "Research"],
  [/architecture|implementation plan|principal engineer|distributed systems/i, "Engineering & architecture"],
  [/design|visual|illustration|figma/i, "Design & media"],
  [/ideal state|first principles|reasoning|thinking/i, "Thinking & method"],
];
const TEAM_MIN = 3;
function leadWord(name: string): string {
  const m = name.match(/^[A-Z][a-z0-9]+(?=[A-Z])/);
  return m ? m[0] : "";
}
function teamIndex(names: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of names) {
    const w = leadWord(n);
    if (w) counts[w] = (counts[w] || 0) + 1;
  }
  return counts;
}
function agentCategory(name: string, desc: string, teams: Record<string, number>): string {
  const w = leadWord(name);
  if (w && (teams[w] || 0) >= TEAM_MIN) return w + " team";
  for (const [re, cat] of BY_NAME) if (re.test(name)) return cat;
  for (const [re, cat] of BY_DESC) if (re.test(desc)) return cat;
  return "General purpose";
}

async function collectAgents() {
  const roots = [
    { dir: join(CLAUDE_DIR, "agents"), source: "core" },
    { dir: join(CLAUDE_DIR, "custom-agents"), source: "custom" },
  ];
  const teamsDir = join(CLAUDE_DIR, "teams");
  for (const t of await readdir(teamsDir, { withFileTypes: true }).catch(() => []))
    if (t.isDirectory()) roots.push({ dir: join(teamsDir, t.name, "agents"), source: `team:${t.name}` });

  const out: any[] = [];
  for (const { dir, source } of roots) {
    for (const f of await readdir(dir).catch(() => [])) {
      if (!f.endsWith(".md")) continue;
      const p = join(dir, f);
      const text = await readFile(p, "utf8").catch(() => "");
      const fm = frontmatter(text);
      const nm = fm.name || basename(f, ".md");
      out.push({
        name: nm,
        description: fm.description || "",
        color: fm.color || "", model: fm.model || "", tools: fm.tools || "",
        voice: fm.voiceId || fm.voice_id || "", source, path: p,
        words: text.split(/\s+/).length,
      });
    }
  }
  const teams = teamIndex(out.map((a) => a.name));
  for (const a of out) a.category = agentCategory(a.name, a.description, teams);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectSkills() {
  const out: any[] = [];
  const push = async (dir: string, source: string) => {
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      const p = join(dir, d.name, "SKILL.md");
      if (!existsSync(p)) continue;
      const text = await readFile(p, "utf8").catch(() => "");
      const fm = frontmatter(text);
      const st = await stat(p);
      out.push({ name: fm.name || d.name, description: fm.description || "", source, path: p, mtime: st.mtimeMs, bytes: st.size });
    }
  };
  await push(join(CLAUDE_DIR, "skills"), "user");
  const plugins = join(CLAUDE_DIR, "plugins");
  for (const d of await readdir(plugins, { withFileTypes: true }).catch(() => []))
    if (d.isDirectory()) await push(join(plugins, d.name, "skills"), `plugin:${d.name}`);
  const teams = teamIndex(out.map((a) => a.name));
  for (const a of out) a.category = agentCategory(a.name, a.description, teams);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectInstructions() {
  const cands = [
    { label: "Global CLAUDE.md", path: join(CLAUDE_DIR, "CLAUDE.md"), tag: "core" },
    { label: "PAI SKILL.md", path: join(CLAUDE_DIR, "skills", "PAI", "SKILL.md"), tag: "pai" },
    { label: "settings.json", path: join(CLAUDE_DIR, "settings.json"), tag: "config" },
    { label: "settings.local.json", path: join(CLAUDE_DIR, "settings.local.json"), tag: "config" },
  ];
  const memDir = join(CLAUDE_DIR, "projects", "-Users-mrmading", "memory");
  for (const f of await readdir(memDir).catch(() => []))
    if (f.endsWith(".md")) cands.push({ label: f === "MEMORY.md" ? "MEMORY.md (index)" : f.replace(/\.md$/, ""), path: join(memDir, f), tag: f === "MEMORY.md" ? "memory-index" : "memory" });

  const out: any[] = [];
  for (const c of cands) {
    const st = await stat(c.path).catch(() => null);
    if (st) out.push({ ...c, bytes: st.size, mtime: st.mtimeMs });
  }
  return out;
}

async function collectHooks() {
  const s = await readFile(join(CLAUDE_DIR, "settings.json"), "utf8").catch(() => "{}");
  let parsed: any = {}; try { parsed = JSON.parse(s); } catch {}
  const hooks = parsed.hooks || {};
  return Object.entries(hooks).flatMap(([event, arr]: any) =>
    (Array.isArray(arr) ? arr : []).flatMap((m: any) =>
      (m.hooks || []).map((h: any) => ({ event, matcher: m.matcher || "*", type: h.type, command: h.command || "", timeout: h.timeout }))));
}


/* ─────────────────────── full-text session search ──────────────────── */
/** Claude Code ships ripgrep: invoking its binary with argv0 "rg" runs it. */
function ripgrep(args: string[]): Promise<string> {
  return new Promise((res) => {
    const child = spawn(CLAUDE_BIN, args, { argv0: "rg", stdio: ["ignore", "pipe", "ignore"] } as any);
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("close", () => res(out));
    child.on("error", () => res(""));
  });
}
const STOP = new Set("the a an and or of to in on for with that this it is was were be been are we i you my our your about from what where when how did do does".split(" "));
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const digestCache = new Map<string, { m: number; v: any }>();
async function digest(file: string, tokens: string[]) {
  const st = await stat(file).catch(() => null);
  if (!st) return null;
  const hit = digestCache.get(file);
  const base = hit && hit.m === st.mtimeMs ? hit.v : await buildDigest(file, st);
  if (!hit || hit.m !== st.mtimeMs) digestCache.set(file, { m: st.mtimeMs, v: base });
  // snippets are query-dependent, so they are computed fresh
  const snippets: string[] = [];
  if (tokens.length) {
    const re = new RegExp("(" + tokens.map(reEsc).join("|") + ")", "i");
    for (const txt of base.texts) {
      const m = txt.match(re);
      if (!m) continue;
      const i = Math.max(0, (m.index || 0) - 90);
      snippets.push((i ? "…" : "") + txt.slice(i, i + 220).replace(/\s+/g, " ").trim() + "…");
      if (snippets.length >= 3) break;
    }
  }
  return { first: base.first, last: base.last, tools: base.tools, files: base.files, snippets };
}
async function buildDigest(file: string, st: any) {
  const f = Bun.file(file);
  const CHUNK = 500_000;
  let raw = "";
  if (st.size <= CHUNK * 2) raw = await f.text();
  else raw = (await f.slice(0, CHUNK).text()) + "\n" + (await f.slice(st.size - CHUNK, st.size).text());
  const texts: string[] = [];
  const files = new Set<string>();
  let first = "", last = "", tools = 0;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "user" && !r.isSidechain && typeof r.message?.content === "string") {
      const t = r.message.content.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (t) { texts.push(t); if (!first) first = t; }
    } else if (r.type === "assistant") {
      for (const c of r.message?.content || []) {
        if (c.type === "text" && c.text?.trim()) { texts.push(c.text); last = c.text; }
        else if (c.type === "tool_use") {
          tools++;
          const fp = c.input?.file_path;
          if (fp && ["Write", "Edit", "NotebookEdit"].includes(c.name)) files.add(fp);
        }
      }
    }
  }
  const clean = (t: string) => t.replace(/[#*`>_]/g, "").replace(/\s+/g, " ").trim();
  return { texts, first: clean(first).slice(0, 240), last: clean(last).slice(0, 240), tools, files: [...files].slice(0, 8) };
}

/** Which transcript directories a scope covers. "folder" is the working directory of the
 *  session you are in, plus everything nested under it — searching ~/code finds the work you
 *  did in ~/code/api. An empty list means the folder has no history, so the caller widens. */
async function scopeDirs(scope: string, key: string, cwd: string): Promise<string[]> {
  if (scope === "project" && key) return [join(PROJECTS_DIR, key)];
  if (scope === "folder" && cwd) {
    const abs = resolve(cwd);
    return (await listProjects())
      .filter((p) => p.path === abs || p.path.startsWith(abs + sep))
      .map((p) => join(PROJECTS_DIR, p.key));
  }
  return [PROJECTS_DIR];
}

async function findSessions(q: string, scope: string, key: string, cwd = "") {
  const tokens = q.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const terms = (tokens.length ? tokens : q.trim() ? [q.trim()] : []).slice(0, 8);
  if (!terms.length) return [];
  const roots = await scopeDirs(scope, key, cwd);
  if (!roots.length) return [];

  // one pass per term, in parallel — per-term counts let us rank on coverage,
  // not on which transcript happens to repeat a single word the most
  const perTerm = await Promise.all(terms.map((t) =>
    ripgrep(["-c", "-i", "--no-messages", "-g", "*.jsonl", "-e", reEsc(t), ...roots])));

  const files = new Map<string, number[]>();
  perTerm.forEach((out, ti) => {
    for (const line of out.split("\n")) {
      const i = line.lastIndexOf(":");
      if (i < 0) continue;
      const file = line.slice(0, i), n = parseInt(line.slice(i + 1), 10);
      if (!file.endsWith(".jsonl") || !(n > 0)) continue;
      if (!files.has(file)) files.set(file, new Array(terms.length).fill(0));
      files.get(file)![ti] = n;
    }
  });

  const rough = [...files.entries()].map(([file, counts]) => {
    const covered = counts.filter((c) => c > 0).length;
    const total = counts.reduce((a, b) => a + b, 0);
    return { file, counts, covered, total, score: covered * 100 + Math.log1p(total) * 4 };
  }).sort((a, b) => b.score - a.score);

  const best = rough[0]?.covered || 0;
  const pool = rough.filter((r) => r.covered >= Math.max(1, Math.min(best, Math.ceil(terms.length / 2)))).slice(0, 40);

  const out2: any[] = [];
  for (const r of pool) {
    const pkey = basename(dirname(r.file));
    const meta = await sessionMeta(pkey, r.file);
    if (!meta) continue;
    const d = await digest(r.file, terms);
    const hay = (meta.title + " " + (d?.first || meta.preview)).toLowerCase();
    const titleHits = terms.filter((t) => hay.includes(t)).length;
    out2.push({
      ...meta,
      hits: r.total, covered: r.covered, terms: terms.length,
      score: r.score + titleHits * 35 - Math.log1p(meta.size / 1e6) * 6,
      project: pkey, projectPath: meta.cwd || "",
      first: d?.first || meta.preview, last: d?.last || "",
      tools: d?.tools || 0, wrote: d?.files || [], snippets: d?.snippets || [],
    });
  }
  out2.sort((a, b) => (b.score - a.score) || (b.mtime - a.mtime));
  return out2.slice(0, 24);
}

/* ───────────────────────────── live chat ───────────────────────────── */

const live = new Map<string, ChildProcess>();
type Run = { id: string; cwd: string; model?: string; started: number; prompt: string };
const running = new Map<string, Run>();

/** everything Bridge does, newest last — the Activity page reads this */
type LogRow = { ts: number; kind: string; msg: string; outcome?: string; session?: string; cwd?: string; cost?: number; ms?: number; model?: string };
const LOG: LogRow[] = [];
function logRow(r: LogRow) { LOG.push(r); if (LOG.length > 800) LOG.splice(0, LOG.length - 800); }

/** env vars declared in settings.json, so spawned sessions see the same world as the TUI */
let settingsEnv: Record<string, string> = {};
try {
  const raw = await Bun.file(join(CLAUDE_DIR, "settings.json")).text();
  settingsEnv = JSON.parse(raw).env || {};
} catch {}

async function runClaude(req: any, send: (o: any) => void, done: () => void) {
  // a signed-out CLI fails deep inside the stream; catch it here and hand the UI the sign-in sheet
  const auth = await authStatus();
  if (!auth.loggedIn) { send({ t: "auth", d: auth }); send({ t: "end", code: 0 }); done(); return null; }
  const sessionId: string = req.sessionId || randomUUID();
  // `--agent` does not reach a -p turn (see § agent routing), so the agent is asked for in the
  // system prompt, where the main loop can act on it with the Agent tool. The flag goes along
  // too: it costs nothing and starts working the day the CLI honours it.
  const agent = typeof req.agent === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(req.agent) ? req.agent : "";
  const protocol = agent ? BRIDGE_PROTOCOL + "\n" + [
    "",
    "3. This turn belongs to the `" + agent + "` agent. Dispatch it with the Agent tool",
    "   (subagent_type: \"" + agent + "\"), give it the request in full with the context it needs, and answer",
    "   from what it returns. Handle the turn yourself only if that agent plainly cannot do this work.",
  ].join("\n") : BRIDGE_PROTOCOL;
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--append-system-prompt", protocol];
  if (req.resume) args.push("--resume", req.resume);
  else args.push("--session-id", sessionId);
  args.push("--permission-mode", req.permissionMode || "acceptEdits");
  if (req.model) args.push("--model", req.model);
  if (agent) args.push("--agent", agent);
  if (req.effort) args.push("--effort", req.effort);

  const attachments = Array.isArray(req.attachments) ? req.attachments : [];
  for (const a of attachments) {
    if (a.path) {
      const abs = guard(a.path);
      if (!abs) { a.error = "outside Bridge folders"; continue; }
      if (isSensitive(abs)) { a.error = "protected path"; continue; }
      try {
        const st = await stat(abs);
        if (!st.isFile()) { a.error = "not a file"; continue; }
        const ext = extname(abs).toLowerCase();
        if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
          const data = (await readFile(abs)).toString("base64");
          const mt = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/svg+xml";
          a.kind = "image"; a.mediaType = mt; a.data = data;
        } else if (st.size > 200_000) {
          a.error = "too large to inline (" + Math.round(st.size / 1024) + " KB)";
        } else {
          a.kind = "text"; a.data = await readFile(abs, "utf8");
        }
      } catch (e) { a.error = String(e); }
    } else if (!a.data || !a.kind) {
      a.error = "unreadable attachment";
    }
  }

  const usable = attachments.filter((a) => !a.error);
  let inputEnvelope: any = null;
  if (usable.length) {
    args.push("--input-format", "stream-json");
    const content: any[] = [];
    if (req.prompt) content.push({ type: "text", text: String(req.prompt) });
    for (const a of usable) {
      if (a.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } });
      else content.push({ type: "text", text: "File: " + (a.name || basename(a.path || "attachment")) + "\n```\n" + a.data + "\n```" });
    }
    inputEnvelope = { type: "user", message: { role: "user", content } };
  } else {
    args.push(req.prompt);
  }

  const cwd = guard(req.cwd || HOME) || HOME;
  const stdio = inputEnvelope ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
  const child = spawn(CLAUDE_BIN, args, { cwd, env: { ...process.env, ...settingsEnv, FORCE_COLOR: "0" }, stdio });
  const key = req.resume || sessionId;
  live.set(key, child);
  const prompt = String(req.prompt).replace(/\s+/g, " ").trim().slice(0, 140);
  running.set(key, { id: key, cwd, model: req.model, started: Date.now(), prompt });
  logRow({ ts: Date.now(), kind: "turn.start", msg: prompt, session: key, cwd, model: req.model });
  send({ t: "start", sessionId: key, cwd, args });

  if (inputEnvelope && child.stdin) {
    child.stdin.write(JSON.stringify(inputEnvelope) + "\n");
    child.stdin.end();
  }

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === "result") {
          logRow({ ts: Date.now(), kind: parsed.is_error ? "turn.error" : "turn.done",
            msg: running.get(key)?.prompt || parsed.subtype || "turn", outcome: parsed.subtype,
            session: key, cwd, model: req.model,
            cost: parsed.total_cost_usd, ms: parsed.duration_ms });
        }
        send({ t: "msg", d: parsed });
      }
      catch { send({ t: "raw", d: line }); }
    }
  });
  child.stderr.on("data", (c) => send({ t: "stderr", d: c.toString() }));
  child.on("close", (code) => { live.delete(key); running.delete(key); if (code) logRow({ ts: Date.now(), kind: "turn.exit", msg: prompt, outcome: "exit " + code, session: key, cwd }); send({ t: "end", code }); done(); });
  child.on("error", (e) => { logRow({ ts: Date.now(), kind: "turn.error", msg: String(e), session: key, cwd }); send({ t: "error", d: String(e) }); live.delete(key); running.delete(key); done(); });
  return sessionId;
}



/* ────────────────────────── agent routing ──────────────────────────
 * Two facts shape this. First, `--agent` is parsed but does nothing to a `-p` turn on
 * CLI 2.1.259: a custom agent's prompt and tool limits are not applied (verified with a
 * throwaway agent whose prompt was "reply only ZEBRA" — the reply came back in the main
 * voice). So an agent is put to work the way it actually works, by asking the main loop
 * to dispatch it. Second, choosing the agent has to be free: a model call in front of
 * every message costs ~6s of CLI boot, which is more than most turns take. So the choice
 * is made here, on the agent descriptions the user already wrote. */
const RT_STOP = new Set(("the a an and or of to in on for with that this it is was were be been are am " +
  "we i you my our your me us they them he she about from what where when how why did do does done " +
  "can could would should will shall may might must have has had get got make made use used using " +
  "please just now then than there here all any some more most very really need needs want wants " +
  "let lets like into out up down over under again also too but if so as at by no not only own same").split(/\s+/));
const words = (s: string) => (s.toLowerCase().match(/[a-z][a-z0-9+.#_-]{1,}/g) || []).filter((w) => w.length > 2 && !RT_STOP.has(w));

type AgentDoc = { name: string; nameW: string[]; descW: Set<string>; catW: Set<string>; bodyW: Set<string>; df: string[] };
let agentIndex: { at: number; docs: AgentDoc[]; idf: Map<string, number> } | null = null;

async function agentDocs() {
  if (agentIndex && Date.now() - agentIndex.at < 60_000) return agentIndex;
  const agents = await collectAgents();
  // Team agents share a blurb almost word for word ("Setpoint marketing team — …"), so the
  // description alone leaves three of them tied. What separates them is their instructions.
  const docs: AgentDoc[] = await Promise.all(agents.map(async (a: any) => {
    const nameW = words(String(a.name).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[:_-]/g, " "));
    const descW = new Set(words(String(a.description || "")));
    const catW = new Set(words(String(a.category || a.source || "")));
    const raw = await readFile(a.path, "utf8").catch(() => "");
    const body = raw.startsWith("---") ? raw.slice(raw.indexOf("\n---", 3) + 4) : raw;
    const bodyW = new Set(words(body.slice(0, 12_000)));
    return { name: a.name, nameW, descW, catW, bodyW, df: [...new Set([...nameW, ...descW, ...catW, ...bodyW])] };
  }));
  // a term that shows up in every agent's blurb says nothing about which one to pick
  const seen = new Map<string, number>();
  for (const d of docs) for (const t of d.df) seen.set(t, (seen.get(t) || 0) + 1);
  const idf = new Map<string, number>();
  for (const [t, n] of seen) idf.set(t, Math.log(1 + docs.length / n));
  agentIndex = { at: Date.now(), docs, idf };
  return agentIndex;
}

/** Score every agent against the message, keep the previous pick unless something clearly beats it. */
async function routeAgent(prompt: string, previous = "") {
  const { docs, idf } = await agentDocs();
  if (!docs.length) return { agent: "", score: 0, why: "no agents installed", runnerUp: "" };
  const q = [...new Set(words(prompt))];
  if (!q.length) return { agent: previous, score: 0, why: "nothing to route on", runnerUp: "" };

  const scored = docs.map((d) => {
    let s = 0;
    const hit: string[] = [];
    for (const t of q) {
      const w = idf.get(t) || 0;
      if (!w) continue;
      let f = 0;
      if (d.nameW.includes(t)) f += 3;
      if (d.descW.has(t)) f += 2;
      if (d.catW.has(t)) f += 1.5;
      if (d.bodyW.has(t)) f += 0.8;
      if (f) { s += w * f; hit.push(t); }
    }
    // normalising by query length keeps long messages from scoring every agent highly
    s = s / Math.sqrt(q.length);
    if (d.name === previous) s *= 1.18;          // a follow-up stays with the agent already on the job
    return { name: d.name, score: s, hit };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0], next = scored[1];
  const top3 = scored.slice(0, 3).map((x) => x.name + " " + x.score.toFixed(2));
  // Below the floor nothing really matched, and a dead heat is a coin toss — both mean plain
  // Claude Code, which can still dispatch a subagent itself. A narrow win is a real win though:
  // siblings on one team score within a few percent of each other by construction.
  if (top.score < 1.6 || (next && top.score - next.score < 0.02)) {
    return { agent: previous && top.name !== previous ? "" : previous, score: +top.score.toFixed(2),
      why: "no clear match", runnerUp: next ? next.name : "", top3 };
  }
  return { agent: top.name, score: +top.score.toFixed(2), runnerUp: next ? next.name : "",
    why: top.hit.slice(0, 6).join(", "), top3 };
}

/* ─────────────────────────── sign-in ───────────────────────────────
 * Claude Code's own login is a terminal flow: it prints an OAuth URL, opens the
 * browser, then blocks on stdin for the code the callback page shows. Bridge drives
 * that same process — URL out to the UI, pasted code back down stdin — so signing in
 * never means finding a terminal. Nothing here touches the credential store itself;
 * the CLI owns that. */
type AuthStatus = {
  loggedIn: boolean; authMethod?: string; apiProvider?: string; email?: string;
  orgName?: string; subscriptionType?: string; keyAuth?: boolean; cli?: boolean; error?: string;
};
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
let authCache: { at: number; v: AuthStatus } | null = null;

async function authStatus(force = false): Promise<AuthStatus> {
  if (!force && authCache && Date.now() - authCache.at < 30_000) return authCache.v;
  const keyAuth = !!(process.env.ANTHROPIC_API_KEY || settingsEnv.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN || settingsEnv.ANTHROPIC_AUTH_TOKEN);
  let v: AuthStatus;
  try {
    const proc = Bun.spawn([CLAUDE_BIN, "auth", "status", "--json"], { stdout: "pipe", stderr: "pipe" });
    const raw = stripAnsi(await new Response(proc.stdout).text());
    await proc.exited;
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error(raw.trim().slice(0, 200) || "no output");
    v = { ...JSON.parse(raw.slice(a, b + 1)), keyAuth, cli: true };
    if (keyAuth) v.loggedIn = true;   // an API key in the environment is a valid login
  } catch (e) {
    v = {
      loggedIn: keyAuth, keyAuth, cli: !!Bun.which(CLAUDE_BIN),
      error: "could not read `claude auth status` — " + String((e as any)?.message || e),
    };
  }
  authCache = { at: Date.now(), v };
  return v;
}

type Login = { child: ChildProcess; url: string; out: string; done: boolean; code: number | null; wasIn: boolean };
let login: Login | null = null;
function endLogin() {
  if (!login) return;
  try { if (!login.done) login.child.kill("SIGTERM"); } catch {}
  login = null;
}
/** the CLI writes its prompt and its errors without a trailing newline, so match on content */
const badCode = (s: string) => /invalid code|expired|failed|not authorized|error:/i.test(s);

async function startLogin(mode: string, email?: string) {
  endLogin();
  const before = await authStatus(true);
  const args = ["auth", "login", mode === "console" ? "--console" : "--claudeai"];
  if (email && /^[^\s@]+@[^\s@]+$/.test(email)) args.push("--email", email);
  let child: ChildProcess;
  try {
    child = spawn(CLAUDE_BIN, args, {
      env: { ...process.env, ...settingsEnv, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) { return { error: "could not start `claude auth login` — " + String(e) }; }
  const L: Login = { child, url: "", out: "", done: false, code: null, wasIn: !!before.loggedIn };
  login = L;
  const grab = (c: any) => {
    L.out = (L.out + stripAnsi(String(c))).slice(-8000);
    if (!L.url) { const m = L.out.match(/https?:\/\/[^\s"'<>]+/); if (m) L.url = m[0]; }
  };
  child.stdout?.on("data", grab);
  child.stderr?.on("data", grab);
  child.on("close", (code) => { L.done = true; L.code = code; });
  child.on("error", (e) => { L.done = true; grab(e); });
  for (let i = 0; i < 200 && !L.url && !L.done; i++) await Bun.sleep(50);   // up to 10s for the link
  if (!L.url) {
    const why = L.out.trim() || "`claude auth login` printed no sign-in link";
    endLogin();
    return { error: why.slice(-400) };
  }
  logRow({ ts: Date.now(), kind: "auth.login", msg: "sign-in started (" + (mode === "console" ? "console" : "claude.ai") + ")" });
  return { url: L.url, mode };
}

/** paste the code from the callback page into the waiting CLI, then confirm from the CLI itself */
async function submitCode(code: string) {
  const L = login;
  if (!L || L.done) return { error: "that sign-in link expired — start again", restart: true };
  const clean = String(code).trim();
  if (!clean || clean.length > 400 || /\s/.test(clean)) return { error: "that doesn't look like the code — copy the whole string" };
  const mark = L.out.length;
  try { L.child.stdin?.write(clean + "\n"); } catch (e) { endLogin(); return { error: String(e), restart: true }; }
  for (let i = 0; i < 240; i++) {                       // up to 120s; the browser half is already done
    await Bun.sleep(500);
    if (L.done) break;
    if (badCode(L.out.slice(mark))) break;
    if (!L.wasIn && i % 4 === 3 && (await authStatus(true)).loggedIn) break;
  }
  const st = await authStatus(true);
  const tail = L.out.slice(mark).trim().split("\n").filter(Boolean).pop() || "";
  const ok = !!st.loggedIn && !badCode(L.out.slice(mark));
  endLogin();
  logRow({ ts: Date.now(), kind: ok ? "auth.ok" : "auth.fail", msg: ok ? "signed in as " + (st.email || "Claude") : tail.slice(0, 120) });
  return ok ? { ok: true, status: st } : { error: tail.slice(0, 300) || "sign-in did not complete", restart: true, status: st };
}

async function doLogout() {
  const proc = Bun.spawn([CLAUDE_BIN, "auth", "logout"], { stdout: "pipe", stderr: "pipe" });
  const out = stripAnsi(await new Response(proc.stdout).text());
  await proc.exited;
  const st = await authStatus(true);
  logRow({ ts: Date.now(), kind: "auth.logout", msg: st.loggedIn ? "logout failed" : "signed out" });
  return { ok: !st.loggedIn, status: st, out: out.trim().slice(-200) };
}

/* ─────────────── live terminal sessions (the registry the CLI keeps) ───────────────
 * Every interactive `claude` writes ~/.claude/sessions/<pid>.json — pid, session id, the
 * folder it started in, a display name and a busy/idle status it keeps current. Bridge reads
 * that registry, drops anything whose process is gone, and mirrors the rest as tabs. Print-mode
 * turns (Bridge's own, and anyone's `claude -p`) do not register, so they never show up here. */
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
/** the CLI names a project folder after the cwd with every non-alphanumeric turned into "-" */
const projectKey = (cwd: string) => String(cwd).replace(/[^A-Za-z0-9]/g, "-");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

type Waiting = { kind: "question" | "plan" | "permission"; text: string; options?: string[] } | null;
type TailState = { last: string; lastTs: number; lastUser: string; waiting: Waiting; turns: number; cwd: string };
const tailCache = new Map<string, { m: number; v: TailState }>();
/** What the end of a transcript says: the last thing the model said, and whether it is
 *  standing on a question. A pending AskUserQuestion / ExitPlanMode (tool_use with no
 *  tool_result) is the hard signal; an idle session whose last words end in "?" is the soft one. */
async function tailState(file: string, idle: boolean): Promise<TailState> {
  const st = await stat(file).catch(() => null);
  const empty: TailState = { last: "", lastTs: 0, lastUser: "", waiting: null, turns: 0, cwd: "" };
  if (!st) return empty;
  const hit = tailCache.get(file);
  if (hit && hit.m === st.mtimeMs) return { ...hit.v, waiting: softWaiting(hit.v, idle) };
  const lines = await lastLines(file, 120_000);
  const pending = new Map<string, any>();
  const v: TailState = { ...empty };
  for (const line of lines) {
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain) continue;
    if (r.cwd) v.cwd = r.cwd;                       // where the work is actually happening now
    const ts = r.timestamp ? Date.parse(r.timestamp) : 0;
    if (r.type === "assistant") {
      for (const c of r.message?.content || []) {
        if (c.type === "text" && c.text?.trim()) { v.last = c.text; v.lastTs = ts; }
        else if (c.type === "tool_use") pending.set(c.id, { name: c.name, input: c.input });
      }
    } else if (r.type === "user") {
      const c = r.message?.content;
      if (typeof c === "string") { const t = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim(); if (t) { v.lastUser = t; v.turns++; } }
      else if (Array.isArray(c)) {
        for (const x of c) {
          if (x.type === "tool_result") pending.delete(x.tool_use_id);
          else if (x.type === "text" && x.text?.trim()) { v.lastUser = x.text; v.turns++; }
        }
      }
    }
  }
  const ask = [...pending.values()].find((p) => p.name === "AskUserQuestion");
  const plan = [...pending.values()].find((p) => p.name === "ExitPlanMode");
  if (ask) {
    const q = (ask.input?.questions || [])[0] || {};
    v.waiting = { kind: "question", text: String(q.question || q.header || "is asking you a question"), options: (q.options || []).map((o: any) => String(o.label || o)).slice(0, 6) };
  } else if (plan) v.waiting = { kind: "plan", text: "has a plan waiting for your approval" };
  tailCache.set(file, { m: st.mtimeMs, v: { ...v, waiting: v.waiting } });
  return { ...v, waiting: softWaiting(v, idle) };
}
function softWaiting(v: TailState, idle: boolean): Waiting {
  if (v.waiting) return v.waiting;
  if (!idle || !v.last) return null;
  const tail = v.last.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  const clean = tail.replace(/[*_`#>]/g, "").trim();
  if (/\?$/.test(clean) && clean.length > 8 && clean.length < 300) return { kind: "question", text: clean };
  return null;
}
const plain = (t: string, n = 240) => String(t || "").replace(/```[\s\S]*?```/g, " ").replace(/<[^>]+>/g, " ").replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

type LiveSession = {
  pid: number; id: string; key: string; cwd: string; name: string; status: string; startedAt: number; updatedAt: number;
  file: string; title: string; folder: string; last: string; lastTs: number; lastUser: string; waiting: Waiting; turns: number; version?: string;
};
/** pids Bridge itself spawned — never mirrored, even if a future CLI registers them */
const ownPids = new Set<number>();
async function liveSessions(): Promise<LiveSession[]> {
  const files = await readdir(SESSIONS_DIR).catch(() => [] as string[]);
  const out: LiveSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let r: any; try { r = JSON.parse(await readFile(join(SESSIONS_DIR, f), "utf8")); } catch { continue; }
    if (!r.pid || !r.sessionId || !r.cwd) continue;
    if (r.kind && r.kind !== "interactive") continue;
    if (ownPids.has(r.pid) || !alive(r.pid)) continue;
    const key = projectKey(r.cwd);
    const file = join(PROJECTS_DIR, key, r.sessionId + ".jsonl");
    const has = existsSync(file);
    const meta = has ? await sessionMeta(key, file) : null;
    const tail = has ? await tailState(file, r.status === "idle") : { last: "", lastTs: 0, lastUser: "", waiting: null, turns: 0, cwd: "" };
    const work = tail.cwd || r.cwd;
    out.push({
      pid: r.pid, id: r.sessionId, key, cwd: r.cwd, name: r.name || ("claude " + r.pid), status: r.status || "idle",
      startedAt: r.startedAt || 0, updatedAt: r.updatedAt || r.startedAt || 0, file, version: r.version,
      title: meta?.title || tail.lastUser.slice(0, 60) || basename(work), folder: work === HOME ? "home" : basename(work) || work,
      last: plain(tail.last, 400), lastTs: tail.lastTs, lastUser: plain(tail.lastUser, 200), waiting: tail.waiting, turns: tail.turns,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Watch the registry for the moments worth telling the principal about: a turn finishing
 *  (busy → idle), a session stopping on a question, a terminal opening or closing. */
type LiveEvent = { kind: "started" | "ended" | "done" | "waiting"; at: number; pid: number; id: string; key: string; name: string; folder: string; cwd: string; title: string; text: string; options?: string[] };
const EVENTS: LiveEvent[] = [];
let lastLive: LiveSession[] = [];
const seenLive = new Map<number, { status: string; waiting: string; first: boolean }>();
let watchBooted = false;
async function watchLive() {
  let cur: LiveSession[];
  try { cur = await liveSessions(); } catch { return; }
  lastLive = cur;
  const now = Date.now();
  const emit = (kind: LiveEvent["kind"], s: LiveSession, text: string, options?: string[]) => {
    const ev: LiveEvent = { kind, at: now, pid: s.pid, id: s.id, key: s.key, name: s.name, folder: s.folder, cwd: s.cwd, title: s.title, text, options };
    EVENTS.push(ev); if (EVENTS.length > 200) EVENTS.shift();
    logRow({ ts: now, kind: "live." + kind, msg: (kind === "waiting" ? "needs you: " : "") + (text || s.title), session: s.id, cwd: s.cwd, outcome: s.name });
    daBroadcast({ t: "event", d: ev });
  };
  const present = new Set<number>();
  for (const s of cur) {
    present.add(s.pid);
    const w = s.waiting ? s.waiting.kind + ":" + s.waiting.text : "";
    const prev = seenLive.get(s.pid);
    if (!prev) {
      seenLive.set(s.pid, { status: s.status, waiting: w, first: true });
      if (watchBooted) emit("started", s, s.title);
      else if (w && s.waiting) emit("waiting", s, s.waiting.text, s.waiting.options);   // already waiting when Bridge came up
      continue;
    }
    if (prev.status === "busy" && s.status === "idle" && !w) emit("done", s, s.last);
    if (w && w !== prev.waiting && s.waiting) emit("waiting", s, s.waiting.text, s.waiting.options);
    prev.status = s.status; prev.waiting = w;
  }
  for (const [pid] of seenLive) if (!present.has(pid)) {
    seenLive.delete(pid);
    const gone = lastLiveByPid.get(pid);
    if (gone && watchBooted) emit("ended", gone, gone.title);
  }
  lastLiveByPid.clear(); for (const s of cur) lastLiveByPid.set(s.pid, s);
  watchBooted = true;
}
const lastLiveByPid = new Map<number, LiveSession>();
setInterval(watchLive, 1500);
watchLive();

/* ────────────────────── following a transcript as it grows ──────────────────────
 * A mirrored tab is the terminal's transcript, read from the byte the tab already has. The
 * file is polled for growth; whole lines are normalised and streamed, a partial last line
 * waits for its newline. Nothing is written — the terminal owns the session. */
function followTranscript(file: string, from: number, send: (o: any) => void, signal: { closed: boolean }) {
  let offset = Math.max(0, from | 0);
  let rest = "";
  const tick = async () => {
    if (signal.closed) return;
    try {
      const st = await stat(file).catch(() => null);
      if (!st) { send({ t: "gone" }); return; }
      if (st.size > offset) {
        const chunk = await Bun.file(file).slice(offset, st.size).text();
        offset = st.size;
        const parts = (rest + chunk).split("\n");
        rest = parts.pop() || "";
        const lines = parts.filter(Boolean);
        if (lines.length) {
          const { events, patches, meta } = normalizeLines(lines);
          send({ t: "events", events, patches, usage: meta.usage, model: meta.model, offset });
        }
      } else if (st.size < offset) { offset = st.size; rest = ""; }   // rewritten (compaction): resync from the end
    } catch (e) { send({ t: "error", d: String(e) }); }
    if (!signal.closed) setTimeout(tick, 650);
  };
  tick();
}

/* ─────────────────────────── the assistant desk ───────────────────────────
 * The first tab is the principal's own assistant: one `claude` process that stays open for
 * as long as Bridge runs (stdin in stream-json, never closed), so a turn costs no CLI boot
 * and events can land between turns. Its session id is kept on disk, so the conversation
 * survives a restart. Every message carries a <bridge> block with the live state of the
 * terminals, so the desk can answer "what is going on" without being asked to look. */
const DA_FILE = join(DATA_DIR, "da.json");
const DA_PROTOCOL = (assistant: string, user: string) => [
  "You are " + assistant + ", running as the Copilot in Bridge — a voice-first view above the session tabs, with no sessions of its own, where " + user +
  " asks for summaries and talks through the whole picture without opening a session. Bridge speaks your reply aloud.",
  "",
  "State: every message from Bridge begins with a <bridge> block listing the live Claude Code terminal sessions on this machine — name,",
  "folder, busy or idle, what each last said, whether one is waiting on " + user + ", and the recent events. Treat it as the current truth;",
  "never read it back verbatim and never invent session state that is not in it.",
  "",
  "Digging deeper: each session's full transcript is the JSONL file named in the block. When asked what a session did, why, or what it changed,",
  "Read the end of that file (it is large — use offset/limit or Bash tail) and answer from it. To send a running session a message, use ListAgents",
  "to find it by its name from the block and SendMessage to send it; then say what you sent. Relay requests (\"tell X to …\") mean exactly that.",
  "",
  "Answering: always include one line that starts with 🗣️ — one to three plain spoken sentences that answer the question directly. That line is",
  "read aloud, so no markdown, lists, paths or code in it. Anything else you show stays short; " + user + " can ask for more. When there is",
  "nothing new, say so in a sentence.",
].join("\n");

type DaClient = (o: any) => void;
const DA = {
  child: null as ChildProcess | null, sessionId: "", busy: false, queue: [] as { text: string; ctx: string }[],
  starting: false, seq: 0, ring: [] as any[], clients: new Set<DaClient>(), started: 0, turns: 0, lastError: "",
  turnStarted: 0, exits: 0, permissionMode: "bypassPermissions", model: "", name: "", user: "",
};
function daBroadcast(o: any) {
  o.seq = ++DA.seq; o.ts = o.ts || Date.now();
  DA.ring.push(o); if (DA.ring.length > 600) DA.ring.shift();
  for (const c of DA.clients) { try { c(o); } catch {} }
}
async function daIdentity() {
  const settings = JSON.parse(await readFile(join(CLAUDE_DIR, "settings.json"), "utf8").catch(() => "{}"));
  const id = settings.daidentity || {};
  DA.name = id.name || id.displayName || "Claude";
  DA.user = id.userName || basename(HOME);
  return { name: DA.name, user: DA.user, color: id.color || "", voice: id.voices?.main || null };
}
async function daLoadState() {
  try {
    const d = JSON.parse(await readFile(DA_FILE, "utf8"));
    if (typeof d.sessionId === "string") DA.sessionId = d.sessionId;
    if (typeof d.permissionMode === "string") DA.permissionMode = d.permissionMode;
    if (typeof d.model === "string") DA.model = d.model;
  } catch {}
}
async function daSaveState() {
  try { await Bun.write(DA_FILE, JSON.stringify({ sessionId: DA.sessionId, permissionMode: DA.permissionMode, model: DA.model }, null, 2)); } catch {}
}
function daState() {
  return { alive: !!DA.child, busy: DA.busy, sessionId: DA.sessionId, started: DA.started, turns: DA.turns, queued: DA.queue.length,
    error: DA.lastError, name: DA.name, model: DA.model, permissionMode: DA.permissionMode };
}
let daStarting: Promise<void> | null = null;
function daStart(fresh = false): Promise<void> {
  if (DA.child) return Promise.resolve();
  if (daStarting) return daStarting;          // a second caller waits for the same boot
  daStarting = daBoot(fresh).finally(() => { daStarting = null; });
  return daStarting;
}
async function daBoot(fresh: boolean) {
  DA.starting = true;
  try {
    const auth = await authStatus();
    if (!auth.loggedIn) { DA.lastError = "Claude Code is not signed in"; daBroadcast({ t: "state", d: daState() }); return; }
    await daIdentity();
    const transcriptExists = (id: string) => existsSync(join(PROJECTS_DIR, projectKey(HOME), id + ".jsonl"));
    if (fresh || !DA.sessionId || !transcriptExists(DA.sessionId)) { DA.sessionId = randomUUID(); await daSaveState(); fresh = true; }
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      "--append-system-prompt", DA_PROTOCOL(DA.name, DA.user), "--permission-mode", DA.permissionMode, "--name", DA.name + " desk"];
    args.push(fresh ? "--session-id" : "--resume", DA.sessionId);
    if (DA.model) args.push("--model", DA.model);
    // LIFEOS_NOTIFICATION_CHANNEL: the terminal voice hook speaks every finished turn through
    // Pulse; Bridge speaks the desk itself, so that hook is told this is not a desktop terminal.
    const child = spawn(CLAUDE_BIN, args, { cwd: HOME, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...settingsEnv, FORCE_COLOR: "0", BRIDGE_DESK: "1", LIFEOS_NOTIFICATION_CHANNEL: "bridge" } });
    if (child.pid) ownPids.add(child.pid);
    DA.child = child; DA.started = Date.now(); DA.busy = false; DA.lastError = "";
    logRow({ ts: Date.now(), kind: "desk.start", msg: (fresh ? "new" : "resumed") + " desk session", session: DA.sessionId, cwd: HOME });
    let buf = "";
    child.stdout!.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let parsed: any; try { parsed = JSON.parse(line); } catch { daBroadcast({ t: "raw", d: line }); continue; }
        if (parsed?.type === "system" && parsed.subtype === "init" && parsed.session_id) DA.sessionId = parsed.session_id;
        daBroadcast({ t: "da", d: parsed });
        if (parsed?.type === "result") {
          DA.busy = false; DA.turns++;
          logRow({ ts: Date.now(), kind: parsed.is_error ? "desk.error" : "desk.done", msg: parsed.subtype || "turn", session: DA.sessionId,
            cwd: HOME, cost: parsed.total_cost_usd, ms: parsed.duration_ms });
          daBroadcast({ t: "state", d: daState() });
          daDrain();
        }
      }
    });
    child.stderr!.on("data", (c) => { const s = c.toString().trim(); if (s && !/hook|deprecat|warning/i.test(s)) daBroadcast({ t: "stderr", d: s }); });
    child.on("close", (code) => {
      if (child.pid) ownPids.delete(child.pid);
      if (DA.child === child) { DA.child = null; DA.busy = false; }
      DA.exits++;
      logRow({ ts: Date.now(), kind: "desk.exit", msg: "desk process exited", outcome: "exit " + code, session: DA.sessionId, cwd: HOME });
      daBroadcast({ t: "state", d: daState() });
      // a desk that died mid-turn or with work queued comes back on its own; a clean exit waits for the next message
      if (DA.queue.length || DA.exits < 3) setTimeout(() => daStart(), 1200 * DA.exits);
    });
    child.on("error", (e) => { DA.lastError = String(e); daBroadcast({ t: "state", d: daState() }); });
    daBroadcast({ t: "state", d: daState() });
  } finally { DA.starting = false; }
}
function daWrite(text: string, ctx: string) {
  if (!DA.child?.stdin) return false;
  DA.busy = true; DA.turnStarted = Date.now();
  const content = ctx ? ctx + "\n\n" + text : text;
  DA.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  logRow({ ts: Date.now(), kind: "desk.turn", msg: text.replace(/\s+/g, " ").slice(0, 140), session: DA.sessionId, cwd: HOME });
  daBroadcast({ t: "user", d: { text } });      // every open page shows the message, whichever one sent it
  daBroadcast({ t: "state", d: daState() });
  return true;
}
function daDrain() {
  if (DA.busy || !DA.child || !DA.queue.length) return;
  const next = DA.queue.shift()!;
  daWrite(next.text, next.ctx);
}
/** the situation report that rides in front of every message */
function bridgeBlock(): string {
  const lines: string[] = ["<bridge>", "now: " + new Date().toISOString()];
  if (!lastLive.length) lines.push("live sessions: none — no Claude Code terminal is open right now");
  else {
    lines.push("live sessions (" + lastLive.length + "):");
    for (const s of lastLive) {
      lines.push("- " + s.name + " · " + s.folder + " (" + s.cwd + ") · " + s.status + (s.waiting ? " · WAITING ON " + DA.user.toUpperCase() + ": " + s.waiting.text : "") +
        " · started " + new Date(s.startedAt).toISOString().slice(11, 16) + " · " + s.turns + " turns");
      lines.push("  transcript: " + s.file);
      if (s.lastUser) lines.push("  last asked: " + s.lastUser.slice(0, 200));
      if (s.last) lines.push("  last said: " + s.last.slice(0, 300));
    }
  }
  const recent = EVENTS.slice(-8);
  if (recent.length) {
    lines.push("recent events:");
    for (const e of recent) lines.push("- " + new Date(e.at).toISOString().slice(11, 16) + " " + e.kind + " · " + e.name + " · " + e.folder + (e.text ? " · " + e.text.slice(0, 160) : ""));
  }
  lines.push("</bridge>");
  return lines.join("\n");
}
async function daSend(text: string) {
  if (!DA.child) await daStart();
  if (!DA.child) return { error: DA.lastError || "the desk could not start" };
  const ctx = bridgeBlock();
  if (DA.busy) { DA.queue.push({ text, ctx }); daBroadcast({ t: "state", d: daState() }); return { queued: true }; }
  return { ok: daWrite(text, ctx) };
}
function daInterrupt() {
  if (!DA.child) return false;
  try { DA.child.kill("SIGINT"); } catch {}
  return true;
}
async function daReset() {
  const c = DA.child; DA.child = null; DA.queue = []; DA.busy = false;
  if (c) { try { c.stdin?.end(); c.kill("SIGTERM"); } catch {} }
  DA.sessionId = ""; await daSaveState();
  await daStart(true);
  return daState();
}
await daLoadState();
/** the desk and the transcriber are Bridge's own processes: they go when Bridge goes */
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => {
  try { DA.child?.stdin?.end(); DA.child?.kill("SIGTERM"); } catch {}
  try { stt?.proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 300);
});

/* ───────────────────────────── voice ─────────────────────────────
 * Speaking: ElevenLabs directly when the key is in ~/.claude/.env (audio comes back to the
 * page, so the orb can move to the actual sound); otherwise through Pulse, which plays the
 * assistant's own voice on the Mac; otherwise the page falls back to the browser voice.
 * Listening: the page records, the server transcribes offline with whisper. */
async function dotenvKey(name: string): Promise<string> {
  if (process.env[name]) return process.env[name]!;
  try {
    const txt = await readFile(join(CLAUDE_DIR, ".env"), "utf8");
    const m = txt.match(new RegExp("^\\s*(?:export\\s+)?" + name + "\\s*=\\s*[\"']?([^\"'\\n#]+)", "m"));
    return m ? m[1].trim() : "";
  } catch { return ""; }
}
let pulseCache: { at: number; up: boolean } | null = null;
async function pulseUp(): Promise<boolean> {
  if (pulseCache && Date.now() - pulseCache.at < 20_000) return pulseCache.up;
  let up = false;
  try {
    const r = await fetch("http://localhost:31337/voice/health", { signal: AbortSignal.timeout(900) });
    const j: any = await r.json().catch(() => ({}));
    up = r.ok && (j.api_key_configured !== false);
  } catch {}
  pulseCache = { at: Date.now(), up };
  return up;
}
async function voiceHealth() {
  const id = await daIdentity();
  const key = await dotenvKey("ELEVENLABS_API_KEY");
  const tts = key ? "elevenlabs" : (await pulseUp()) ? "pulse" : "browser";
  return { tts, pulse: pulseCache?.up || false, stt: await sttEngine(), voice: id.voice ? { voiceId: id.voice.voiceId } : null, name: id.name, user: id.user, color: id.color };
}
/** split for speech: whole sentences, none over Pulse's 500-character ceiling */
function speechChunks(text: string, max = 440): string[] {
  const parts = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [text];
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    const s = p.trim(); if (!s) continue;
    if ((cur + " " + s).trim().length > max && cur) { out.push(cur.trim()); cur = s; }
    else cur = (cur + " " + s).trim();
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
async function ttsRespond(text: string): Promise<Response> {
  const clean = String(text || "").trim().slice(0, 1600);
  if (!clean) return json({ error: "nothing to say" }, 400);
  const id = await daIdentity();
  const v = id.voice || {};
  const key = await dotenvKey("ELEVENLABS_API_KEY");
  if (key && v.voiceId) {
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + v.voiceId + "?output_format=mp3_44100_128", {
        method: "POST", headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: clean, model_id: "eleven_turbo_v2_5", voice_settings: {
          stability: v.stability ?? 0.35, similarity_boost: v.similarityBoost ?? 0.8, style: v.style ?? 0.9, use_speaker_boost: true, speed: v.speed ?? 1.1 } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-bridge-tts": "elevenlabs" } });
      logRow({ ts: Date.now(), kind: "voice.error", msg: "ElevenLabs " + r.status, outcome: (await r.text()).slice(0, 120) });
    } catch (e) { logRow({ ts: Date.now(), kind: "voice.error", msg: "ElevenLabs " + String(e).slice(0, 100) }); }
  }
  if (await pulseUp()) {
    const chunks = speechChunks(clean);
    let ok = 0;
    for (const c of chunks) {
      try {
        const r = await fetch("http://localhost:31337/notify", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Bridge", message: c, voice_id: v.voiceId || undefined, voice_enabled: true }), signal: AbortSignal.timeout(25_000) });
        if (r.ok) ok++;
      } catch {}
    }
    if (ok) return json({ played: "pulse", chunks: ok, words: clean.split(/\s+/).length });
    pulseCache = { at: Date.now(), up: false };
  }
  return json({ played: "none", words: clean.split(/\s+/).length });
}

/* whisper, kept warm: one python worker holding the model, fed file paths over stdin */
type Stt = { proc: any; engine: string; pending: ((r: any) => void)[]; idle: any };
let stt: Stt | null = null;
let sttEngineCache: { at: number; v: string } | null = null;
const STT_WORKER = join(dirname(Bun.fileURLToPath(import.meta.url)), "stt", "worker.py");
async function sttPython(): Promise<{ py: string; engine: string } | null> {
  const cands = [process.env.BRIDGE_STT_PYTHON, join(HOME, ".local", "whisper-venv", "bin", "python3"), "python3"].filter(Boolean) as string[];
  for (const py of cands) {
    if (py.includes("/") && !existsSync(py)) continue;
    for (const mod of ["mlx_whisper", "whisper"]) {
      try {
        const p = Bun.spawn([py, "-c", "import " + mod], { stdout: "ignore", stderr: "ignore" });
        if ((await p.exited) === 0) return { py, engine: mod === "mlx_whisper" ? "mlx" : "whisper" };
      } catch {}
    }
  }
  if (Bun.which("whisper")) return { py: "", engine: "whisper-cli" };
  return null;
}
async function sttEngine(): Promise<string> {
  if (stt) return stt.engine;
  if (sttEngineCache && Date.now() - sttEngineCache.at < 120_000) return sttEngineCache.v;
  const r = await sttPython();
  const v = r ? r.engine : "none";
  sttEngineCache = { at: Date.now(), v };
  return v;
}
async function sttStart(): Promise<Stt | null> {
  if (stt) return stt;
  const r = await sttPython();
  if (!r || !r.py) return null;
  const proc = spawn(r.py, [STT_WORKER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || "0" } });
  const S: Stt = { proc, engine: r.engine, pending: [], idle: null };
  let buf = "";
  proc.stdout.on("data", (c: any) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if (o.ready) { S.engine = o.engine || S.engine; logRow({ ts: Date.now(), kind: "voice.stt", msg: "whisper ready (" + S.engine + ")", ms: o.ms }); continue; }
      const cb = S.pending.shift(); if (cb) cb(o);
    }
  });
  proc.stderr.on("data", (c: any) => { const s = c.toString().trim(); if (/error|traceback/i.test(s)) logRow({ ts: Date.now(), kind: "voice.error", msg: s.slice(0, 160) }); });
  proc.on("close", () => { if (stt === S) stt = null; for (const cb of S.pending) cb({ error: "transcriber exited" }); });
  stt = S;
  return S;
}
function sttTouch() {
  if (!stt) return;
  clearTimeout(stt.idle);
  stt.idle = setTimeout(() => { try { stt?.proc.kill(); } catch {} stt = null; }, 15 * 60_000);   // let the model go after a quiet quarter hour
}
async function transcribe(path: string): Promise<{ text?: string; error?: string; ms?: number }> {
  const t0 = Date.now();
  const S = await sttStart();
  if (S) {
    sttTouch();
    const r: any = await new Promise((res) => { S.pending.push(res); S.proc.stdin.write(path + "\n"); });
    return { ...r, ms: Date.now() - t0 };
  }
  if (Bun.which("whisper")) {
    const outDir = dirname(path);
    const p = Bun.spawn(["whisper", path, "--model", "base.en", "--language", "en", "--output_format", "txt", "--output_dir", outDir, "--fp16", "False"], { stdout: "ignore", stderr: "pipe" });
    await p.exited;
    const txt = await readFile(path.replace(/\.[^.]+$/, ".txt"), "utf8").catch(() => "");
    return txt ? { text: txt.trim(), ms: Date.now() - t0 } : { error: "whisper produced no text" };
  }
  return { error: "no transcriber on this machine — install whisper (mlx_whisper) or type instead" };
}

/* ───────────────────────────── routing ─────────────────────────────── */

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const q = url.searchParams;

    try {
      if (!rootsReady) { ROOTS = await readRoots(); await ensureRoots(); }
      if (p === "/api/bootstrap") {
        const settings = JSON.parse(await readFile(join(CLAUDE_DIR, "settings.json"), "utf8").catch(() => "{}"));
        const id = settings.daidentity || {};
        return json({
          user: id.userName || basename(HOME),
          assistant: id.name || id.displayName || "Claude",
          color: id.color || "", home: HOME, claudeDir: CLAUDE_DIR,
          version: (await new Response(Bun.spawn([CLAUDE_BIN, "--version"]).stdout).text()).trim(),
          models: ["opus", "sonnet", "haiku", "fable"],
          permissionModes: ["acceptEdits", "auto", "plan", "bypassPermissions", "manual", "dontAsk"],
          efforts: ["", "low", "medium", "high", "xhigh", "max"],
          auth: await authStatus(),
        });
      }
      if (p === "/api/auth") return json(await authStatus(q.get("fresh") === "1"));
      if (p === "/api/auth/login" && req.method === "POST") {
        const { mode, email } = await req.json().catch(() => ({}) as any);
        return json(await startLogin(String(mode || "claudeai"), email ? String(email) : undefined));
      }
      if (p === "/api/auth/code" && req.method === "POST") {
        const { code } = await req.json().catch(() => ({}) as any);
        return json(await submitCode(String(code ?? "")));
      }
      if (p === "/api/auth/cancel" && req.method === "POST") { endLogin(); return json({ ok: true }); }
      if (p === "/api/auth/logout" && req.method === "POST") return json(await doLogout());
      if (p === "/api/projects") return json(await listProjects());
      if (p === "/api/sessions") return json(await listSessions(q.get("key") || ""));
      if (p === "/api/recent") {
        const lim = Math.min(Number(q.get("limit") || 60), 200);
        const all: any[] = [];
        for (const proj of await listProjects()) {
          for (const s of await listSessions(proj.key, 30))
            all.push({ ...s, project: proj.key, projectName: proj.name, projectPath: proj.path });
        }
        return json(all.sort((a, b) => b.mtime - a.mtime).slice(0, lim));
      }
      if (p === "/api/session") {
        const file = join(PROJECTS_DIR, q.get("key") || "", (q.get("id") || "") + ".jsonl");
        if (!existsSync(file)) return json({ error: "not found" }, 404);
        const raw = await readFile(file, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        const out = normalizeTranscript(lines);
        const custom = customTitles.get(q.get("id") || "");
        if (custom) { out.meta.title = custom; (out.meta as any).named = true; }
        // where a follower should start: the bytes up to the last complete line
        const cut = raw.lastIndexOf("\n");
        return json({ ...out, offset: cut >= 0 ? Buffer.byteLength(raw.slice(0, cut + 1)) : 0 });
      }
      if (p === "/api/live") return json({ now: Date.now(), sessions: lastLive, events: EVENTS.slice(-40) });
      if (p === "/api/follow") {
        const file = join(PROJECTS_DIR, q.get("key") || "", (q.get("id") || "") + ".jsonl");
        if (!existsSync(file)) return json({ error: "not found" }, 404);
        const from = Number(q.get("from") || 0);
        const signal = { closed: false };
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            const send = (o: any) => { if (signal.closed) return; try { ctrl.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n")); } catch { signal.closed = true; } };
            const beat = setInterval(() => send({ t: "ping" }), 20_000);
            followTranscript(file, from, (o) => { send(o); if (o.t === "gone") { signal.closed = true; clearInterval(beat); try { ctrl.close(); } catch {} } }, signal);
            (ctrl as any)._beat = beat;
          },
          cancel() { signal.closed = true; },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      if (p === "/api/da/state") return json(daState());
      if (p === "/api/da/stream") {
        const since = Number(q.get("since") || 0);
        let client: DaClient | null = null;
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            let closed = false;
            const send = (o: any) => { if (closed) return; try { ctrl.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n")); } catch { closed = true; if (client) DA.clients.delete(client); } };
            send({ t: "hello", d: daState(), seq: DA.seq });
            // a fresh page loads the transcript instead of replaying the ring; a reconnect replays what it missed
            if (q.get("replay") !== "0") for (const o of DA.ring) if (o.seq > since) send(o);
            client = send; DA.clients.add(client);
            const beat = setInterval(() => { if (closed) clearInterval(beat); else send({ t: "ping" }); }, 20_000);
            if (!DA.child && !DA.starting) daStart();   // opening the desk boots it
          },
          cancel() { if (client) DA.clients.delete(client); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      if (p === "/api/da/send" && req.method === "POST") {
        const { text } = await req.json().catch(() => ({}) as any);
        const t = String(text || "").trim();
        if (!t) return json({ error: "empty" }, 400);
        return json(await daSend(t));
      }
      if (p === "/api/da/interrupt" && req.method === "POST") return json({ ok: daInterrupt() });
      if (p === "/api/da/reset" && req.method === "POST") return json(await daReset());
      if (p === "/api/da/config" && req.method === "POST") {
        const { permissionMode, model } = await req.json().catch(() => ({}) as any);
        if (typeof permissionMode === "string") DA.permissionMode = permissionMode;
        if (typeof model === "string") DA.model = model;
        await daSaveState();
        return json(await daReset());
      }
      if (p === "/api/voice/health") return json(await voiceHealth());
      if (p === "/api/voice/warm" && req.method === "POST") { sttStart().then(sttTouch); return json({ ok: true, engine: await sttEngine() }); }
      if (p === "/api/tts" && req.method === "POST") {
        const { text } = await req.json().catch(() => ({}) as any);
        return ttsRespond(String(text || ""));
      }
      if (p === "/api/stt" && req.method === "POST") {
        const ct = req.headers.get("content-type") || "audio/webm";
        const ext = ct.includes("mp4") ? "mp4" : ct.includes("ogg") ? "ogg" : ct.includes("wav") ? "wav" : "webm";
        const dir = join(DATA_DIR, "tmp"); await mkdir(dir, { recursive: true });
        const raw = join(dir, "utt-" + Date.now() + "." + ext), wav = raw.replace(/\.[^.]+$/, ".wav");
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length < 800) return json({ text: "", error: "too short" });
        await Bun.write(raw, bytes);
        // whisper wants 16 kHz mono; ffmpeg also turns whatever the browser recorded into that
        const ff = Bun.spawn(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { stdout: "ignore", stderr: "pipe" });
        const code = await ff.exited;
        const r = await transcribe(code === 0 ? wav : raw);
        Bun.spawn(["rm", "-f", raw, wav, wav.replace(/\.wav$/, ".txt")]);
        if (r.text !== undefined) logRow({ ts: Date.now(), kind: "voice.heard", msg: r.text.slice(0, 140), ms: r.ms });
        return json(r);
      }
      if (p === "/api/route" && req.method === "POST") {
        const { prompt, previous } = await req.json().catch(() => ({}) as any);
        return json(await routeAgent(String(prompt ?? ""), String(previous ?? "")));
      }
      if (p === "/api/agents") return json(await collectAgents());
      if (p === "/api/skills") return json(await collectSkills());
      if (p === "/api/instructions") return json(await collectInstructions());
      if (p === "/api/hooks") return json(await collectHooks());
      if (p === "/api/activity") {
        const now = Date.now();
        const dayStart = new Date(new Date().toDateString()).getTime();
        const todayLog = LOG.filter((r) => r.ts >= dayStart);
        const sessions: any[] = [];
        for (const proj of await listProjects()) {
          for (const s of await listSessions(proj.key, 40))
            if (s.mtime >= dayStart) sessions.push({ ...s, project: proj.key, projectName: proj.name, projectPath: proj.path });
        }
        sessions.sort((a, b) => b.mtime - a.mtime);
        // resolve session ids in the log to a readable title
        const idx = new Map<string, any>();
        for (const x of sessions) idx.set(x.id, { key: x.project, title: x.title, project: x.projectName, path: x.projectPath });
        const projectDirs = (await readdir(PROJECTS_DIR).catch(() => [])) as string[];
        const decorate = async (r: LogRow) => {
          if (!r.session) return { ...r };
          let hit = idx.get(r.session);
          if (!hit) {
            for (const d of projectDirs) {
              const f = join(PROJECTS_DIR, d, r.session + ".jsonl");
              if (!existsSync(f)) continue;
              const m = await sessionMeta(d, f);
              hit = m ? { key: d, title: m.title, project: basename(m.cwd || d), path: m.cwd } : null;
              if (hit) idx.set(r.session, hit);
              break;
            }
          }
          return { ...r, sessionTitle: hit?.title, sessionKey: hit?.key, sessionPath: hit?.path };
        };
        const logOut = await Promise.all(LOG.slice(-200).reverse().map(decorate));
        return json({
          now,
          live: [...running.values()].map((r) => ({ ...r, elapsed: now - r.started, title: idx.get(r.id)?.title })),
          summary: {
            running: running.size,
            turns: todayLog.filter((r) => r.kind === "turn.start").length,
            done: todayLog.filter((r) => r.kind === "turn.done").length,
            failed: todayLog.filter((r) => r.kind === "turn.error" || r.kind === "turn.exit").length,
            stopped: todayLog.filter((r) => r.kind === "turn.stop").length,
            spend: todayLog.reduce((a, r) => a + (r.cost || 0), 0),
            wall: todayLog.reduce((a, r) => a + (r.ms || 0), 0),
            saves: todayLog.filter((r) => r.kind === "file.save").length,
            sessionsToday: sessions.length,
          },
          log: logOut,
          sessions: sessions.slice(0, 30),
        });
      }
      if (p === "/api/configs") {
        const [ins, sk, ag] = [await collectInstructions(), await collectSkills(), await collectAgents()];
        const group = (g: string, arr: any[]) => arr.map((x) => ({ group: g, ...x }));
        const core = ins.filter((i) => i.tag === "core" || i.tag === "config" || i.tag === "pai");
        const mem = ins.filter((i) => i.tag === "memory" || i.tag === "memory-index");
        return json([
          ...group("Core", core.map((c) => ({ label: c.label, path: c.path, bytes: c.bytes, mtime: c.mtime }))),
          ...group("Memory", mem.map((c) => ({ label: c.label, path: c.path, bytes: c.bytes, mtime: c.mtime }))),
          ...group("Agents", ag.map((a) => ({ label: a.name, path: a.path, desc: a.description, sub: a.category }))),
          ...group("Skills", sk.map((x) => ({ label: x.name, path: x.path, desc: x.description, sub: x.source, bytes: x.bytes, mtime: x.mtime }))),
        ]);
      }

      if (p === "/api/dir") {
        const abs = guard(q.get("path") || HOME);
        if (!abs) return json({ error: "outside your Bridge folders — add it in Files" }, 403);
        const entries = [];
        for (const d of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
          if (d.name.startsWith(".") && q.get("hidden") !== "1") continue;
          const full = join(abs, d.name);
          const st = await stat(full).catch(() => null);
          entries.push({ name: d.name, dir: d.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
        }
        entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
        const atRoot = ROOTS.indexOf(abs) >= 0;
        return json({ path: abs, parent: atRoot ? null : dirname(abs), entries, roots: ROOTS });
      }
      if (p === "/api/file") {
        const abs = guard(q.get("path") || "");
        if (!abs) return json({ error: "outside your Bridge folders — add it in Files" }, 403);
        if (isSensitive(abs)) return json({ path: abs, blocked: true, text: "🔒 Blocked by Bridge — this path may hold credentials." });
        const st = await stat(abs).catch(() => null);
        if (!st || st.isDirectory()) return json({ error: "not a file" }, 404);
        const ext = extname(abs).toLowerCase();
        if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"].includes(ext))
          return json({ path: abs, size: st.size, binary: true, url: "/api/raw?path=" + encodeURIComponent(abs), ext });
        if (st.size > 800_000) return json({ path: abs, size: st.size, text: "File too large to preview (" + Math.round(st.size / 1024) + " KB).", lang: "text" });
        return json({ path: abs, size: st.size, mtime: st.mtimeMs, lang: LANGS[ext] || "text", text: await readFile(abs, "utf8") });
      }
      if (p === "/api/roots") {
        if (req.method === "POST") {
          const { roots } = await req.json();
          const next = (roots || []).map((r: string) => resolve(String(r)))
            .filter((r: string) => r.startsWith(HOME + sep) || r === HOME);
          await Bun.write(ROOTS_FILE, JSON.stringify(next, null, 2));
          ROOTS = next;
          logRow({ ts: Date.now(), kind: "folders", msg: next.map((x: string) => x.split("/").pop()).join(", "), outcome: next.length + " folders" });
          return json(ROOTS);
        }
        return json(await readRoots());
      }
      if (p === "/api/save" && req.method === "POST") {
        const { path: fp, text } = await req.json();
        const abs = guard(fp);
        if (!abs) return json({ error: "outside your Bridge folders — add it in Files" }, 403);
        if (isSensitive(abs)) return json({ error: "this path is protected" }, 403);
        if (typeof text !== "string" || text.length > 5_000_000) return json({ error: "bad payload" }, 400);
        await Bun.write(abs, text);
        const st = await stat(abs);
        logRow({ ts: Date.now(), kind: "file.save", msg: basename(abs), outcome: Math.round(st.size / 102.4) / 10 + " KB", cwd: dirname(abs) });
        return json({ ok: true, size: st.size, mtime: st.mtimeMs });
      }
      if (p === "/api/raw") {
        const abs = guard(q.get("path") || "");
        if (!abs || isSensitive(abs)) return new Response("blocked", { status: 403 });
        return new Response(Bun.file(abs));
      }
      if (p === "/api/open" && req.method === "POST") {
        const { path } = await req.json();
        const abs = guard(path);
        if (!abs) return json({ error: "outside your Bridge folders — add it in Files" }, 403);
        Bun.spawn(["open", abs]);
        return json({ ok: true });
      }
      if (p === "/api/find") {
        const res = await findSessions(q.get("q") || "", q.get("scope") || "all", q.get("key") || "", q.get("cwd") || "");
        return json(res);
      }
      if (p === "/api/search") {
        const term = (q.get("q") || "").toLowerCase();
        if (term.length < 2) return json([]);
        const projects = await listProjects();
        const hits: any[] = [];
        for (const proj of projects.slice(0, 40)) {
          for (const s of await listSessions(proj.key, 60)) {
            if ((s.title + " " + s.preview).toLowerCase().includes(term))
              hits.push({ ...s, project: proj.name, projectPath: proj.path });
            if (hits.length > 60) break;
          }
        }
        return json(hits.sort((a, b) => b.mtime - a.mtime));
      }

      if (p === "/api/rename" && req.method === "POST") {
        const { id, title } = await req.json();
        if (!id || typeof id !== "string") return json({ error: "id required" }, 400);
        const t = await setTitle(id, String(title ?? ""));
        logRow({ ts: Date.now(), kind: "session.rename", msg: t || "(cleared)", session: id });
        return json({ ok: true, id, title: t, named: !!t });
      }
      if (p === "/api/abort" && req.method === "POST") {
        const { sessionId } = await req.json();
        const c = live.get(sessionId);
        // same gesture as Ctrl+C in the terminal: interrupt first, only then insist
        if (c) {
          c.kill("SIGINT");
          const pid = c.pid;
          setTimeout(() => { try { if (live.get(sessionId) === c) c.kill("SIGTERM"); } catch {} }, 1500);
          setTimeout(() => { try { if (pid && live.get(sessionId) === c) process.kill(pid, "SIGKILL"); } catch {} }, 4000);
          live.delete(sessionId); running.delete(sessionId);
          logRow({ ts: Date.now(), kind: "turn.stop", msg: running.get(sessionId)?.prompt || "turn interrupted", outcome: "interrupted", session: sessionId, cwd: running.get(sessionId)?.cwd });
        }
        return json({ ok: !!c });
      }

      if (p === "/api/chat" && req.method === "POST") {
        const body = await req.json();
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            let closed = false;
            const send = (o: any) => {
              if (closed) return;
              try { ctrl.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n")); } catch { closed = true; }
            };
            // A turn that launches a workflow goes quiet for as long as the agents run, and Bun
            // drops an idle connection at 255s. A tick every 20s is what lets a long fan-out
            // finish and report back into the same turn instead of dying half-way.
            const beat = setInterval(() => send({ t: "ping", ts: Date.now() }), 20_000);
            runClaude(body, send, () => {
              clearInterval(beat);
              if (!closed) { closed = true; try { ctrl.close(); } catch {} }
            });
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }

      /* static */
      if (p === "/favicon.ico") return new Response(null, { status: 204 });
      const rel = p === "/" ? "/index.html" : p;
      const file = Bun.file(join(UI_DIR, rel));
      if (await file.exists()) return new Response(file, { headers: { "cache-control": "no-store" } });
      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      return json({ error: String(e?.stack || e) }, 500);
    }
  },
});

console.log(`\n  ⛵  Bridge is up  →  http://localhost:${server.port}\n     reading ${CLAUDE_DIR}\n`);
