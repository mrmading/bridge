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
  return { events, meta: { model, cwd, branch, title, usage, outputs, hookCount } };
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
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--append-system-prompt", BRIDGE_PROTOCOL];
  if (req.resume) args.push("--resume", req.resume);
  else args.push("--session-id", sessionId);
  args.push("--permission-mode", req.permissionMode || "acceptEdits");
  if (req.model) args.push("--model", req.model);
  if (req.agent) args.push("--agent", req.agent);
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
        const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
        const out = normalizeTranscript(lines);
        const custom = customTitles.get(q.get("id") || "");
        if (custom) { out.meta.title = custom; (out.meta as any).named = true; }
        return json(out);
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
            runClaude(body, send, () => { if (!closed) { closed = true; try { ctrl.close(); } catch {} } });
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }

      /* static */
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
