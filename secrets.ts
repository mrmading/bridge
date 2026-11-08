/**
 * Tokens & keys: typed into a masked field in Bridge, never into the chat.
 *
 * Two scopes:
 *  - global  → ~/.claude/.env (the canonical LifeOS secrets file), KEY=value, mode 600. Other lines and
 *              comments in that file are kept as they are; a key that already exists is replaced in place.
 *  - project → <dataDir>/secrets/projects.json, keyed by the project's absolute path, mode 600 in a 700 dir.
 *              Deliberately outside the codebase, so a project token can never be committed.
 *
 * Every turn gets the global values plus those of the thread's folder and its ancestors (the deepest
 * folder wins) in its environment, so tools read $NAME without any file being opened. Values never
 * leave this module except through envFor(): the list returns names and a masked hint only.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type Scope = "global" | "project";
export type SecretInfo = { name: string; scope: Scope; hint: string; updatedAt: number; project?: string };

export const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const mask = (v: string) => (v.length <= 8 ? "•".repeat(Math.max(4, v.length)) : v.slice(0, 4) + "…" + v.slice(-4));

/** a .env line's value, unquoted */
function unquote(v: string) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  return v.replace(/\s+#.*$/, "");
}
const quote = (v: string) => (/^[A-Za-z0-9_\-.:/+=@,]+$/.test(v) ? v : '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"');
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of text.split("\n")) {
    const m = LINE.exec(l);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

async function atomic(file: string, body: string) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  await writeFile(tmp, body, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export function createSecrets(opts: { globalFile: string; dataDir: string }) {
  const dir = join(opts.dataDir, "secrets");
  const projFile = join(dir, "projects.json");
  type Proj = Record<string, Record<string, { v: string; at: number }>>;
  let writing: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>) => { const p = writing.then(f, f); writing = p.catch(() => {}); return p; };

  const readText = (f: string) => readFile(f, "utf8").catch(() => "");
  async function readProj(): Promise<Proj> { try { return JSON.parse(await readText(projFile)) || {}; } catch { return {}; } }
  async function writeProj(p: Proj) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    await atomic(projFile, JSON.stringify(p, null, 2));
  }
  /** when each global key was last set through Bridge (the .env file itself has no timestamps) */
  const stampsFile = join(dir, "global-stamps.json");
  async function stamps(): Promise<Record<string, number>> { try { return JSON.parse(await readText(stampsFile)) || {}; } catch { return {}; } }

  const norm = (p: string) => resolve(p || "/").replace(/\/+$/, "") || "/";
  const within = (cwd: string, root: string) => cwd === root || cwd.startsWith(root === "/" ? "/" : root + sep);

  function check(name: string, value?: string) {
    if (!NAME_RE.test(name)) return "Use capitals, digits and _ (like CLOUDFLARE_API_TOKEN).";
    if (value !== undefined) {
      if (!value.trim()) return "The value is empty.";
      if (/[\r\n]/.test(value)) return "Paste a single line.";
      if (value.length > 8192) return "That is longer than any token (8 KB max).";
    }
    return "";
  }

  return {
    check,
    /** names, scopes and masked hints: global ones plus the projects that contain `cwd` (or every project when cwd is empty) */
    async list(cwd = ""): Promise<SecretInfo[]> {
      const g = parseEnv(await readText(opts.globalFile)), st = await stamps(), p = await readProj(), c = cwd ? norm(cwd) : "";
      const out: SecretInfo[] = Object.entries(g).filter(([k, v]) => NAME_RE.test(k) && v)
        .map(([name, v]) => ({ name, scope: "global" as const, hint: mask(v), updatedAt: st[name] || 0 }));
      for (const [root, vars] of Object.entries(p)) {
        if (c && !within(c, root)) continue;
        for (const [name, x] of Object.entries(vars)) out.push({ name, scope: "project", hint: mask(x.v), updatedAt: x.at, project: root });
      }
      return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
    },
    set(name: string, value: string, scope: Scope, cwd: string) {
      return serial(async () => {
        const err = check(name, value);
        if (err) throw new Error(err);
        value = value.trim();
        if (scope === "project") {
          if (!cwd) throw new Error("No project folder for this token.");
          const p = await readProj(), root = norm(cwd);
          (p[root] ||= {})[name] = { v: value, at: Date.now() };
          await writeProj(p);
        } else {
          const text = await readText(opts.globalFile);
          const lines = text ? text.replace(/\n$/, "").split("\n") : [];
          let hit = false;
          for (let i = 0; i < lines.length; i++) {
            const m = LINE.exec(lines[i]);
            if (m && m[1] === name) { if (hit) { lines.splice(i--, 1); continue; } lines[i] = name + "=" + quote(value); hit = true; }
          }
          if (!hit) lines.push(name + "=" + quote(value));
          await atomic(opts.globalFile, lines.join("\n") + "\n");
          const st = await stamps(); st[name] = Date.now();
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await atomic(stampsFile, JSON.stringify(st));
        }
        return { name, scope, hint: mask(value) };
      });
    },
    remove(name: string, scope: Scope, cwd: string, project?: string) {
      return serial(async () => {
        if (scope === "project") {
          const p = await readProj(), root = norm(project || cwd);
          if (p[root]) { delete p[root][name]; if (!Object.keys(p[root]).length) delete p[root]; await writeProj(p); }
        } else {
          const text = await readText(opts.globalFile);
          if (!text) return;
          const lines = text.replace(/\n$/, "").split("\n").filter((l) => { const m = LINE.exec(l); return !(m && m[1] === name); });
          await atomic(opts.globalFile, lines.join("\n") + (lines.length ? "\n" : ""));
        }
      });
    },
    /** the variables a turn in `cwd` runs with: global, then project roots from shallow to deep */
    async envFor(cwd: string): Promise<Record<string, string>> {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(parseEnv(await readText(opts.globalFile)))) if (NAME_RE.test(k) && v) env[k] = v;
      const p = await readProj(), c = norm(cwd);
      for (const root of Object.keys(p).filter((r) => within(c, r)).sort((a, b) => a.length - b.length))
        for (const [k, x] of Object.entries(p[root])) env[k] = x.v;
      return env;
    },
  };
}
