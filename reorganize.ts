/**
 * Reorganize: sort a flat work folder (~/Desktop/Cowork) into projects, one folder at a time, without a model.
 *
 * Each top-level folder gets a type:
 *   project   the folder IS the project's home (~/Projects/<Project>)
 *   working   a working folder that belongs to a project (~/Projects/<Project>/<folder>)
 *   codebase  a codebase that belongs to a project       (~/Projects/<Project>/<folder>)
 *   skip      stays where it is
 * Miscellaneous and Personal always exist. Nothing moves until apply: plan() shows every move first.
 *
 * Apply moves each folder, leaves a symlink at the old path (so old chats, scripts and git records still
 * resolve), moves the folder's Claude session history to the new path's key, repairs git worktree links,
 * keeps nested folders out of a project root's git status, and writes a log that undo() reverses.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type Kind = "project" | "working" | "codebase" | "skip";
type Decision = { type: Kind; project?: string; at: number };
type State = { root: string; target: string; projects: string[]; decisions: Record<string, Decision> };
type Move = { folder: string; from: string; to: string; project: string; type: Kind; exclude?: string };
type Applied = { at: number; moves: Move[]; sessions: { from: string; to: string }[]; links: string[]; made: string[] };

const DEFAULT_PROJECTS = ["Miscellaneous", "Personal"];
const KINDS: Kind[] = ["project", "working", "codebase", "skip"];
const projectKey = (cwd: string) => String(cwd).replace(/[^A-Za-z0-9]/g, "-");
const cleanName = (s: string) => String(s || "").replace(/[\/\\\0]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 8000 });
  return r.status === 0 ? String(r.stdout).trim() : "";
};

export function createReorganize(opts: { home: string; claudeDir: string }) {
  const { home, claudeDir } = opts;
  const STATE = join(claudeDir, "bridge", "reorganize.json");
  const LOGS = join(claudeDir, "bridge", "reorganize-applied");
  const SESSIONS = join(claudeDir, "projects");
  const defaults = (): State => ({
    root: process.env.BRIDGE_REORG_ROOT || join(home, "Desktop", "Cowork"),
    target: process.env.BRIDGE_REORG_TARGET || join(home, "Projects"),
    projects: DEFAULT_PROJECTS.slice(),
    decisions: {},
  });

  async function load(): Promise<State> {
    const s: State = { ...defaults(), ...JSON.parse(await readFile(STATE, "utf8").catch(() => "{}")) };
    for (const p of DEFAULT_PROJECTS) if (!s.projects.includes(p)) s.projects.unshift(p);
    return s;
  }
  async function save(s: State) {
    await mkdir(dirname(STATE), { recursive: true });
    await writeFile(STATE, JSON.stringify(s, null, 2));
  }

  /** the folders to sort: every top-level entry of the root that is a folder (or a link to one), not hidden */
  function folders(s: State): string[] {
    if (!existsSync(s.root)) return [];
    return readdirSync(s.root, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") && (d.isDirectory() || d.isSymbolicLink()))
      .filter((d) => !(d.isSymbolicLink() && moved(s, d.name)))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  }
  /** a link this tool left behind after a move is not a folder to sort again */
  function moved(s: State, name: string) {
    try { return realpathSync(join(s.root, name)).startsWith(s.target + "/"); } catch { return false; }
  }

  /** what the principal needs to classify a folder: cheap facts only (no du on a 4 GB tree) */
  function facts(s: State, name: string) {
    const path = join(s.root, name);
    const l = lstatSync(path);
    const link = l.isSymbolicLink() ? readlinkSync(path) : "";
    let real = path, broken = false;
    try { real = realpathSync(path); } catch { broken = true; }
    const out: any = { name, path, link, broken, items: 0, modified: 0, git: null, readme: "" };
    if (broken) return out;
    let entries: string[] = [];
    try { entries = readdirSync(real); } catch {}
    out.items = entries.length;
    out.modified = statSync(real).mtimeMs;
    for (const e of entries.slice(0, 400)) {
      if (e === "node_modules" || e === ".git") continue;
      try { out.modified = Math.max(out.modified, statSync(join(real, e)).mtimeMs); } catch {}
    }
    out.sample = entries.filter((e) => !e.startsWith(".")).slice(0, 12);
    const readme = ["README.md", "CLAUDE.md", "readme.md"].map((f) => join(real, f)).find((f) => existsSync(f));
    if (readme) {
      const line = readFileSync(readme, "utf8").split("\n").map((x) => x.replace(/<[^>]+>/g, "").replace(/^[#>\s*]+/, "").trim()).filter(Boolean).slice(0, 2).join(" · ");
      out.readme = line.slice(0, 220);
    }
    const dotgit = join(real, ".git");
    if (existsSync(dotgit)) {
      const worktree = statSync(dotgit).isFile();
      const common = git(real, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const status = git(real, "status", "--porcelain");
      out.git = {
        worktree, of: worktree && common ? basename(dirname(common)) : "",
        branch: git(real, "branch", "--show-current"),
        remote: git(real, "remote", "get-url", "origin").replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, ""),
        last: git(real, "log", "-1", "--format=%cs %s").slice(0, 140),
        dirty: status ? status.split("\n").length : 0,
      };
    }
    return out;
  }

  async function view() {
    const s = await load();
    const all = folders(s);
    const pending = all.filter((f) => !s.decisions[f]);
    const roots: Record<string, string> = {};
    for (const [f, d] of Object.entries(s.decisions)) if (d.type === "project" && d.project) roots[d.project] = f;
    return {
      root: s.root, target: s.target, rootExists: existsSync(s.root),
      projects: s.projects.map((name) => ({ name, root: roots[name] || "", count: Object.values(s.decisions).filter((d) => d.project === name).length })),
      total: all.length, done: all.length - pending.length,
      current: pending[0] ? facts(s, pending[0]) : null,
      decisions: all.filter((f) => s.decisions[f]).map((f) => ({ folder: f, ...s.decisions[f] })).sort((a, b) => b.at - a.at),
      last: await lastApplied(),
    };
  }

  async function decide(body: any) {
    const s = await load();
    const folder = String(body.folder || ""), type = body.type as Kind;
    if (!folders(s).includes(folder)) return { error: "No folder named " + folder + " in " + s.root };
    if (!KINDS.includes(type)) return { error: "Type must be one of " + KINDS.join(", ") };
    let project = cleanName(body.project);
    if (type !== "skip") {
      if (!project) return { error: "Pick a project" };
      const known = s.projects.find((p) => p.toLowerCase() === project.toLowerCase());
      if (known) project = known; else s.projects.push(project);
      if (type === "project") {
        const other = Object.entries(s.decisions).find(([f, d]) => f !== folder && d.type === "project" && d.project === project);
        if (other) return { error: project + " already has its home: " + other[0] + ". File this one as a working folder or codebase." };
      }
    }
    s.decisions[folder] = { type, ...(type === "skip" ? {} : { project }), at: Date.now() };
    await save(s);
    return view();
  }

  async function undecide(body: any) {
    const s = await load();
    delete s.decisions[String(body.folder || "")];
    await save(s);
    return view();
  }

  async function addProject(body: any) {
    const s = await load();
    const name = cleanName(body.name);
    if (!name) return { error: "Name the project" };
    if (!s.projects.some((p) => p.toLowerCase() === name.toLowerCase())) s.projects.push(name);
    await save(s);
    return view();
  }

  /** every move apply would make, in order: project homes first, then the folders that nest inside them */
  async function plan() {
    const s = await load();
    const all = new Set(folders(s));
    const moves: Move[] = [], problems: string[] = [];
    const decided = Object.entries(s.decisions).filter(([f, d]) => all.has(f) && d.type !== "skip" && d.project);
    const homes = new Map<string, string>();
    for (const [f, d] of decided) if (d.type === "project") homes.set(d.project!, f);
    for (const [f, d] of decided.filter(([, d]) => d.type === "project")) moves.push({ folder: f, from: join(s.root, f), to: join(s.target, d.project!), project: d.project!, type: d.type });
    for (const [f, d] of decided.filter(([, d]) => d.type !== "project")) {
      const homeFolder = homes.get(d.project!);
      const homeIsGit = homeFolder ? existsSync(join(s.root, homeFolder, ".git")) && statSync(join(s.root, homeFolder, ".git")).isDirectory() : false;
      moves.push({ folder: f, from: join(s.root, f), to: join(s.target, d.project!, f), project: d.project!, type: d.type, ...(homeIsGit ? { exclude: "/" + f + "/" } : {}) });
    }
    for (const m of moves) if (existsSync(m.to)) problems.push(m.to + " already exists; " + m.folder + " will not move");
    return { root: s.root, target: s.target, moves, problems, skipped: Object.entries(s.decisions).filter(([f, d]) => all.has(f) && d.type === "skip").map(([f]) => f), undecided: [...all].filter((f) => !s.decisions[f]) };
  }

  /** Claude session dirs whose recorded cwd is the folder or inside it, read before anything moves */
  async function sessionDirs(path: string): Promise<{ dir: string; cwd: string }[]> {
    const realOf = (p: string) => { try { return realpathSync(p); } catch { return ""; } };
    const target = realOf(path);
    if (!target) return [];
    const out: { dir: string; cwd: string }[] = [];
    for (const d of await readdir(SESSIONS, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      const dir = join(SESSIONS, d.name);
      const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
      let cwd = "";
      for (const f of files.slice(0, 3)) {
        const head = (await readFile(join(dir, f), "utf8").catch(() => "")).slice(0, 200_000);
        const m = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m) { cwd = JSON.parse('"' + m[1] + '"'); break; }
      }
      if (!cwd) continue;
      const real = realOf(cwd);
      if (real && (real === target || real.startsWith(target + "/"))) out.push({ dir, cwd: real });
    }
    return out;
  }

  async function apply() {
    const p = await plan();
    const blocked = new Set(p.moves.filter((m) => existsSync(m.to)).map((m) => m.folder));
    const moves = p.moves.filter((m) => !blocked.has(m.folder));
    if (!moves.length) return { error: p.moves.length ? "Every move is blocked: " + p.problems.join("; ") : "Nothing to move yet" };
    const log: Applied = { at: Date.now(), moves: [], sessions: [], links: [], made: [] };
    const errors: string[] = [];
    // read every folder's chats before any path changes under them
    const chats = new Map<string, { dir: string; cwd: string }[]>();
    for (const m of moves) chats.set(m.folder, await sessionDirs(m.from));
    const gitDirs: { to: string; worktree: boolean }[] = [];
    for (const m of moves) {
      try {
        if (!existsSync(dirname(m.to))) { await mkdir(dirname(m.to), { recursive: true }); log.made.push(dirname(m.to)); }
        const realFrom = (() => { try { return realpathSync(m.from); } catch { return m.from; } })();
        const linkOnly = lstatSync(m.from).isSymbolicLink();
        await rename(m.from, m.to);
        await symlink(m.to, m.from);
        log.links.push(m.from);
        log.moves.push(m);
        if (!linkOnly && existsSync(join(m.to, ".git"))) gitDirs.push({ to: m.to, worktree: statSync(join(m.to, ".git")).isFile() });
        if (m.exclude) {
          const ex = join(p.target, m.project, ".git", "info", "exclude");
          await mkdir(dirname(ex), { recursive: true });
          const cur = await readFile(ex, "utf8").catch(() => "");
          if (!cur.split("\n").includes(m.exclude)) await appendFile(ex, (cur && !cur.endsWith("\n") ? "\n" : "") + m.exclude + "\n");
        }
        // the folder's chats follow it: Claude finds history by the cwd's key
        for (const c of chats.get(m.folder) || []) {
          const newCwd = m.to + c.cwd.slice(realFrom.length);
          const dest = join(SESSIONS, projectKey(newCwd));
          if (dest === c.dir) continue;
          if (!existsSync(dest)) { await rename(c.dir, dest); log.sessions.push({ from: c.dir, to: dest }); }
          else {
            for (const f of await readdir(c.dir)) if (!existsSync(join(dest, f))) { await rename(join(c.dir, f), join(dest, f)); log.sessions.push({ from: join(c.dir, f), to: join(dest, f) }); }
          }
        }
      } catch (e) { errors.push(m.folder + ": " + String((e as Error).message || e)); }
    }
    // a worktree and its main repo both point at the other's path; tell git where they live now
    for (const g of gitDirs.filter((g) => !g.worktree)) {
      const wts = gitDirs.filter((w) => w.worktree).map((w) => w.to);
      spawnSync("git", ["-C", g.to, "worktree", "repair", ...wts], { timeout: 20000 });
    }
    for (const g of gitDirs.filter((g) => g.worktree)) spawnSync("git", ["-C", g.to, "worktree", "repair"], { timeout: 20000 });
    await writeRegistry(p.target);
    await mkdir(LOGS, { recursive: true });
    await writeFile(join(LOGS, log.at + ".json"), JSON.stringify(log, null, 2));
    return { ok: true, moved: log.moves.length, chats: log.sessions.length, errors, blocked: [...blocked], view: await view() };
  }

  /** ~/Projects/projects.json + one .project.json per project: projects exist without a folder pegged to them */
  async function writeRegistry(target: string) {
    const s = await load();
    const reg = s.projects.map((name) => {
      const items = Object.entries(s.decisions).filter(([, d]) => d.project === name).map(([f, d]) => ({ folder: f, type: d.type, path: d.type === "project" ? join(target, name) : join(target, name, f) }));
      return { name, path: join(target, name), items };
    });
    await mkdir(target, { recursive: true });
    for (const r of reg) {
      if (!r.items.length && !DEFAULT_PROJECTS.includes(r.name)) continue;
      await mkdir(r.path, { recursive: true });
      const f = join(r.path, ".project.json");
      const prev = JSON.parse(await readFile(f, "utf8").catch(() => "{}"));
      await writeFile(f, JSON.stringify({ name: r.name, created: prev.created || new Date().toISOString().slice(0, 10), items: r.items }, null, 2));
      const ex = join(r.path, ".git", "info", "exclude");
      if (existsSync(join(r.path, ".git", "info")) && !(await readFile(ex, "utf8").catch(() => "")).split("\n").includes("/.project.json")) await appendFile(ex, "/.project.json\n");
    }
    await writeFile(join(target, "projects.json"), JSON.stringify({ updated: new Date().toISOString(), projects: reg }, null, 2));
  }

  async function lastApplied(): Promise<{ at: number; moved: number } | null> {
    const files = (await readdir(LOGS).catch(() => [])).filter((f) => /^\d+\.json$/.test(f)).sort();
    if (!files.length) return null;
    const log: Applied = JSON.parse(await readFile(join(LOGS, files[files.length - 1]), "utf8"));
    return { at: log.at, moved: log.moves.length };
  }

  /** reverse the last apply: chats back, links removed, folders back, in reverse order */
  async function undo() {
    const files = (await readdir(LOGS).catch(() => [])).filter((f) => /^\d+\.json$/.test(f)).sort();
    if (!files.length) return { error: "Nothing to undo" };
    const file = join(LOGS, files[files.length - 1]);
    const log: Applied = JSON.parse(await readFile(file, "utf8"));
    const errors: string[] = [];
    for (const x of log.sessions.slice().reverse()) { try { if (existsSync(x.to) && !existsSync(x.from)) { await mkdir(dirname(x.from), { recursive: true }); await rename(x.to, x.from); } } catch (e) { errors.push(String(e)); } }
    const gitDirs: string[] = [];
    for (const m of log.moves.slice().reverse()) {
      try {
        if (lstatSync(m.from).isSymbolicLink()) await unlink(m.from);
        await rename(m.to, m.from);
        if (existsSync(join(m.from, ".git"))) gitDirs.push(m.from);
      } catch (e) { errors.push(m.folder + ": " + String((e as Error).message || e)); }
    }
    for (const d of gitDirs) spawnSync("git", ["-C", d, "worktree", "repair", ...gitDirs.filter((x) => x !== d)], { timeout: 20000 });
    await rename(file, file.replace(/\.json$/, ".undone.json"));
    return { ok: true, restored: log.moves.length, errors, view: await view() };
  }

  /** one HTTP surface: GET /api/reorganize, /api/reorganize/plan; POST decide|undecide|project|apply|undo */
  async function route(req: Request, path: string): Promise<Response> {
    const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status: d && d.error && status === 200 ? 400 : status, headers: { "content-type": "application/json" } });
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const sub = path.replace(/^\/api\/reorganize\/?/, "");
    if (req.method === "GET" && sub === "") return json(await view());
    if (req.method === "GET" && sub === "plan") return json(await plan());
    if (req.method === "POST" && sub === "decide") return json(await decide(body));
    if (req.method === "POST" && sub === "undecide") return json(await undecide(body));
    if (req.method === "POST" && sub === "project") return json(await addProject(body));
    if (req.method === "POST" && sub === "apply") return json(await apply());
    if (req.method === "POST" && sub === "undo") return json(await undo());
    return json({ error: "not found" }, 404);
  }

  return { route, view, decide, undecide, addProject, plan, apply, undo, facts: (name: string) => load().then((s) => facts(s, name)) };
}
