/* ══════════════════════════ Bridge client ══════════════════════════
 * One page: a sidebar of chats, Home, Inbox, Projects, Files, Agents & skills, and the chat
 * itself. Every chat starts here and runs as a `claude -p` turn on the server, so it keeps going
 * when this page closes; reopening a running chat re-attaches to its transcript (/api/follow).
 * Views live in views.js, the Talk overlay and Copilot in voice.js. */
window.BridgeReady = new Promise((r) => (window._bridgeBooted = r));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tms = (t) => (typeof t === "number" ? t : t ? Date.parse(t) || 0 : 0);
const fmtTime = (t) => (t ? new Date(tms(t)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const fmtAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
};
const fmtShortAgo = (ms) => fmtAgo(ms).replace(" ago", "").replace("just now", "now");
/** an elapsed timer the way a person reads it: 42s, 6m 12s, 1h 04m */
const fmtEl = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? h + "h " + String(m).padStart(2, "0") + "m" : m ? m + "m " + String(x).padStart(2, "0") + "s" : x + "s";
};
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n | 0));
const fmtB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");
const short = (p, n = 46) => (String(p).length > n ? "…" + String(p).slice(-n + 1) : String(p));
const base = (p) => String(p || "").split("/").filter(Boolean).pop() || String(p || "");
const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const getJ = (u) => fetch(u).then((r) => r.json());
const ls = (k, v) => { try { if (v === undefined) return localStorage[k]; localStorage[k] = v; } catch (e) {} };

/* ── icons (from the prototype) ─────────────────────────────────── */
const I = {
  home: '<path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4.5l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M6 2h9l5 5v15H6zM15 2v5h5"/>',
  agents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  clip: '<path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  read: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 10.5V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 4 15.5l-1-3a1.5 1.5 0 0 1 2.7-1.2L8 15"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
  zap: '<path d="M4 14l6-11v8h6l-6 11v-8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  pulse: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
};
const ic = (n, sw = 1.8) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round">' + (I[n] || I.file) + "</svg>";

/* ── state ─────────────────────────────────────────────────────── */
const S = {
  boot: null, auth: { loggedIn: true }, home: { running: [], needs: [], made: [], projects: [] }, homeAt: 0,
  recent: [], agents: [], skills: [], configs: [], roots: [], hooks: null, lifeos: null, voice: null,
  view: "home", chat: null, chats: new Map(), proj: null, doc: null, prevView: "home",
  panel: innerWidth > 900, ptab: "files", pfile: null,
  tech: ls("bridgeTech") === "1",
  perm: ls("bridgePerm") || "acceptEdits", model: ls("bridgeModel") || "", effort: ls("bridgeEffort") || "", ultra: ls("bridgeUltra") === "1",
  agent: ls("bridgeAgent") === undefined ? "auto" : ls("bridgeAgent"), newPath: (ls("bridgeComputer") === "cloud" ? ls("bridgeCwdCloud") : ls("bridgeCwd")) || "", computer: ls("bridgeComputer") === "cloud" ? "cloud" : "mac", computers: [], provider: ls("bridgeProvider") === "qwen" ? "qwen" : "claude",
  inboxF: "all", filesF: "made", filesKind: "All", filesQ: "", dir: null, agentCat: "All", agentQ: "", projQ: "",
  setTab: "general", attachments: [], drafts: {}, readAt: +(ls("bridgeReadAt") || 0), announced: new Set(),
};
const MODES = {
  plan: { label: "Plan first", help: "Reads and proposes. Changes nothing until you say go", c: "var(--think)" },
  manual: { label: "Ask before changes", help: "Checks with you before every edit or command", c: "var(--ok)" },
  acceptEdits: { label: "Edit freely", help: "Edits files on its own, asks before running commands", c: "var(--accent)" },
  auto: { label: "Let Claude decide", help: "Runs what it judges safe, asks only when unsure", c: "var(--accent2)" },
  bypassPermissions: { label: "Autopilot", help: "Never stops to ask. Use for trusted, contained work", c: "var(--err)" },
};
const MODELS = {
  "": ["Default", "Whatever settings.json picks"], opus: ["Opus", "Best for hard, long work"], sonnet: ["Sonnet", "Fast and capable, cheaper"],
  haiku: ["Haiku", "Quick answers, cheapest"], fable: ["Fable", "Deepest thinking, slowest"],
};
const EFFORTS = { "": "Auto", low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max" };
const authed = () => !!(S.auth && S.auth.loggedIn);
const homeDir = () => (S.boot && S.boot.home) || "";
const userName = () => { const u = (S.boot && S.boot.user) || "you"; return u.charAt(0).toUpperCase() + u.slice(1); };
const daName = () => (S.boot && S.boot.assistant) || "Claude";
const projectName = (p) => (!p || p === homeDir() ? "Home" : base(p));
const projKey = (p) => String(p || "").replace(/[^A-Za-z0-9]/g, "-");
/** the query suffix that sends a request about a cloud chat on to the cloud */
const cq = (computer) => (computer === "cloud" ? "&computer=cloud" : "");
const cloudInfo = () => S.computers.find((x) => x.id === "cloud") || { online: false, configured: false };
const cloudOn = () => !!cloudInfo().online && !S.home.cloudOffline;
/** a small cloud mark for anything that lives on the cloud computer */
const cloudMark = (computer) => (computer === "cloud" ? '<span class="cmark" title="Cloud computer">' + ic("cloud", 2) + "</span>" : "");
const openRef = (key, id, computer) => esc(key + "|" + id + "|" + (computer || "mac"));
/** Qwen chats get a small tag wherever they are listed */
const qwenTag = (provider) => (provider === "qwen" ? '<span class="tag think qtag-p" title="Runs on Qwen (RunPod)">Qwen</span>' : "");
const providerOn = (id) => ((S.boot && S.boot.providers) || []).some((p) => p.id === id && p.available);
/** where a chat runs, for the label: a configured cloud is named as such, otherwise the host this server is */
const hostLabel = (computer) => (computer === "cloud" ? ic("cloud") + "Cloud computer" : (S.boot && S.boot.host && S.boot.host.kind === "cloud" ? ic("cloud") : ic("laptop")) + esc((S.boot && S.boot.host && S.boot.host.name) || "This Mac"));
const homeFor = (computer) => (computer === "cloud" ? cloudInfo().home || "" : homeDir());

/* deterministic colours for projects and agents that do not declare one */
const PALETTE = ["#1668c9", "#7a4fd0", "#137a4b", "#c0392b", "#9a5b00", "#0b7285", "#d6336c", "#e8590c", "#3f9ae0", "#5f3dc4", "#495057"];
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return PALETTE[Math.abs(h) % PALETTE.length]; };
const NAMED = { blue: "#1668c9", purple: "#7a4fd0", green: "#137a4b", red: "#c0392b", orange: "#e8590c", yellow: "#b08900", cyan: "#0b7285", pink: "#d6336c", gray: "#495057", grey: "#495057" };
function agentLook(name) {
  if (!name || name === "auto") return { name: "Auto", init: "A", color: "linear-gradient(135deg,var(--accent),var(--think))", role: "Bridge picks the right teammate for each message" };
  if (name === "none") return { name: "Claude Code", init: "C", color: "#3d4452", role: "Plain Claude Code with your instructions and hooks" };
  const a = S.agents.find((x) => x.name === name) || { name };
  const c = a.color ? NAMED[String(a.color).toLowerCase()] || (/^#|^rgb/.test(a.color) ? a.color : hue(name)) : hue(name);
  const words = String(name).replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean);
  const init = (words.length > 1 ? words[0][0] + words[1][0] : String(name).slice(0, 2)).toUpperCase().replace(/^(.)(.)$/, (m, a1, b1) => a1 + b1.toLowerCase());
  return { name, init, color: c, role: String(a.description || "").replace(/\s+/g, " ").slice(0, 110), model: a.model || "", category: a.category || "" };
}
const ava = (name, size) => { const a = agentLook(name); return '<span class="ava" style="background:' + a.color + (size ? ";width:" + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.4) + "px;border-radius:" + Math.round(size / 3.2) + "px" : "") + '">' + esc(a.init) + "</span>"; };
const projIco = (name, size) => '<span class="proj-ico" style="background:' + hue(name) + (size ? ";width:" + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.42) + "px;border-radius:" + Math.round(size / 3.2) + "px" : "") + '">' + esc(String(name || "?")[0].toUpperCase()) + "</span>";
const EXT_COLOR = { md: "#495057", html: "#e8590c", htm: "#e8590c", pdf: "#c02828", xlsx: "#137a4b", xls: "#137a4b", csv: "#137a4b", mp4: "#d6336c", mov: "#d6336c", png: "#7a4fd0", jpg: "#7a4fd0", jpeg: "#7a4fd0", svg: "#7a4fd0", webp: "#7a4fd0", ts: "#1668c9", tsx: "#1668c9", js: "#b08900", json: "#b08900", dart: "#0b7285", py: "#3f9ae0", sh: "#3d4452", sql: "#5f3dc4" };
const extOf = (p) => (String(p).match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
const extColor = (e) => EXT_COLOR[e] || "#495057";

/* ─────────────────────────── markdown ─────────────────────────── */
function inline(t) {
  return t
    .replace(/`([^`\n]+)`/g, (m, c) => "<code>" + c + "</code>")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
function md(src) {
  if (!src) return "";
  const code = [];
  src = String(src).replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, body) => {
    code.push('<pre><button class="copy" data-copy>copy</button><code class="lang-' + esc(lang) + '">' + esc(body.replace(/\n$/, "")) + "</code></pre>");
    return "\n@@CB" + (code.length - 1) + "@@\n";
  });
  const lines = esc(src).split("\n");
  let out = "", i = 0, para = [];
  const closePara = () => { if (para.length) out += "<p>" + inline(para.join("<br>")) + "</p>"; para = []; };
  while (i < lines.length) {
    const L = lines[i];
    const cb = L.trim().match(/^@@CB(\d+)@@$/);
    if (cb) { closePara(); out += code[+cb[1]]; i++; continue; }
    if (/^\s*$/.test(L)) { closePara(); i++; continue; }
    let m;
    if ((m = L.match(/^(#{1,6})\s+(.*)$/))) { closePara(); const n = Math.min(m[1].length + 1, 6); out += "<h" + n + ">" + inline(m[2]) + "</h" + n + ">"; i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|={3,})\s*$/.test(L)) { closePara(); out += "<hr>"; i++; continue; }
    if (/^&gt;\s?/.test(L)) {
      closePara();
      const b = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) b.push(lines[i++].replace(/^&gt;\s?/, ""));
      out += "<blockquote><p>" + inline(b.join("<br>")) + "</p></blockquote>";
      continue;
    }
    if (L.includes("|") && lines[i + 1] && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closePara();
      const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(L); i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|")) body.push(row(lines[i++]));
      out += "<table><thead><tr>" + head.map((h) => "<th>" + inline(h) + "</th>").join("") + "</tr></thead><tbody>" +
        body.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(L)) {
      closePara();
      const ordered = /^\s*\d+\./.test(L);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let txt = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""); i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) txt += " " + lines[i++].trim();
        items.push(txt);
      }
      const tag = ordered ? "ol" : "ul";
      out += "<" + tag + ">" + items.map((t) => "<li>" + inline(t) + "</li>").join("") + "</" + tag + ">";
      continue;
    }
    para.push(L); i++;
  }
  closePara();
  return out;
}
/** options the user can answer with one click: an explicit ```choices block, or a short list under a question */
function extractChoices(text) {
  const m = /```choices\s*\n([\s\S]*?)```/.exec(text || "");
  if (m) return { body: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n").trim(), choices: m[1].split("\n").map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean).slice(0, 6) };
  const t = String(text || "").trimEnd();
  if (!/\?\s*$/.test(t) && !/\?\s*\n[^\n]*$/.test(t)) return { body: text, choices: [] };
  const lines = t.split("\n"), opts = [];
  for (let i = lines.length - 1; i >= 0 && opts.length < 6; i--) {
    const mm = /^\s*(?:\d+[.)]|[-*•])\s+(.{2,90})$/.exec(lines[i]);
    if (mm) opts.unshift(mm[1].replace(/\*\*/g, "").trim()); else if (opts.length) break;
  }
  return { body: text, choices: opts.length >= 2 ? opts : [] };
}
/** the question a reply ends on, for the decision card */
function questionOf(text) {
  const lines = String(text || "").replace(/```[\s\S]*?```/g, "").split("\n").map((l) => l.replace(/[*_`#>]/g, "").trim()).filter(Boolean);
  return lines.reverse().find((l) => /\?$/.test(l)) || "Pick one";
}

/* ───────────────────── tools, in plain words ───────────────────── */
const TOOL_ICON = { Read: "read", Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Bash: "term", Grep: "search", Glob: "search", WebFetch: "globe", WebSearch: "globe", Task: "agents", Agent: "agents", TodoWrite: "list", Skill: "spark", Workflow: "zap", Artifact: "ext", AskUserQuestion: "hand", ExitPlanMode: "book" };
function toolSummary(name, inp) {
  inp = inp || {};
  switch (name) {
    case "Bash": return inp.command || "";
    case "Read": case "Write": case "Edit": case "NotebookEdit": return short(inp.file_path || inp.notebook_path || "");
    case "Glob": case "Grep": return (inp.pattern || "") + (inp.path ? "  in " + short(inp.path, 28) : "");
    case "WebFetch": return inp.url || "";
    case "WebSearch": return inp.query || "";
    case "Task": case "Agent": return (inp.subagent_type ? inp.subagent_type + " · " : "") + (inp.description || "");
    case "Skill": return inp.skill || "";
    case "TodoWrite": return (inp.todos || []).length + " items";
    default: return Object.entries(inp).slice(0, 2).map(([k, v]) => k + "=" + String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 40)).join(" ");
  }
}
/** what a step did, past tense for finished work, present for work in flight */
function stepText(name, inp, done) {
  inp = inp || {};
  const f = base(inp.file_path || inp.notebook_path || "");
  const P = (past, now) => (done ? past : now);
  switch (name) {
    case "Read": return P("Read ", "Reading ") + f;
    case "Write": return P("Wrote ", "Writing ") + f;
    case "Edit": case "MultiEdit": case "NotebookEdit": return P("Edited ", "Editing ") + f;
    case "Bash": return inp.description ? String(inp.description).replace(/\.$/, "") : P("Ran a command", "Running a command");
    case "Grep": return P("Searched the code for “", "Searching the code for “") + String(inp.pattern || "").slice(0, 40) + "”";
    case "Glob": return P("Looked for ", "Looking for ") + (inp.pattern || "files");
    case "WebSearch": return P("Searched the web for “", "Searching the web for “") + String(inp.query || "").slice(0, 60) + "”";
    case "WebFetch": { let h = "a page"; try { h = new URL(inp.url).host; } catch (e) {} return P("Read ", "Reading ") + h; }
    case "Task": case "Agent": return P("Asked ", "Asking ") + (inp.subagent_type || "a helper") + ": " + (inp.description || "");
    case "TodoWrite": return P("Updated the checklist", "Updating the checklist");
    case "Skill": return P("Used the ", "Using the ") + (inp.skill || "") + " skill";
    case "Workflow": return P("Ran a workflow", "Running a workflow") + (inp.name ? " · " + inp.name : "");
    case "AskUserQuestion": return "Asked you a question";
    case "ExitPlanMode": return "Presented a plan";
    default: return P("Used ", "Using ") + String(name).replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  }
}
function diffHtml(oldS, newS) {
  const a = String(oldS).split("\n"), b = String(newS).split("\n");
  return '<div class="pre">' + a.map((l) => '<span class="diff-l del">- ' + esc(l) + "</span>").join("") + b.map((l) => '<span class="diff-l add">+ ' + esc(l) + "</span>").join("") + "</div>";
}
function toolBody(name, inp, res) {
  inp = inp || {};
  let h = "";
  if (name === "Edit" && inp.old_string !== undefined) h += '<div class="tool-sec"><div class="tool-lab">' + esc(short(inp.file_path || "", 70)) + "</div>" + diffHtml(inp.old_string, inp.new_string) + "</div>";
  else if (name === "Write") h += '<div class="tool-sec"><div class="tool-lab">writes ' + esc(short(inp.file_path || "", 70)) + '</div><div class="pre">' + esc(String(inp.content || "").slice(0, 6000)) + "</div></div>";
  else if (name === "Bash") h += '<div class="tool-sec"><div class="tool-lab">command</div><div class="pre">' + esc(inp.command || "") + "</div></div>";
  else if (Object.keys(inp).length) h += '<div class="tool-sec"><div class="tool-lab">input</div><div class="pre">' + esc(JSON.stringify(inp, null, 2).slice(0, 4000)) + "</div></div>";
  if (res) {
    const txt = String(res.content == null ? "" : res.content);
    h += '<div class="tool-sec"><div class="tool-lab">' + (res.isError ? "error" : "result") + (txt.length > 4000 ? " · truncated" : "") + '</div><div class="pre">' + (esc(txt.slice(0, 4000)) || "<em>(empty)</em>") + "</div></div>";
  }
  return h || '<div class="tool-sec"><div class="pre">running…</div></div>';
}

/* ───────────────────────────── shell ───────────────────────────── */
function go(view, arg) {
  if (view !== "doc") S.prevView = view === "chat" ? "chat" : view;
  S.view = view;
  if (view === "project") S.proj = arg;
  $("#app").classList.remove("mnav");
  closeMenu();
  render();
  const v = $(".view"); if (v) v.scrollTo(0, 0);
  if (view === "files" && S.filesF === "browse" && !S.dir && S.roots[0]) openDir(S.roots[0]);
}
function render() {
  saveDraft();
  renderSide();
  const v = S.view, host = $("#viewHost");
  if (v === "chat") renderChatView();
  else host.innerHTML = (VIEWS[v] || VIEWS.home)();
  renderTop();
  bindView();
}
/** a text box survives every re-render of the view it sits in */
const draftKey = () => (S.view === "chat" ? "c:" + ((S.chat && (S.chat.id || S.chat.tmp)) || "new") : S.view);
function saveDraft() { const ta = $("#ta"); if (ta && ta.dataset.dk) S.drafts[ta.dataset.dk] = ta.value; }

function groupOf(ms) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const t = d0.getTime();
  if (ms >= t) return "Today";
  if (ms >= t - 86400000) return "Yesterday";
  if (ms >= t - 6 * 86400000) return "This week";
  return "Earlier";
}
function runningList() {
  // the server's list, plus a chat this page has just started and the server has not reported yet
  const out = S.home.running.slice();
  for (const c of S.chats.values()) if (c.streaming && c.id && !out.some((r) => r.id === c.id)) out.push({ id: c.id, key: c.key, computer: c.computer, title: chatTitle(c), projectName: projectName(c.path), cwd: c.path, started: c.turnStart || Date.now(), step: c.step || "Starting", jobs: [] });
  return out;
}
function renderSide() {
  const nav = [["home", "Home", "home"], ["inbox", "Inbox", "inbox"], ["projects", "Projects", "folder"], ["files", "Files", "file"], ["agents", "Agents & skills", "agents"]];
  const runs = runningList(), needs = S.home.needs;
  const shown = new Set(runs.map((r) => r.id).concat(needs.map((n) => n.id)));
  const on = (id) => S.view === "chat" && S.chat && S.chat.id === id;
  const groups = {};
  for (const s of S.recent) {
    if (shown.has(s.id)) continue;
    const g = groupOf(s.mtime);
    (groups[g] = groups[g] || []).push(s);
  }
  const item = (id, key, title, extra, dot, computer, provider) => '<button class="chat-i ' + (on(id) ? "on" : "") + '" data-open="' + openRef(key, id, computer) + '" title="' + esc(title) + '">' + (dot ? '<span class="dot ' + dot + '"></span>' : "") + '<span class="t">' + esc(title) + "</span>" + qwenTag(provider) + cloudMark(computer) + extra + "</button>";
  const u = userName();
  $("#side").innerHTML =
    '<div class="brand"><div class="logo"><span>B</span></div><span class="name">BRIDGE</span><span class="spacer"></span>' +
    '<button class="icon-btn hide-sm" data-act="collapse" title="Hide sidebar">' + ic("side") + "</button>" +
    '<button class="icon-btn show-sm" data-act="mnav" title="Close">' + ic("x") + "</button></div>" +
    '<button class="newchat" data-act="new">' + ic("plus", 2.2) + "New chat<kbd>⌘T</kbd></button>" +
    '<div class="nav"><button class="nav-i" data-act="palette">' + ic("search") + "Search<kbd>⌘K</kbd></button>" +
    nav.map(([id, l, i]) => '<button class="nav-i ' + (S.view === id || (id === "projects" && S.view === "project") ? "on" : "") + '" data-go="' + id + '">' + ic(i) + l +
      (id === "inbox" && needs.length ? '<span class="badge warn">' + needs.length + "</span>" : "") + "</button>").join("") + "</div>" +
    '<div class="side-scroll">' +
    (runs.length || needs.length ? '<div class="side-h"><span class="dot run" style="width:6px;height:6px"></span>Working now</div>' +
      runs.map((r) => item(r.id, r.key, r.title, '<span class="m el" data-since="' + r.started + '">' + fmtEl(Date.now() - r.started) + "</span>", "run", r.computer, r.provider)).join("") +
      needs.slice(0, 6).map((n) => item(n.id, n.key, n.title, '<span class="m" style="color:var(--warn)">needs you</span>', "wait", n.computer, n.provider)).join("") : "") +
    (S.home.cloudOffline ? '<div class="side-empty" title="Bridge cannot reach the cloud computer right now">' + ic("cloud") + " Cloud computer offline</div>" : "") +
    ["Today", "Yesterday", "This week", "Earlier"].filter((g) => groups[g]).map((g) => '<div class="side-h">' + g + "</div>" +
      groups[g].slice(0, g === "Earlier" ? 15 : 40).map((s) => item(s.id, s.project, s.title, "", "", s.computer, s.provider)).join("")).join("") +
    (!S.recent.length && !runs.length ? '<div class="side-empty">Your chats show up here.</div>' : "") +
    "</div>" +
    '<div class="me"><div class="avatar" data-menu="me" title="Account">' + esc(u.slice(0, 2).toUpperCase()) + '</div><div class="who"><b>' + esc(u) + "</b><span>" +
    esc(authed() ? (S.auth.subscriptionType ? S.auth.subscriptionType.replace(/^\w/, (c) => c.toUpperCase()) + " plan" : S.auth.email || "Signed in") : "Not signed in") + "</span></div>" +
    '<button class="icon-btn" data-act="theme" title="Theme (⌘J)">' + ic(document.documentElement.dataset.theme === "dark" ? "sun" : "moon") + "</button>" +
    '<button class="icon-btn" data-act="settings" title="Settings">' + ic("gear") + "</button></div>";
}
function renderTop() {
  const burger = '<button class="icon-btn show-sm" data-act="mnav" title="Menu">' + ic("menu") + "</button>" +
    ($("#app").classList.contains("collapsed") ? '<button class="icon-btn hide-sm" data-act="collapse" title="Show sidebar">' + ic("side") + "</button>" : "");
  let title = "", right = "";
  const c = S.chat;
  if (S.view === "chat" && c && (c.id || c.msgs.length)) {
    title = projIco(projectName(c.path), 22) + '<span class="t" data-act="rename" title="Double-click to rename">' + esc(chatTitle(c)) + "</span>";
    right = '<span class="pill hide-sm" title="' + esc(c.path) + '">' + hostLabel(c.computer) + "</span>" +
      '<button class="pill ' + (S.panel ? "on" : "") + '" data-act="panel" title="Files & progress (⌘I)">' + ic("panel") + '<span class="hide-sm">Files &amp; progress</span></button>' +
      '<button class="icon-btn" data-menu="chatmenu" title="More">' + ic("more") + "</button>";
  } else if (S.view === "chat") title = '<span class="t">New chat</span>';
  else if (S.view === "doc" && S.doc) title = '<span class="t">' + esc(S.doc.title) + "</span>";
  $("#top").innerHTML = burger + '<div class="title">' + title + '</div><div class="spacer"></div>' + right +
    '<button class="pill" data-act="voice" title="Talk to ' + esc(daName()) + '">' + ic("mic") + '<span class="hide-sm">Talk</span></button>';
}

/* ─────────────────────────── composer ─────────────────────────── */
function composer(ph, opts) {
  opts = opts || {};
  const m = MODES[S.perm] || MODES.acceptEdits, a = agentLook(S.agent === "" ? "none" : S.agent);
  const c = S.chat, busy = c && chatBusy(c);
  const dk = opts.dk || draftKey();
  const ag = opts.chat && c && c.agent && S.agent === "auto" ? agentLook(c.agent) : a;
  return '<div class="composer" id="composer"><div class="ac" id="ac"></div><div class="attach-row" id="atts" style="display:none"></div>' +
    '<textarea rows="1" placeholder="' + esc(ph) + '" id="ta" data-dk="' + esc(dk) + '" spellcheck="false">' + esc(S.drafts[dk] || "") + "</textarea>" +
    '<div class="cbar">' +
    '<button class="cbtn outline" data-menu="plus" title="Add files, skills, mentions">' + ic("plus", 2) + "</button>" +
    (opts.chat ? "" : '<button class="cbtn" data-menu="proj" title="' + esc(S.newPath || homeDir()) + '">' + ic("folder") + '<span class="pname">' + esc(S.newPath ? projectName(S.newPath) : "Any project") + "</span>" + (S.computer === "cloud" ? '<span class="cmark">' + ic("cloud", 2) + "</span>" : "") + ic("chev") + "</button>") +
    '<button class="cbtn" data-menu="agent" title="' + esc(ag.role || "") + '">' + '<span class="ava" style="width:18px;height:18px;border-radius:6px;font-size:8px;background:' + ag.color + '">' + esc(ag.init) + '</span><span class="hide-sm">' + esc(ag.name) + "</span>" + ic("chev") + "</button>" +
    '<span class="spacer"></span>' +
    '<button class="cbtn ' + (S.perm === "bypassPermissions" ? "danger" : "") + '" data-menu="mode" title="' + esc(m.help) + '"><span class="mode-dot" style="background:' + m.c + '"></span><span class="hide-sm">' + m.label + "</span>" + ic("chev") + "</button>" +
    (curProvider() === "qwen" ? '<button class="cbtn" data-menu="model">Qwen<span class="hide-sm" style="color:var(--fg-faint)">· RunPod</span>' + ic("chev") + "</button>"
      : '<button class="cbtn ' + (S.ultra ? "god" : "") + '" data-menu="model">' + esc(S.ultra ? "God mode" : MODELS[S.model] ? MODELS[S.model][0] : S.model) + '<span class="hide-sm" style="color:var(--fg-faint)">· ' + esc(S.ultra ? "team" : EFFORTS[S.effort] || S.effort) + "</span>" + ic("chev") + "</button>") +
    (busy ? '<button class="stop" data-act="stop" title="Stop the running work">' + ic("stop", 2.4) + "</button>" : "") +
    '<button class="mic" data-act="dictate" title="Dictate">' + ic("mic") + "</button>" +
    '<button class="send" data-act="send" title="' + (busy ? "Queue: it goes the moment the current step ends (↵)" : "Send (↵)") + '">' + ic("up", 2.2) + "</button>" +
    "</div></div>";
}
function renderAttachments() {
  const box = $("#atts");
  if (!box) return;
  box.style.display = S.attachments.length ? "flex" : "none";
  box.innerHTML = S.attachments.map((a, i) => '<span class="att ' + (a.error ? "err" : "") + '" title="' + esc(a.name + (a.error ? " — " + a.error : "")) + '">' +
    (a.preview ? '<img src="' + esc(a.preview) + '">' : '<span class="ft" style="background:' + extColor(a.ext) + '">' + esc((a.ext || "file").slice(0, 4).toUpperCase()) + "</span>") +
    '<span class="n">' + esc(a.name) + '</span><span class="x" data-rmatt="' + i + '">✕</span></span>').join("");
}
async function addFiles(files) { for (const f of files) await addAttachment({ name: f.name, ext: extOf(f.name), file: f }); }
async function addAttachment(a) {
  if (S.attachments.some((x) => x.name === a.name && x.path === a.path)) return;
  if (a.file && ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(a.ext)) {
    a.preview = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(a.file); });
    const m = a.preview.match(/^data:([^;]+);base64,(.+)$/);
    if (m) { a.kind = "image"; a.mediaType = m[1]; a.data = m[2]; }
  } else if (a.file) {
    if (a.file.size > 200000) a.error = "too large to inline (" + fmtB(a.file.size) + ")";
    else { a.data = await a.file.text(); a.kind = "text"; }
  }
  if (!a.error && !a.kind && !a.path) a.error = "unreadable attachment";
  S.attachments.push(a);
  renderAttachments();
  const ta = $("#ta"); if (ta) ta.focus();
}

/* autocomplete: /skills and @files */
let acItems = [], acSel = 0, acStart = 0;
function closeAc() { const b = $("#ac"); if (b) b.classList.remove("on"); acItems = []; }
function renderAc() {
  const b = $("#ac");
  if (!b || !acItems.length) return closeAc();
  b.innerHTML = acItems.slice(0, 40).map((it, i) => '<div class="ac-i ' + (i === acSel ? "sel" : "") + '" data-aci="' + i + '"><span class="ac-n">' + esc(it.label) + '</span><span class="ac-d">' + esc(it.desc || "") + "</span></div>").join("");
  b.classList.add("on");
  const sel = b.querySelector(".sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
}
function applyAc(i) {
  const it = acItems[i], ta = $("#ta");
  if (!it || !ta) return;
  ta.value = ta.value.slice(0, acStart) + it.insert + ta.value.slice(ta.selectionStart);
  ta.selectionStart = ta.selectionEnd = acStart + it.insert.length;
  closeAc(); ta.focus();
}
let acDir = null;
async function updateAc() {
  const ta = $("#ta"); if (!ta) return;
  const pos = ta.selectionStart, before = ta.value.slice(0, pos);
  const mSlash = before.match(/(^|\s)\/([\w:-]*)$/), mAt = before.match(/(^|\s)@(\S*)$/);
  if (mSlash) {
    acStart = pos - mSlash[2].length - 1;
    const q = mSlash[2].toLowerCase();
    acItems = S.skills.filter((s) => s.label.toLowerCase().includes(q)).slice(0, 40).map((s) => ({ label: "/" + s.label, desc: String(s.desc || "").slice(0, 80), insert: "/" + s.label + " " }));
    acSel = 0; renderAc();
  } else if (mAt) {
    acStart = pos - mAt[2].length - 1;
    const q = mAt[2].toLowerCase();
    const want = (S.view === "chat" && S.chat && S.chat.path) || S.newPath || S.roots[0] || "";
    if (!acDir || acDir.path !== want) { const r = await getJ("/api/dir?path=" + encodeURIComponent(want)).catch(() => ({ error: 1 })); acDir = r.error ? { path: want, entries: [] } : r; }
    acItems = acDir.entries.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 40).map((e) => ({ label: (e.dir ? "▸ " : "") + e.name, desc: e.dir ? "folder" : fmtB(e.size), insert: "@" + (acDir.path + "/" + e.name).replace(/\/+/g, "/") + " " }));
    acSel = 0; renderAc();
  } else closeAc();
}

/* ─────────────────────────── menus ─────────────────────────── */
let menuEl = null;
function closeMenu() { if (menuEl) menuEl.remove(); menuEl = null; }
const chk = '<span class="chk">' + ic("check", 2.4) + "</span>";
function openMenu(kind, anchor) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu"; m._k = kind;
  const mi = (attrs, inner, sel) => '<button class="mi ' + (sel ? "sel" : "") + '" ' + attrs + ">" + inner + (sel !== undefined ? chk : "") + "</button>";
  const lb = (b, s) => '<span class="l"><b>' + esc(b) + "</b>" + (s ? "<span>" + esc(s) + "</span>" : "") + "</span>";
  if (kind === "mode") {
    const modes = Object.keys(MODES).filter((k) => !S.boot || S.boot.permissionModes.includes(k));
    m.innerHTML = '<div class="menu-h">How much freedom?</div>' + modes.map((k) => mi('data-set="perm:' + k + '"', '<span class="mode-dot" style="background:' + MODES[k].c + ';margin-top:6px"></span>' + lb(MODES[k].label, MODES[k].help), S.perm === k)).join("");
  } else if (kind === "model") {
    const models = [""].concat((S.boot && S.boot.models) || ["opus", "sonnet", "haiku"]);
    const prov = curProvider(), qwenOk = providerOn("qwen");
    const top = ((S.boot && S.boot.providers) || []).length > 1 ? '<div class="menu-h">Provider</div><div class="seg"><button class="' + (prov === "claude" ? "on" : "") + '" data-set="provider:claude">Claude</button>' +
      '<button class="' + (prov === "qwen" ? "on" : "") + '" data-set="provider:qwen"' + (qwenOk ? "" : ' disabled title="Qwen is not set up on this server"') + ">Qwen" + (qwenOk ? "" : " · off") + "</button></div><hr>" : "";
    if (prov === "qwen") m.innerHTML = top + '<div class="menu-h" style="text-transform:none;letter-spacing:0;font-weight:400;padding-bottom:8px">Qwen on your RunPod endpoint. Private and flat-cost, slower: a turn takes about a minute, longer when the GPU is cold.</div>';
    else m.innerHTML = top + '<div class="menu-h">Model</div>' + models.map((k) => mi('data-set="model:' + k + '"', lb((MODELS[k] || [k])[0], (MODELS[k] || ["", ""])[1]), !S.ultra && S.model === k)).join("") +
      '<hr><div class="menu-h">Thinking effort</div><div class="seg">' + ((S.boot && S.boot.efforts) || Object.keys(EFFORTS)).map((e) => '<button class="' + (!S.ultra && S.effort === e ? "on" : "") + '" data-set="effort:' + e + '">' + esc(EFFORTS[e] || e) + "</button>").join("") + "</div>" +
      "<hr>" + mi('data-set="ultra:' + (S.ultra ? "" : "1") + '"', '<span style="color:var(--think)">' + ic("spark") + "</span>" + lb("God mode", "Max effort plus a team of agents. Slowest, most thorough, most expensive"), S.ultra);
  } else if (kind === "agent") {
    const list = S.agents.filter((a) => S.agentQMenu ? (a.name + " " + a.description).toLowerCase().includes(S.agentQMenu) : true);
    m.innerHTML = '<div class="menu-h">Who should do this?</div>' +
      mi('data-set="agent:auto"', ava("auto") + lb("Auto", "Bridge picks the right teammate for each message"), S.agent === "auto") +
      mi('data-set="agent:"', ava("none") + lb("Claude Code", "Plain Claude Code with your instructions and hooks"), S.agent === "") +
      '<hr><div class="scroll">' + list.map((a) => mi('data-set="agent:' + esc(a.name) + '"', ava(a.name) + lb(a.name, agentLook(a.name).role), S.agent === a.name)).join("") + "</div>" +
      '<hr><button class="mi" data-go="agents">' + ic("agents") + lb("See the whole team") + "</button>";
  } else if (kind === "proj") {
    const cloud = S.computer === "cloud";
    const projs = S.home.projects.filter((p) => (p.computer || "mac") === S.computer && p.path !== homeFor(S.computer)).slice(0, 14);
    const roots = cloud ? [] : S.roots.filter((r) => !projs.some((p) => p.path === r));
    const ci = cloudInfo();
    m.innerHTML = '<div class="menu-h">Work in</div><div class="scroll">' +
      mi('data-set="proj:"', ic("home") + lb("Any project", (cloud ? "Starts in the cloud computer's home folder" : "Starts in your home folder") + "; name a project in the message"), !S.newPath) +
      projs.map((p) => mi('data-set="proj:' + esc(p.path) + '"', projIco(p.name, 20) + lb(p.name, short(p.path, 44)), S.newPath === p.path)).join("") +
      roots.map((r) => mi('data-set="proj:' + esc(r) + '"', ic("folder") + lb(base(r), short(r, 44)), S.newPath === r)).join("") + "</div>" +
      (cloud ? "" : '<hr><button class="mi" data-act="choosefolder">' + ic("plus") + lb("Choose another folder…", document.documentElement.dataset.native ? "Opens a Finder picker" : "Type a path") + "</button>") +
      (ci.configured ? '<hr><div class="menu-h">Run on</div><div class="seg"><button class="' + (cloud ? "" : "on") + '" data-set="computer:mac">' + esc(userName()) + "'s Mac</button>" +
      '<button class="' + (cloud ? "on" : "") + '" data-set="computer:cloud"' + (cloudOn() ? "" : ' title="The cloud computer is offline"') + ">Cloud computer" + (cloudOn() ? "" : " · offline") + "</button></div>" +
      '<div class="menu-h" style="text-transform:none;letter-spacing:0;font-weight:400">' + (cloud ? "Keeps running when your Mac sleeps or is closed." : "Uses your local tools and simulators.") + "</div>" : "");
  } else if (kind === "plus") {
    m.innerHTML = mi('data-act="attach"', ic("clip") + lb("Add photos & files", "Drop, paste or pick") + "<kbd>⌘U</kbd>") +
      mi('data-act="mention"', ic("at") + lb("Mention a file", "Point at something in the project") + "<kbd>@</kbd>") +
      mi('data-act="skill"', ic("spark") + lb("Use a skill", S.skills.slice(0, 3).map((s) => s.label).join(", ") + "…") + "<kbd>/</kbd>") +
      mi('data-act="instructions"', ic("book") + lb("Project instructions", "View or edit CLAUDE.md"));
  } else if (kind === "me") {
    m.innerHTML = '<div class="menu-h">' + esc(Auth.email || userName()) + "</div>" +
      mi('data-act="settings"', ic("gear") + lb("Settings")) + mi('data-act="signin"', ic("shield") + lb("Claude account", authed() ? S.auth.email || "Signed in" : "Not signed in")) +
      (Auth.required ? "<hr>" + mi('data-act="signout"', ic("x") + lb("Sign out of Bridge")) : "");
  } else if (kind === "chatmenu") {
    const c = S.chat, busy = c && chatBusy(c);
    m.innerHTML = mi('data-act="rename"', ic("edit") + lb("Rename")) +
      mi('data-act="rawtranscript"', ic("term") + lb("Open raw transcript")) +
      mi('data-act="copyid"', ic("copy") + lb("Copy session id")) +
      (c && c.computer !== "cloud" ? mi('data-act="revealfolder"', ic("folder") + lb("Open the folder", c ? short(c.path, 40) : "")) : "") +
      (c && c.id && c.computer !== "cloud" && !busy && cloudInfo().configured ? mi('data-act="movecloud"', ic("cloud") + lb("Move to cloud computer", cloudOn() ? "Continues there; keeps running with your Mac closed" : "The cloud computer is offline")) : "") +
      mi('data-act="tech"', ic("term") + lb(S.tech ? "Hide technical details" : "Show technical details", "Raw tool calls next to each step")) +
      (busy ? "<hr>" + mi('data-act="stop"', '<span style="color:var(--err)">' + ic("stop") + "</span>" + lb("Stop all running work")) : "");
  }
  document.body.appendChild(m); menuEl = m;
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  let x = Math.min(r.left, innerWidth - mw - 10), y = r.bottom + 6;
  if (y + mh > innerHeight - 10) y = r.top - mh - 6;
  m.style.left = Math.max(10, x) + "px"; m.style.top = Math.max(10, y) + "px";
}
function setChoice(k, v) {
  if (k === "perm") { S.perm = v; ls("bridgePerm", v); }
  else if (k === "model") { S.model = v; S.ultra = false; ls("bridgeModel", v); ls("bridgeUltra", ""); }
  else if (k === "effort") { S.effort = v; S.ultra = false; ls("bridgeEffort", v); ls("bridgeUltra", ""); }
  else if (k === "ultra") { S.ultra = !!v; ls("bridgeUltra", v ? "1" : ""); if (v) toast("God mode on: every message runs as a team of agents"); }
  else if (k === "agent") { S.agent = v; ls("bridgeAgent", v); }
  else if (k === "provider") {
    if (v === "qwen" && !providerOn("qwen")) return toast("Qwen is not set up on this server");
    S.provider = v; ls("bridgeProvider", v);
    // a chat keeps its own provider; switching in it moves its next turn
    if (S.view === "chat" && S.chat && !chatBusy(S.chat)) S.chat.provider = v;
  }
  else if (k === "proj") { S.newPath = v; ls(S.computer === "cloud" ? "bridgeCwdCloud" : "bridgeCwd", v); acDir = null; }
  else if (k === "computer") {
    if (v === "cloud" && !cloudInfo().configured) { closeMenu(); S.setTab = "computers"; openSettings(); return; }
    if (v === "cloud" && !cloudOn()) { toast("The cloud computer is offline right now"); return; }
    S.computer = v; ls("bridgeComputer", v);
    S.newPath = (v === "cloud" ? ls("bridgeCwdCloud") : ls("bridgeCwd")) || ""; acDir = null;
    if (S.chat && !S.chat.id && !S.chat.msgs.length) { S.chat.computer = v; S.chat.path = S.newPath || homeFor(v); S.chat.key = projKey(S.chat.path); }
  }
}

/* ─────────────────────────── chats ─────────────────────────── */
function newChat(path, computer) {
  computer = computer || S.computer;
  return { id: null, tmp: "n" + Date.now(), computer, provider: S.provider, key: path ? projKey(path) : "", path: path || homeFor(computer) || homeDir(), title: "", named: false, msgs: [], usage: null, model: "", branch: "",
    streaming: false, running: false, follow: null, offset: 0, queue: [], jobs: null, step: "", agent: "", lastResult: null, turnStart: 0, workOpen: {}, detOpen: {} };
}
const curProvider = () => (S.view === "chat" && S.chat && (S.chat.id || S.chat.msgs.length) ? S.chat.provider || "claude" : S.provider);
const chatBusy = (c) => !!(c && (c.streaming || c.running));
function chatTitle(c) {
  if (c.title) return c.title;
  const u = c.msgs.find((m) => m.kind === "user");
  return u ? u.text.replace(/\s+/g, " ").slice(0, 60) : "New chat";
}
function startNewChat(path, agent) {
  if (path !== undefined && path !== S.newPath) setChoice("proj", path);
  S.chat = newChat(path !== undefined ? path : S.newPath);
  if (agent !== undefined) { S.agent = agent; ls("bridgeAgent", agent); }
  go("chat");
  setTimeout(() => { const ta = $("#ta"); if (ta) ta.focus(); }, 30);
}
/** open a chat from anywhere: the sidebar, the inbox, a card. A running chat re-attaches. */
async function openChat(key, id, opts) {
  opts = opts || {};
  let c = S.chats.get(id);
  if (!c) {
    const hit = S.recent.find((s) => s.id === id) || S.home.needs.find((n) => n.id === id) || S.home.running.find((r) => r.id === id) || {};
    c = newChat(hit.projectPath || hit.cwd || "", opts.computer || hit.computer || "mac");
    c.provider = hit.provider || "claude";
    Object.assign(c, { id, key, live: id, title: hit.title || "", tmp: null });
    S.chats.set(id, c);
  }
  S.chat = c;
  if (opts.panel !== undefined) S.panel = opts.panel;
  go("chat");
  if (!c.loaded && !c.streaming) await loadChat(c);
  pollJobs(true);
}
async function loadChat(c) {
  c.loading = true;
  let r;
  try { r = await getJ("/api/session?key=" + encodeURIComponent(c.key) + "&id=" + c.id + cq(c.computer)); } catch (e) { r = { error: String(e) }; }
  c.loading = false;
  if (r.error) { c.msgs = [{ kind: "assistant", text: "Could not open this chat: " + r.error, ts: Date.now() }]; paintChat(c); return; }
  c.msgs = r.events || []; c.usage = r.meta.usage; c.model = r.meta.model; c.branch = r.meta.branch; c.hookCount = r.meta.hookCount || 0;
  if (r.meta.cwd && (!c.path || c.path === homeFor(c.computer))) c.path = r.meta.cwd;
  if (r.meta.title) { c.title = r.meta.title; c.named = !!r.meta.named; }
  if (r.meta.provider) c.provider = r.meta.provider;
  c.offset = r.offset || 0; c.loaded = true;
  const run = S.home.running.find((x) => x.id === c.id) || (S.recent.find((s) => s.id === c.id) || {}).running;
  if (run) attach(c);
  if (S.chat === c) { renderChatView(); renderTop(); bindView(); scrollMsgs(true); }
}
/** a turn this page did not start (or started before a reload) is followed from its transcript */
function attach(c) {
  if (c.streaming || c.follow) return;
  c.running = true;
  if (!c.turnStart) { const r = S.home.running.find((x) => x.id === c.id); c.turnStart = r ? r.started : Date.now(); }
  const es = new EventSource("/api/follow?key=" + encodeURIComponent(c.key) + "&id=" + c.id + "&from=" + (c.offset | 0) + cq(c.computer));
  c.follow = es;
  es.onmessage = (e) => {
    let p; try { p = JSON.parse(e.data); } catch (err) { return; }
    if (p.t === "gone") return detach(c);
    if (p.t !== "events") return;
    c.offset = p.offset;
    let first = c.msgs.length;
    for (const ev of p.events) c.msgs.push(ev);
    for (const pt of p.patches || []) for (let i = c.msgs.length - 1; i >= 0; i--) {
      const m = c.msgs[i];
      if (m.kind === "tool" && m.id === pt.id) { m.result = pt.result; first = Math.min(first, i); break; }
    }
    if (p.model) c.model = p.model;
    if (p.events.length || (p.patches || []).length) flush(c, first);
  };
  es.onerror = () => { /* EventSource reconnects by itself */ };
}
function detach(c) { if (c.follow) { try { c.follow.close(); } catch (e) {} c.follow = null; } }
/** while a chat runs, ask the server what it is doing; when it stops, settle the page */
let jobsT = null;
async function pollJobs(now) {
  clearTimeout(jobsT);
  const c = S.view === "chat" ? S.chat : null;
  if (c && c.id && (chatBusy(c) || now)) {
    let j = null;
    try { j = await getJ("/api/jobs?key=" + encodeURIComponent(c.key) + "&id=" + c.id + cq(c.computer)); } catch (e) {}
    if (j) {
      c.jobs = j.running ? j : null;
      if (j.running) {
        c.step = j.step; c.turnStart = j.started || c.turnStart;
        if (!c.streaming && !c.follow && c.loaded) attach(c);
      } else if (c.running && !c.streaming) {
        // give the follower a moment to read the last lines, then call it done
        setTimeout(() => { detach(c); c.running = false; c.msgs.forEach((m) => (m.live = false)); flush(c, 0); refreshComposerBar(); refreshHome(); refreshRecent(); drain(c); }, 1400);
      }
      if (S.chat === c) paintTray(c);
    }
  }
  jobsT = setTimeout(pollJobs, c && chatBusy(c) ? 3000 : 8000);
}

/* ── turning a transcript into turns ─────────────────────────────── */
function turnsOf(msgs) {
  const out = [];
  let cur = null;
  msgs.forEach((m, i) => {
    if (m.kind === "status") return;
    if (m.kind === "user") { cur = { user: m, ui: i, items: [], from: i }; out.push(cur); }
    else { if (!cur) { cur = { user: null, items: [], from: i }; out.push(cur); } cur.items.push(Object.assign({ i }, m)); }
  });
  return out;
}
function workSummary(tools) {
  const n = (f) => tools.filter(f).length;
  const read = n((t) => t.name === "Read"), cmd = n((t) => t.name === "Bash"), ed = new Set(tools.filter((t) => /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(t.name)).map((t) => t.input && (t.input.file_path || t.input.notebook_path))).size;
  const web = n((t) => /^Web/.test(t.name)), help = n((t) => t.name === "Task" || t.name === "Agent"), find = n((t) => t.name === "Grep" || t.name === "Glob");
  const parts = [];
  if (read) parts.push("read " + read + (read === 1 ? " file" : " files"));
  if (ed) parts.push("changed " + ed + (ed === 1 ? " file" : " files"));
  if (cmd) parts.push("ran " + cmd + (cmd === 1 ? " command" : " commands"));
  if (find) parts.push(find + (find === 1 ? " search" : " searches"));
  if (web) parts.push(web + " web " + (web === 1 ? "lookup" : "lookups"));
  if (help) parts.push(help + (help === 1 ? " helper" : " helpers"));
  if (!parts.length) parts.push(tools.length + (tools.length === 1 ? " step" : " steps"));
  return parts.slice(0, 3).join(", ");
}
function renderTurn(c, t, ti, isLast) {
  const live = isLast && chatBusy(c);
  let h = "";
  if (t.user) {
    const at = (t.user.attachments || []).filter((a) => !a.error);
    h += '<div class="u-msg ' + (t.user.queued ? "queued" : "") + '">' + (t.user.queued ? '<span class="qtag">queued</span>' : "") +
      '<div class="b prose">' + md(t.user.text) + (at.length ? '<div class="atts">' + at.map((a) => '<span class="att"><span class="ft" style="background:' + extColor(extOf(a.name)) + '">' + esc(extOf(a.name).toUpperCase().slice(0, 4) || "FILE") + "</span>" + esc(a.name) + "</span>").join("") + "</div>" : "") + "</div></div>";
  }
  const items = t.items;
  if (!items.length && !live) return h;
  const agentName = (t.user && t.user.routedTo) || c.agent || "";
  const look = agentName ? agentLook(agentName) : { name: daName(), init: daName()[0], color: "linear-gradient(135deg,var(--accent),var(--think))" };
  let lastTool = -1;
  items.forEach((m, k) => { if (m.kind === "tool" && !m.side) lastTool = k; });
  const work = items.slice(0, lastTool + 1).filter((m) => m.kind === "tool" || (m.kind === "thinking" && m.text.trim()) || m.kind === "agent_text" || m.kind === "assistant");
  const answer = items.slice(lastTool + 1).filter((m) => m.kind === "assistant" || m.kind === "plan" || (m.kind === "agent_text" && lastTool < 0));
  const sideTail = items.slice(lastTool + 1).filter((m) => m.kind === "tool" && m.side);
  const tools = items.filter((m) => m.kind === "tool" && !m.side);
  h += '<div class="a-msg">' + '<span class="ava" style="background:' + look.color + '">' + esc(look.init) + '</span><div class="a-body">' +
    '<div class="a-name">' + esc(look.name) + qwenTag(t.user && t.user.provider === "qwen" || items.some((m) => /qwen/i.test(m.model || "")) ? "qwen" : "") + (agentName && t.user && t.user.routedTo ? '<span class="tag acc" title="Auto picked this teammate">auto</span>' : "") + '<span class="faint" style="font-weight:400">' + fmtTime(t.user ? t.user.ts : items[0] && items[0].ts) + "</span></div>";
  // the work block: one line per step, collapsed once the turn is done
  const steps = work.concat(sideTail);
  if (steps.length || (live && !answer.length)) {
    const startTs = tms(t.user ? t.user.ts : items[0] && items[0].ts) || c.turnStart;
    const endTs = Math.max.apply(null, [startTs].concat(items.map((m) => tms(m.ts) || 0)).concat(items.filter((m) => m.result && m.result.ts).map((m) => tms(m.result.ts))));
    const pendingTool = live && [...tools].reverse().find((m) => !m.result);
    const open = c.workOpen[ti] !== undefined ? c.workOpen[ti] : live;
    const label = live
      ? "Working · " + esc(pendingTool ? stepText(pendingTool.name, pendingTool.input, false) : c.step || "thinking") + ' · <span class="mono" data-since="' + (c.turnStart || startTs) + '">' + fmtEl(Date.now() - (c.turnStart || startTs)) + "</span>"
      : "Worked for " + fmtEl(Math.max(1000, endTs - startTs)) + " · " + workSummary(tools);
    h += '<div class="work ' + (open ? "open" : "") + '" data-ti="' + ti + '"><button class="work-h" data-act="work">' +
      (live ? '<span class="spin"></span>' : '<span style="color:var(--ok)">' + ic("check", 2.4) + "</span>") + "<span>" + label + "</span>" + ic("chev") + "</button>" +
      '<div class="work-b">' + (open ? steps.map((m) => stepRow(c, m, live)).join("") : "") + "</div></div>";
  }
  // background work started in this turn and not back yet
  if (live) {
    const pend = tools.filter((m) => !m.result && (m.name === "Task" || m.name === "Agent" || m.name === "Workflow"));
    if (pend.length) h += jobCard({ kind: pend[0].name === "Workflow" ? "workflow" : "subagent", title: pend.length > 1 ? pend.length + " helpers working in parallel" : stepText(pend[0].name, pend[0].input, false), since: tms(pend[0].ts), subs: pend.filter((m) => m.name !== "Workflow").map((m) => m.input && m.input.subagent_type || "helper") });
  }
  for (const m of answer) {
    if (m.kind === "plan") { h += planCard(m); continue; }
    const x = m.live ? { body: m.text, choices: [] } : extractChoices(m.text);
    h += '<div class="prose' + (m.live ? " cursor" : "") + '">' + md(x.body) + "</div>";
    if (x.choices.length && isLast && !live) h += '<div class="ask"><div class="q">' + ic("hand") + "<span>" + esc(questionOf(x.body)) + '</span></div><div class="opts">' +
      x.choices.map((o, i) => '<button class="opt" data-choice="' + esc(o) + '"><span class="n">' + (i + 1) + "</span><span><b>" + esc(o) + "</b></span></button>").join("") + "</div></div>";
  }
  if (live && !answer.length && !steps.length) h += '<p class="cursor muted">' + esc(c.step || "Thinking") + "</p>";
  // what the turn made, as cards you can open
  const made = [];
  for (const m of tools) {
    const p = m.input && (m.input.file_path || m.input.notebook_path);
    if (p && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(m.name) && !made.some((x) => x.p === p) && !(m.result && m.result.isError)) made.push({ p, n: m.name === "Write" ? "new" : "edited" });
  }
  if (made.length && !live) h += made.slice(0, 4).map((f) => fileCard(f.p, f.n === "new" ? "Created · " + short(f.p.replace(homeDir(), "~"), 48) : "Edited · " + short(f.p.replace(homeDir(), "~"), 48))).join("") +
    (made.length > 4 ? '<button class="btn" data-act="panelfiles">' + (made.length - 4) + " more files</button>" : "");
  if (isLast && !live && c.lastResult) h += '<div class="cost"><span>' + esc(String(c.model || "").replace("claude-", "")) + "</span><span>$" + (c.lastResult.total_cost_usd || 0).toFixed(2) + "</span><span>" + fmtEl(c.lastResult.duration_ms || 0) + "</span></div>";
  h += "</div></div>";
  return h;
}
function stepRow(c, m, live) {
  if (m.kind === "assistant" || m.kind === "agent_text") return '<div class="narr prose">' + md(m.text) + "</div>";
  if (m.kind === "thinking") return '<div class="think">' + esc(m.text.slice(0, 1200)) + "</div>";
  const pending = !m.result, err = m.result && m.result.isError;
  const icon = pending && live ? '<span class="spin"></span>' : err ? ic("x", 2.2) : ic(TOOL_ICON[m.name] || "zap");
  const open = !!c.detOpen[m.id];
  return '<div class="step ' + (err ? "err" : pending && live ? "" : "ok") + (m.side ? " sub" : "") + '" data-tool="' + esc(m.id) + '">' + icon +
    '<span class="st">' + esc(stepText(m.name, m.input, !pending || !live)) + "</span>" +
    (pending && live && m.ts ? '<span class="el" data-since="' + tms(m.ts) + '">' + fmtEl(Date.now() - tms(m.ts)) + "</span>" : "") +
    '<span class="raw">' + esc(m.name + " " + toolSummary(m.name, m.input)) + "</span></div>" +
    (S.tech && open ? '<div class="tdet open">' + toolBody(m.name, m.input, m.result) + "</div>" : "");
}
function jobCard(j) {
  return '<div class="job"><div class="jh"><span class="spin" style="width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--accent) 25%,transparent);border-top-color:var(--accent);animation:rot .8s linear infinite;flex:none"></span><b>' + esc(j.title) + '</b><span class="el" data-since="' + j.since + '">' + fmtEl(Date.now() - j.since) + "</span></div>" +
    '<div class="bar indet"><i></i></div>' +
    (j.subs && j.subs.length ? '<div class="sub-agents">' + j.subs.map((a) => '<span class="sa">' + ava(a) + esc(a) + ' <span class="typing"><i></i><i></i><i></i></span></span>').join("") + "</div>" : "") +
    '<div class="leave">' + ic("bell") + "Takes a while? Leave this chat or close Bridge. It keeps going and you get a ping when it is done.</div></div>";
}
function fileCard(p, sub) {
  const e = extOf(p);
  return '<button class="fcard" data-file="' + esc(p) + '"><span class="fi" style="background:' + extColor(e) + '">' + esc((e || "file").toUpperCase().slice(0, 4)) + '</span><span class="l"><b>' + esc(base(p)) + "</b><span>" + esc(sub || short(p, 50)) + "</span></span>" + ic("ext") + "</button>";
}
function planCard(m) {
  return '<div class="planc"><div class="ph">' + ic("book") + "Plan" + (m.file ? '<span class="tag think">' + esc(base(m.file)) + "</span>" : "") + '</div><div class="prose">' + md(m.text) + "</div>" +
    (m.decided ? '<div class="decided">' + esc(m.decided) + "</div>" : '<div class="acts"><button class="btn pri" data-plan="approve">' + ic("check", 2.2) + 'Approve and build</button><button class="btn" data-plan="revise">Revise</button></div>') + "</div>";
}

/* ── the chat view ────────────────────────────────────────────── */
function renderChatView() {
  const c = S.chat || (S.chat = newChat(S.newPath));
  const host = $("#viewHost");
  if (!c.id && !c.msgs.length) {
    const projs = S.home.projects.filter((p) => p.path !== homeDir()).slice(0, 5);
    host.innerHTML = '<div class="view"><div class="wrap"><div class="hero" style="padding-top:12vh"><h1 class="big">What should we work on?</h1>' +
      '<p class="brief">Pick a project and a teammate, or just start typing.' + (S.newPath ? " Working in <b>" + esc(projectName(S.newPath)) + "</b>." : "") + "</p>" +
      (authed() ? composer("Describe the task…  Type / for skills, @ for files") : signinCard()) +
      '<div class="suggest">' + projs.map((p) => '<button class="chipx" data-set="proj:' + esc(p.path) + '">' + esc(p.name) + "</button>").join("") + "</div></div></div></div>";
    return;
  }
  host.innerHTML = '<div class="chatgrid ' + (S.panel ? "side-open" : "") + '"><div class="chatcol">' +
    '<div class="msgs view" id="msgs"><div class="wrap" id="turns">' + (c.loading || (!c.loaded && !c.msgs.length) ? '<div class="empty-big"><span class="spin-s" style="display:inline-block"></span></div>' : "") + "</div></div>" +
    '<div class="chat-composer"><div id="tray"></div>' + composer(chatBusy(c) ? "Add to the work, or ask anything meanwhile…" : "Reply…", { chat: true }) + "</div></div>" +
    '<aside class="cpanel" id="cpanel"></aside></div>';
  paintTurns(c, 0);
  paintTray(c);
  paintPanel();
}
/** redraw the turns from the one holding message `from` onward; earlier turns stay as they are */
function paintTurns(c, from) {
  const box = $("#turns");
  if (!box || S.chat !== c) return;
  const ts = turnsOf(c.msgs);
  let ti = 0;
  for (let k = 0; k < ts.length; k++) if (ts[k].from <= from) ti = k;
  const nodes = $$("[data-turn]", box);
  if (nodes.length < ti || !nodes.length) ti = 0;
  if (!ti) box.innerHTML = "";
  else nodes.slice(ti).forEach((n) => n.remove());
  const frag = document.createElement("div");
  frag.innerHTML = ts.slice(ti).map((t, k) => '<div data-turn="' + (ti + k) + '">' + renderTurn(c, t, ti + k, ti + k === ts.length - 1) + "</div>").join("");
  while (frag.firstChild) box.appendChild(frag.firstChild);
  if (!ts.length && !c.loading) box.innerHTML = '<div class="empty-big"><h3>Nothing here yet</h3>Say what you need below.</div>';
}
let flushQ = new Map();
/** coalesce updates to one paint per frame: streaming deltas arrive far faster than that */
function flush(c, from) {
  flushQ.set(c, Math.min(flushQ.has(c) ? flushQ.get(c) : Infinity, from == null ? 0 : from));
  if (flush.raf) return;
  flush.raf = requestAnimationFrame(() => {
    flush.raf = 0;
    for (const [ch, f] of flushQ) {
      if (S.chat !== ch || S.view !== "chat") continue;
      const msgs = $("#msgs");
      const stick = msgs && msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 240;
      paintTurns(ch, f);
      paintTray(ch);
      if (S.panel) paintPanel();
      if (stick) scrollMsgs(true);
    }
    flushQ.clear();
  });
}
function scrollMsgs(force) { const m = $("#msgs"); if (m && (force || m.scrollHeight - m.scrollTop - m.clientHeight < 240)) m.scrollTop = m.scrollHeight; }
/** the tray above the composer: what is still running for this chat, from the server */
function paintTray(c) {
  const box = $("#tray");
  if (!box) return;
  const busy = chatBusy(c);
  const jobs = (c.jobs && c.jobs.jobs) || [];
  const q = c.queue.length;
  let h = "";
  if (busy && jobs.length) {
    const open = !!c.trayOpen;
    h += '<div class="jobs ' + (open ? "open" : "") + '"><button class="jobs-h" data-act="tray"><span class="dot run"></span><b>' + jobs.length + " running in the background</b>" +
      '<span class="el mono faint" style="font-size:12px" data-since="' + Math.min.apply(null, jobs.map((j) => j.since)) + '">' + fmtEl(Date.now() - Math.min.apply(null, jobs.map((j) => j.since))) + "</span>" + ic("chev") + "</button>" +
      '<div class="jobs-b">' + jobs.map((j) => '<div class="job"><div class="jh"><span class="spin-s" style="width:14px;height:14px"></span><b>' + esc(j.title) + '</b><span class="el" data-since="' + j.since + '">' + fmtEl(Date.now() - j.since) + "</span></div>" +
        '<div class="jn">' + esc(j.kind === "subagent" ? "Helper · " + (j.agent || "") : j.kind === "background" ? "In the background" : j.kind === "workflow" ? "Workflow" : "Long-running step") + "</div>" +
        (j.agent ? '<div class="sub-agents"><span class="sa">' + ava(j.agent) + esc(j.agent) + ' <span class="typing"><i></i><i></i><i></i></span></span></div>' : "") + "</div>").join("") + "</div></div>";
  }
  if (busy) h += '<div class="queued"><span class="typing"><i></i><i></i><i></i></span>' + (q ? q + " message" + (q > 1 ? "s" : "") + " queued. They go the moment this turn ends." : "You can keep chatting. New messages go in when the current turn ends.") +
    '<span style="flex:1"></span><span class="mono" data-since="' + (c.turnStart || Date.now()) + '">' + fmtEl(Date.now() - (c.turnStart || Date.now())) + "</span></div>";
  box.innerHTML = h;
}

/* the right panel: Files · Progress · Details */
function chatFiles(c) {
  const out = [];
  for (const m of c.msgs) {
    if (m.kind !== "tool") continue;
    const p = m.input && (m.input.file_path || m.input.notebook_path);
    if (!p) continue;
    const kind = m.name === "Write" ? "new" : /^(Edit|MultiEdit|NotebookEdit)$/.test(m.name) ? "edited" : m.name === "Read" ? "read" : "";
    if (!kind) continue;
    const hit = out.find((x) => x.p === p);
    if (!hit) out.push({ p, kind });
    else if (kind !== "read" && hit.kind === "read") hit.kind = kind;
  }
  return out.sort((a, b) => (a.kind === "read") - (b.kind === "read"));
}
function progressOf(c) {
  const claimed = [];
  for (const m of c.msgs) {
    if (m.kind !== "assistant" || m.live) continue;
    const h = /🎯\s*([^\n]+)/.exec(m.text || "");
    if (h) claimed.push(h[1].replace(/^\**|\**$/g, "").replace(/^[A-Z][A-Z0-9 ]{1,24}\s*[·:\-–—]\s*/, "").trim().slice(0, 110));
  }
  let todos = null;
  for (let i = c.msgs.length - 1; i >= 0; i--) { const m = c.msgs[i]; if (m.kind === "tool" && m.name === "TodoWrite" && m.input && m.input.todos) { todos = m.input.todos; break; } }
  return { claimed, todos };
}
function paintPanel() {
  const box = $("#cpanel");
  if (!box || !S.chat) return;
  const c = S.chat;
  const tabs = [["files", "Files"], ["progress", "Progress"], ["details", "Details"]];
  let body = "";
  if (S.ptab === "files") {
    const fs = chatFiles(c);
    const sel = S.pfile && fs.some((f) => f.p === S.pfile) ? S.pfile : (fs.find((f) => f.kind !== "read") || {}).p;
    body = (sel ? '<div class="preview" id="pprev"><div class="row" style="margin-bottom:10px"><span class="tag">' + esc(extOf(sel).toUpperCase() || "FILE") + '</span><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(base(sel)) + "</b>" +
      '<button class="icon-btn" data-doc="' + esc(sel) + '" data-computer="' + esc(c.computer || "mac") + '" title="Open">' + ic("ext") + '</button></div><div id="pprevBody" class="faint">Loading…</div></div>' : "") +
      '<div class="side-h" style="padding-left:2px">' + (fs.length ? "Touched in this chat · " + fs.length : "Files appear here as the work produces them") + "</div>" +
      fs.map((f) => '<button class="li ' + (f.p === sel ? "cur" : "") + '" style="border:0;padding:7px 4px" data-pfile="' + esc(f.p) + '"><span class="ico" style="background:var(--bg-active);width:26px;height:26px">' + ic(f.kind === "read" ? "read" : f.kind === "new" ? "file" : "edit") + '</span><div class="l"><span style="font-family:var(--mono);font-size:12px;color:var(--fg)">' + esc(short(f.p.replace(homeDir(), "~"), 44)) + '</span></div><span class="tag ' + (f.kind === "new" ? "ok" : f.kind === "edited" ? "acc" : "") + '">' + f.kind + "</span></button>").join("");
    if (sel) setTimeout(() => previewInto(sel, $("#pprevBody")), 0);
  } else if (S.ptab === "progress") {
    const { claimed, todos } = progressOf(c);
    const goal = (c.msgs.find((m) => m.kind === "user") || {}).text || "";
    body = '<div class="side-h" style="padding-left:2px">Goal</div><p style="font-size:13px;padding:0 4px 8px">' + esc(goal.slice(0, 280) || "Not set yet") + "</p>" +
      (todos ? '<div class="side-h" style="padding-left:2px">Checklist</div>' + todos.map((t) => '<div class="todo ' + (t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "") + '"><span class="bx">' + (t.status === "completed" ? ic("check", 3) : "") + '</span><span class="tt">' + esc(t.content || t.activeForm || "") + "</span></div>").join("") : "") +
      (claimed.length ? '<div class="side-h" style="padding-left:2px">Steps achieved</div>' + claimed.slice(-12).map((x) => '<div class="todo done"><span class="bx">' + ic("check", 3) + '</span><span class="tt" style="text-decoration:none;color:var(--fg-muted)">' + esc(x) + "</span></div>").join("") : "") +
      (!todos && !claimed.length ? '<p class="faint" style="font-size:12.5px;padding:4px">Checklists and completed steps land here as the chat moves.</p>' : "");
  } else {
    const u = c.usage || {};
    const tools = c.msgs.filter((m) => m.kind === "tool").length;
    body = '<dl class="kv"><dt>Teammate</dt><dd>' + esc(c.agent || (S.agent === "auto" ? "Auto" : S.agent || "Claude Code")) + "</dd>" +
      "<dt>Model</dt><dd>" + esc(String(c.model || S.model || "default").replace("claude-", "")) + "</dd>" +
      "<dt>Mode</dt><dd>" + esc((MODES[S.perm] || {}).label || S.perm) + "</dd>" +
      "<dt>Folder</dt><dd>" + esc(c.path) + "</dd>" + (c.branch ? "<dt>Branch</dt><dd>" + esc(c.branch) + "</dd>" : "") +
      "<dt>Runs on</dt><dd>" + esc(userName()) + "'s Mac</dd>" +
      "<dt>Tokens</dt><dd>" + fmtN(u.input || 0) + " in · " + fmtN(u.output || 0) + " out · " + fmtN(u.cacheRead || 0) + " cached</dd>" +
      (c.lastResult ? "<dt>Last turn</dt><dd>$" + (c.lastResult.total_cost_usd || 0).toFixed(3) + " · " + fmtEl(c.lastResult.duration_ms || 0) + "</dd>" : "") +
      "<dt>Steps</dt><dd>" + tools + " tool calls" + (c.hookCount ? " · " + c.hookCount + " hooks" : "") + "</dd>" +
      "<dt>Session id</dt><dd>" + esc(c.id || "new") + "</dd></dl>" +
      '<div class="side-h" style="padding-left:0;margin-top:10px">Power tools</div>' +
      '<div class="setting"><div class="l"><b>Show technical details</b><span>Raw tool calls next to each step; click a step for its input and output</span></div><button class="toggle ' + (S.tech ? "on" : "") + '" data-act="tech"></button></div>' +
      '<div class="row mt8" style="flex-wrap:wrap">' + (c.id ? '<button class="btn" data-act="rawtranscript">' + ic("term") + "Open raw transcript</button>" : "") + '<button class="btn" data-act="rename">' + ic("edit") + "Rename</button>" +
      '<button class="btn" data-act="revealfolder">' + ic("folder") + "Open folder</button>" + (chatBusy(c) ? '<button class="btn" data-act="stop" style="color:var(--err)">' + ic("stop") + "Stop</button>" : "") + "</div>";
  }
  box.innerHTML = '<div class="ptabs">' + tabs.map(([id, l]) => '<button class="ptab ' + (S.ptab === id ? "on" : "") + '" data-ptab="' + id + '">' + l + "</button>").join("") +
    '<span style="flex:1"></span><button class="icon-btn" data-act="panel" title="Close">' + ic("x") + '</button></div><div class="pbody">' + body + "</div>";
}
const previewCache = new Map();
async function previewInto(path, el) {
  if (!el) return;
  const comp = (S.chat && S.chat.computer) || "mac", ck = comp + ":" + path;
  let d = previewCache.get(ck);
  if (!d || Date.now() - d.at > 5000) { d = await getJ("/api/file?path=" + encodeURIComponent(path) + cq(comp)).catch((e) => ({ error: String(e) })); d.at = Date.now(); previewCache.set(ck, d); }
  if (d.url) d.url = d.url.replace(/(&computer=cloud)?$/, cq(comp));
  if (!el.isConnected) return;
  if (d.error) { el.innerHTML = '<span class="faint">' + esc(d.error) + "</span>"; return; }
  const e = extOf(path);
  if (d.binary && /png|jpe?g|gif|webp|svg/.test(e)) el.innerHTML = '<img src="' + esc(Auth.withToken(d.url)) + '">';
  else if (d.binary) el.innerHTML = '<button class="btn" data-doc="' + esc(path) + '">Open ' + esc(e.toUpperCase()) + "</button>";
  else if (d.lang === "markdown") el.innerHTML = '<div class="prose">' + md(String(d.text).slice(0, 20000)) + "</div>";
  else if (e === "html") el.innerHTML = '<iframe sandbox="allow-scripts" src="' + esc(Auth.withToken("/api/raw?path=" + encodeURIComponent(path) + cq(comp))) + '" style="width:100%;height:46vh;border:1px solid var(--border);border-radius:8px;background:#fff"></iframe>';
  else el.innerHTML = '<div class="prose"><pre><code>' + esc(String(d.text).slice(0, 12000)) + "</code></pre></div>";
}

/* ─────────────────────────── sending ─────────────────────────── */
async function send() {
  const ta = $("#ta");
  const text = (ta ? ta.value : "").trim();
  const ats = S.attachments.slice();
  if (!text && !ats.length) return;
  if (!authed()) { await refreshAuth(true); if (!authed()) { openSignin("Sign in first. Claude Code has no account on this machine yet."); return; } }
  if (S.view !== "chat" || !S.chat) S.chat = newChat(S.newPath);
  const c = S.chat;
  ta.value = ""; ta.style.height = "auto"; S.drafts[ta.dataset.dk] = "";
  S.attachments = []; renderAttachments();
  const msg = { kind: "user", text, ultra: S.ultra, ts: Date.now(), attachments: ats.map((a) => ({ name: a.name, path: a.path, kind: a.kind, mediaType: a.mediaType, data: a.data, error: a.error })) };
  sendMsg(c, msg);
}
/** the shared path for typed input, clicked options and plan decisions */
function sendText(c, text) { if (c && String(text || "").trim()) sendMsg(c, { kind: "user", text: String(text).trim(), ts: Date.now(), attachments: [] }); }
function sendMsg(c, msg) {
  const wasNew = S.view !== "chat" || (!c.id && !c.msgs.length);
  c.msgs.push(msg);
  if (chatBusy(c)) { msg.queued = true; c.queue.push(msg); flush(c, c.msgs.length - 1); toast("Queued. It goes the moment the current turn ends."); return; }
  if (wasNew) { go("chat"); scrollMsgs(true); }
  runTurn(c, msg);
}
function drain(c) {
  if (chatBusy(c) || !c.queue.length) return;
  const next = c.queue.shift();
  next.queued = false;
  const at = c.msgs.indexOf(next);
  if (at >= 0) { c.msgs.splice(at, 1); c.msgs.push(next); }
  flush(c, Math.max(0, at));
  runTurn(c, next);
}
async function runTurn(c, msg) {
  c.streaming = true; c.turnStart = Date.now(); c.step = "Starting"; c.lastResult = null;
  const planning = S.perm === "plan";
  let planFile = null, blocks = {};
  const body = {
    prompt: (msg.ultra ? "ultracode " : "") + msg.text, cwd: c.path, resume: c.live || c.id || null,
    model: S.model || null, permissionMode: S.perm, effort: msg.ultra ? "max" : S.effort || null,
    agent: S.agent === "auto" ? "auto" : S.agent || null, attachments: msg.attachments || [], computer: c.computer || "mac", provider: c.provider || S.provider,
  };
  msg.provider = body.provider;
  // Qwen runs plain Claude Code on the Qwen model: no Claude agent routing, no Claude model or effort
  if (body.provider === "qwen") { body.agent = null; body.model = null; body.effort = null; }
  // a cloud Bridge routes Auto itself; the hub only routes for this Mac's agents
  if (c.computer === "cloud" && body.agent === "auto") body.agent = null;
  flush(c, c.msgs.length - 1);
  renderSide(); refreshComposerBar();
  if (body.agent === "auto") {
    c.step = "Choosing a teammate";
    let r = { agent: "" };
    try { r = await post("/api/route", { prompt: msg.text, previous: c.agent || "" }); } catch (e) {}
    body.agent = r.agent || null; c.agent = r.agent || ""; msg.routedTo = r.agent || "";
    c.step = r.agent ? "Handing this to " + r.agent : "Thinking";
    flush(c, c.msgs.indexOf(msg));
  }
  const push = (m) => { const i = c.msgs.push(m) - 1; flush(c, i); return i; };
  function onEvent(p) {
    if (p.t === "start") {
      const fresh = !c.id;
      c.live = c.live || p.sessionId; c.id = c.id || p.sessionId; c.key = c.key || projKey(p.cwd || c.path);
      if (p.cwd) c.path = p.cwd;
      S.chats.set(c.id, c);
      if (fresh) { if (S.chat === c) renderTop(); renderSide(); setTimeout(refreshHome, 1500); setTimeout(refreshRecent, 2500); }
      return;
    }
    if (p.t === "auth") { S.auth = p.d || S.auth; openSignin("Claude Code is not signed in, so that message did not run. Sign in and send it again."); return; }
    if (p.t === "stderr") { const line = String(p.d).trim(); if (line && !/hook|deprecat|warning/i.test(line)) push({ kind: "assistant", text: "```\n" + line + "\n```", ts: Date.now() }); return; }
    if (p.t === "ping" || p.t === "end" || p.t === "error" || p.t === "raw") return;
    const d = p.d;
    if (!d || !d.type) return;
    if (d.type === "system" && d.subtype === "init") { c.live = d.session_id || c.live; c.model = d.model || c.model; c.step = "Thinking"; return; }
    if (d.type === "system" && d.subtype === "hook_started") { c.step = "Running " + (d.hook_name || "a hook"); return; }
    if (d.type === "stream_event") {
      const ev = d.event, side = !!d.parent_tool_use_id;
      if (!ev) return;
      if (ev.type === "message_start") { blocks = {}; return; }
      if (ev.type === "content_block_start") {
        const cb = ev.content_block || {};
        if (cb.type === "text") blocks[ev.index] = push({ kind: side ? "agent_text" : "assistant", text: "", ts: Date.now(), live: true, model: c.model });
        else if (cb.type === "thinking") blocks[ev.index] = push({ kind: "thinking", text: "", ts: Date.now(), live: true, side });
      } else if (ev.type === "content_block_delta") {
        const idx = blocks[ev.index]; if (idx === undefined) return;
        const m = c.msgs[idx];
        if (ev.delta.type === "text_delta") m.text += ev.delta.text;
        else if (ev.delta.type === "thinking_delta") m.text += ev.delta.thinking;
        else return;
        flush(c, idx);
      } else if (ev.type === "content_block_stop") {
        const idx = blocks[ev.index];
        if (idx !== undefined) { c.msgs[idx].live = false; flush(c, idx); }
      }
      return;
    }
    if (d.type === "assistant") {
      const side = !!d.parent_tool_use_id, streamed = Object.keys(blocks).length > 0;
      ((d.message && d.message.content) || []).forEach((x) => {
        if (x.type === "tool_use") {
          if (x.name === "Write" && x.input && /\/Plans\/[^/]+\.md$/.test(String(x.input.file_path || ""))) planFile = x.input.file_path;
          c.step = stepText(x.name, x.input, false);
          push({ kind: "tool", name: x.name, input: x.input, id: x.id, ts: Date.now(), side, result: null });
        } else if (x.type === "text" && !streamed && x.text && x.text.trim()) push({ kind: side ? "agent_text" : "assistant", text: x.text, ts: Date.now(), model: d.message.model });
      });
      c.usage = accUsage(c.usage, d.message && d.message.usage);
      return;
    }
    if (d.type === "user") {
      ((d.message && d.message.content) || []).forEach((x) => {
        if (x.type !== "tool_result") return;
        for (let i = c.msgs.length - 1; i >= 0; i--) {
          const m = c.msgs[i];
          if (m.kind === "tool" && m.id === x.tool_use_id) {
            m.result = { content: typeof x.content === "string" ? x.content : (x.content || []).map((z) => z.text || "[" + z.type + "]").join("\n"), isError: !!x.is_error, ts: Date.now() };
            flush(c, i); break;
          }
        }
      });
      return;
    }
    if (d.type === "result") {
      c.lastResult = { total_cost_usd: d.total_cost_usd, duration_ms: d.duration_ms, turns: d.num_turns, error: !!d.is_error };
      // `claude -p` stays alive past its result while background work reports back; the turn is over when the process closes
      c.step = "Wrapping up";
    }
  }
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const rd = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const chunk = await rd.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        if (raw.indexOf("data: ") !== 0) continue;
        let p; try { p = JSON.parse(raw.slice(6)); } catch (e) { continue; }
        onEvent(p);
      }
    }
  } catch (e) {
    // the connection dropped, not the turn: the server keeps running it, so follow the transcript instead
    if (c.id) { c.streaming = false; c.running = true; flush(c, 0); const r = await getJ("/api/session?key=" + encodeURIComponent(c.key) + "&id=" + c.id + cq(c.computer)).catch(() => null); if (r && !r.error) { c.msgs = r.events; c.offset = r.offset; } attach(c); return; }
    push({ kind: "assistant", text: "**Bridge error:** " + String(e), ts: Date.now() });
  }
  c.streaming = false;
  c.msgs.forEach((m) => (m.live = false));
  if (planning) {
    const last = c.msgs.filter((m) => m.kind === "assistant").pop();
    const planText = last && /^#{1,4}\s*\**Plan/m.test(last.text) ? last.text.slice(last.text.search(/^#{1,4}\s*\**Plan/m)) : null;
    if (planText || planFile) c.msgs.push({ kind: "plan", text: planText || "Plan written to `" + planFile + "`.", file: planFile, ts: Date.now() });
  }
  flush(c, 0);
  refreshComposerBar(); renderSide();
  announceTurn(c);
  refreshHome(); setTimeout(refreshRecent, 800);
  drain(c);
}
function accUsage(u, x) {
  if (!x) return u;
  u = u || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return { input: u.input + (x.input_tokens || 0), output: u.output + (x.output_tokens || 0), cacheRead: u.cacheRead + (x.cache_read_input_tokens || 0), cacheWrite: u.cacheWrite + (x.cache_creation_input_tokens || 0) };
}
/** the stop button and placeholder follow the chat's state without redrawing the text box */
function refreshComposerBar() {
  if (S.view !== "chat" || !S.chat) return;
  const comp = $("#composer"); if (!comp) return;
  const ta = $("#ta"), val = ta ? ta.value : "", focused = document.activeElement === ta;
  const box = document.createElement("div");
  box.innerHTML = composer(chatBusy(S.chat) ? "Add to the work, or ask anything meanwhile…" : "Reply…", { chat: true });
  comp.querySelector(".cbar").replaceWith(box.querySelector(".cbar"));
  if (ta) ta.placeholder = box.querySelector("textarea").placeholder;
  if (ta && focused) ta.focus();
  if (ta) ta.value = val;
  paintTray(S.chat);
}
async function refreshComputers() {
  try { const c = await getJ("/api/computers"); if (!Array.isArray(c)) return; S.computers = c; } catch (e) { return; }
  if (S.computer === "cloud" && !cloudInfo().configured) { S.computer = "mac"; ls("bridgeComputer", "mac"); S.newPath = ls("bridgeCwd") || ""; }
}
/** copy a Mac chat to the cloud computer and continue it there */
async function moveChatToCloud(c) {
  if (!c || !c.id) return;
  if (!cloudOn()) return toast("The cloud computer is offline right now");
  toast("Moving to the cloud computer…");
  const r = await post("/api/move", { key: c.key, id: c.id }).catch((e) => ({ error: String(e) }));
  if (r.error) return toastCard({ kind: "error", title: "Could not move this chat", detail: r.error });
  S.chats.delete(c.id);
  Object.assign(c, { computer: "cloud", key: r.key, path: r.cwd, loaded: false, offset: 0 });
  S.chats.set(c.id, c);
  await loadChat(c);
  refreshHome(); refreshRecent();
  toast("Now on the cloud computer");
}
function stopChat(c) {
  if (!c) return;
  post("/api/abort", { sessionId: c.live || c.id, computer: c.computer });
  c.queue.forEach((m) => (m.queued = false)); c.queue = [];
  toast("Stopped");
  setTimeout(() => { if (!c.streaming) { c.running = false; detach(c); flush(c, 0); refreshComposerBar(); } refreshHome(); }, 1200);
}
/** a turn this page ran just ended: tell the principal unless they are looking at it */
const watching = (id) => document.hasFocus() && S.view === "chat" && S.chat && S.chat.id === id;
function announceTurn(c) {
  S.announced.add(c.id);
  setTimeout(() => S.announced.delete(c.id), 15000);
  if (watching(c.id)) return;
  const ok = c.lastResult && !c.lastResult.error;
  const last = c.msgs.filter((m) => m.kind === "assistant").pop();
  const text = last ? String(last.text || "").replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim() : "";
  const asks = ok && /\?\s*$/.test(text);
  toastCard({ kind: asks ? "waiting" : ok ? "done" : "error", title: chatTitle(c), detail: text, onOpen: () => openChat(c.key, c.id) });
  if (ls("bridgeNotify") === "0") return;
  if (window.Voice && Voice.say) Voice.say((asks ? "Your " + projectName(c.path) + " chat needs you. " : ok ? "Your " + projectName(c.path) + " chat finished. " : "Your " + projectName(c.path) + " chat stopped with an error. ") + ((text.match(/[^.!?]+[.!?]/) || [text.slice(0, 160)])[0] || ""));
  if (!document.hasFocus()) post("/api/notify", { title: projectName(c.path) + (asks ? " needs you" : ok ? " finished" : " failed"), subtitle: chatTitle(c), body: text.slice(0, 200) }).catch(() => {});
}
/** an event from the server (via the Copilot stream): a chat somewhere else finished or needs you */
function onServerEvent(e) {
  if (!e || !e.kind) return;
  if (e.kind === "started") { refreshHome(); return; }
  refreshHome(); setTimeout(refreshRecent, 600);
  const c = S.chats.get(e.id);
  if (c && !c.streaming && c.running) pollJobs(true);
  if (S.announced.has(e.id) || watching(e.id)) return;
  toastCard({ kind: e.kind, title: (e.computer === "cloud" ? "☁ " : "") + e.title, detail: e.text, onOpen: () => openChat(e.key, e.id, { computer: e.computer }) });
}

/* ─────────────────────────── data ─────────────────────────── */
async function refreshHome() {
  // a refusal (401, an error) is not a Home: keep what is on screen
  try { const h = await getJ("/api/home"); if (!h || !Array.isArray(h.running)) return; S.home = h; S.homeAt = Date.now(); } catch (e) { return; }
  // a chat open in this page that the server says is running, but nothing here follows it yet
  for (const r of S.home.running) { const c = S.chats.get(r.id); if (c && c.loaded && !c.streaming && !c.follow) attach(c); }
  renderSide();
  if (S.view === "home" || S.view === "inbox") softRender();
}
async function refreshRecent() {
  try { const r = await getJ("/api/recent?limit=120"); if (!Array.isArray(r)) return; S.recent = r; } catch (e) { return; }
  renderSide();
  if (S.view === "inbox") softRender();
}
async function refreshAuth(fresh) { try { S.auth = await getJ("/api/auth" + (fresh ? "?fresh=1" : "")); } catch (e) {} return S.auth; }
/** redraw a list view without losing focus or scroll, and only when nobody is typing in it */
function softRender() {
  const ae = document.activeElement;
  if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT") && ae.value) return;
  const v = $(".view"), top = v ? v.scrollTop : 0;
  render();
  const v2 = $(".view"); if (v2) v2.scrollTop = top;
}

/* ─────────────────────────── toasts ─────────────────────────── */
function toast(text) {
  const t = document.createElement("div");
  t.className = "tc";
  t.innerHTML = '<span style="color:var(--accent);flex:none">' + ic("check") + "</span><span>" + esc(text) + "</span>";
  $("#toasts").appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, 2600);
}
const TOAST_LIFE = { waiting: 16000, error: 10000, done: 8000 };
function toastCard(x) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "tc";
  const col = x.kind === "waiting" ? "var(--warn)" : x.kind === "error" ? "var(--err)" : "var(--ok)";
  el.innerHTML = '<span style="color:' + col + ';flex:none">' + ic(x.kind === "waiting" ? "hand" : x.kind === "error" ? "x" : "check", 2.2) + "</span>" +
    '<div class="tb"><div class="tt">' + esc(x.title || "Bridge") + '</div><div class="td">' + esc(x.kind === "waiting" ? "Needs you: " : x.kind === "error" ? "Stopped with an error. " : "Finished. ") + esc(String(x.detail || "").slice(0, 200)) + "</div></div>" +
    '<button class="icon-btn" data-x title="Dismiss">' + ic("x") + "</button>";
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 260); };
  let timer = setTimeout(kill, TOAST_LIFE[x.kind] || 6000);
  el.onmouseenter = () => clearTimeout(timer);
  el.onmouseleave = () => { timer = setTimeout(kill, 3000); };
  el.onclick = (e) => { kill(); if (!e.target.closest("[data-x]") && x.onOpen) x.onOpen(); };
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
}

/* ────────────────────────── interactions ────────────────────────── */
function bindView() {
  const ta = $("#ta");
  if (ta) {
    const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; };
    fit();
    ta.addEventListener("input", () => { fit(); updateAc(); });
    ta.addEventListener("keydown", (e) => {
      if (acItems.length) {
        if (e.key === "ArrowDown") { acSel = Math.min(acSel + 1, acItems.length - 1); renderAc(); return e.preventDefault(); }
        if (e.key === "ArrowUp") { acSel = Math.max(acSel - 1, 0); renderAc(); return e.preventDefault(); }
        if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) { applyAc(acSel); return e.preventDefault(); }
        if (e.key === "Escape") { closeAc(); return e.preventDefault(); }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    ta.addEventListener("paste", (e) => { const files = Array.from(e.clipboardData.files || []); if (files.length) { e.preventDefault(); addFiles(files); } });
    const comp = $("#composer");
    comp.addEventListener("dragover", (e) => { e.preventDefault(); comp.classList.add("drag"); });
    comp.addEventListener("dragleave", () => comp.classList.remove("drag"));
    comp.addEventListener("drop", (e) => {
      e.preventDefault(); comp.classList.remove("drag");
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) addFiles(files);
      else { const p = (e.dataTransfer.getData("text/plain") || "").trim(); if (p && !p.includes("\n")) getJ("/api/file?path=" + encodeURIComponent(p)).then((d) => { if (!d.error) addAttachment({ name: base(d.path), path: d.path, ext: extOf(d.path) }); }); }
    });
    renderAttachments();
  }
  const v = $(".view");
  if (v) v.addEventListener("scroll", () => { $("#light").style.transform = "translateY(" + -v.scrollTop * 0.18 + "px)"; }, { passive: true });
  else $("#light").style.transform = "";
  if (S.view === "chat") scrollMsgs(true);
  if (window.VIEW_BIND) window.VIEW_BIND();
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act],[data-go],[data-open],[data-proj],[data-menu],[data-set],[data-suggest],[data-choice],[data-plan],[data-ptab],[data-pfile],[data-file],[data-doc],[data-tool],[data-copy],[data-rmatt],[data-aci],[data-newin],[data-assign],[data-ask],[data-filter]");
  if (menuEl && !e.target.closest(".menu") && !e.target.closest("[data-menu]")) closeMenu();
  if (!t) return;
  const d = t.dataset;
  if (d.go) { closeOverlays(); go(d.go); }
  else if (d.open) { closeOverlays(); const [key, id, computer] = d.open.split("|"); openChat(key, id, { computer }); }
  else if (d.proj) go("project", d.proj);
  else if (d.menu) { if (menuEl && menuEl._k === d.menu) closeMenu(); else openMenu(d.menu, t); }
  else if (d.set) { const k = d.set.slice(0, d.set.indexOf(":")), v = d.set.slice(d.set.indexOf(":") + 1); setChoice(k, v); closeMenu(); if (S.view === "chat" && S.chat && (S.chat.id || S.chat.msgs.length)) refreshComposerBar(); else render(); const ta = $("#ta"); if (ta) ta.focus(); }
  else if (d.suggest) { const ta = $("#ta"); if (ta) { ta.value = d.suggest; ta.focus(); ta.dispatchEvent(new Event("input")); } }
  else if (d.ask) { if (window.Voice) Voice.ask(d.ask); }
  else if (d.choice) { if (S.chat) sendText(S.chat, d.choice); }
  else if (d.plan) {
    const c = S.chat, m = c && c.msgs.filter((x) => x.kind === "plan").pop();
    if (!m) return;
    if (d.plan === "approve") { m.decided = "Approved. Building with edits on."; setChoice("perm", "acceptEdits"); flush(c, 0); refreshComposerBar(); sendText(c, "Approved. Implement the plan" + (m.file ? " in " + m.file : " above") + " exactly as written, then report what changed."); }
    else { m.decided = "Revising"; flush(c, 0); const ta = $("#ta"); if (ta) { ta.placeholder = "What should change in the plan?"; ta.focus(); } }
  }
  else if (d.ptab) { S.ptab = d.ptab; paintPanel(); }
  else if (d.pfile) { S.pfile = d.pfile; paintPanel(); }
  else if (d.file) { S.pfile = d.file; S.ptab = "files"; if (S.view === "chat" && innerWidth > 900) { S.panel = true; render(); } else openDoc(d.file, null, { computer: S.chat && S.chat.computer }); }
  else if (d.doc) openDoc(d.doc, null, { computer: d.computer || (S.view === "chat" && S.chat ? S.chat.computer : "mac") });
  else if (d.tool !== undefined) { if (!S.tech || !S.chat) return; S.chat.detOpen[d.tool] = !S.chat.detOpen[d.tool]; flush(S.chat, 0); }
  else if (d.copy !== undefined) { navigator.clipboard.writeText(t.parentElement.innerText.replace(/^copy\n?/, "")); toast("Copied"); }
  else if (d.rmatt !== undefined) { S.attachments.splice(+d.rmatt, 1); renderAttachments(); }
  else if (d.aci !== undefined) applyAc(+d.aci);
  else if (d.newin !== undefined) { if (d.newcomp && d.newcomp !== S.computer) setChoice("computer", d.newcomp); startNewChat(d.newin); }
  else if (d.assign !== undefined) startNewChat(S.newPath, d.assign);
  else if (d.act) act(d.act, t, e);
});
document.addEventListener("dblclick", (e) => { if (e.target.closest(".top .title .t")) beginRename(); });
function act(a, t, e) {
  if (a === "collapse") { $("#app").classList.toggle("collapsed"); renderTop(); }
  else if (a === "mnav") $("#app").classList.toggle("mnav");
  else if (a === "new") startNewChat();
  else if (a === "palette") openPalette();
  else if (a === "theme") toggleTheme();
  else if (a === "settings") openSettings();
  else if (a === "panel") { S.panel = !S.panel; render(); }
  else if (a === "panelfiles") { S.panel = true; S.ptab = "files"; render(); }
  else if (a === "work") {
    const w = t.closest(".work"), ti = +w.dataset.ti, c = S.chat;
    const open = !w.classList.contains("open");
    if (c) { c.workOpen[ti] = open; paintTurns(c, (turnsOf(c.msgs)[ti] || {}).from || 0); }
  }
  else if (a === "tray") { if (S.chat) { S.chat.trayOpen = !S.chat.trayOpen; paintTray(S.chat); } }
  else if (a === "tech") { S.tech = !S.tech; ls("bridgeTech", S.tech ? "1" : "0"); document.body.classList.toggle("tech", S.tech); if (S.view === "chat") render(); if ($("#modal").classList.contains("on")) openSettings(); }
  else if (a === "voice") { if (window.Voice) Voice.open(); }
  else if (a === "dictate") { if (window.Voice) Voice.dictate($("#ta"), t); }
  else if (a === "send") send();
  else if (a === "stop") stopChat(S.chat);
  else if (a === "close") closeOverlays();
  else if (a === "rename") beginRename();
  else if (a === "rawtranscript") { const c = S.chat; if (c && c.id) openDoc((c.computer === "cloud" ? homeFor("cloud") + "/.claude" : S.boot.claudeDir) + "/projects/" + c.key + "/" + c.id + ".jsonl", "Raw transcript", { computer: c.computer }); }
  else if (a === "movecloud") moveChatToCloud(S.chat);
  else if (a === "copyid") { if (S.chat && S.chat.id) { navigator.clipboard.writeText(S.chat.id); toast("Session id copied"); } }
  else if (a === "revealfolder") { const p = (S.chat && S.chat.path) || (S.proj && S.proj.path); if (p) post("/api/open", { path: p }).then((r) => r.error && toast(r.error)); }
  else if (a === "attach") { closeMenu(); $("#fileInput").click(); }
  else if (a === "mention" || a === "skill") { closeMenu(); const ta = $("#ta"); if (ta) { ta.value += (ta.value && !/\s$/.test(ta.value) ? " " : "") + (a === "skill" ? "/" : "@"); ta.focus(); ta.selectionStart = ta.value.length; updateAc(); } }
  else if (a === "instructions") { closeMenu(); const p = (S.view === "chat" && S.chat && S.chat.path) || S.newPath || homeDir(); openDoc(p === homeDir() ? S.boot.claudeDir + "/CLAUDE.md" : p + "/CLAUDE.md", "Instructions", { create: true }); }
  else if (a === "choosefolder") { closeMenu(); chooseFolder(); }
  else if (a === "cloud") { closeMenu(); toast("The cloud computer runs its own Bridge. Open it from Settings › Computers."); }
  else if (a === "signin") { closeMenu(); openSignin(); }
  else if (a === "signout") { closeMenu(); Auth.signOut(); }
}
function beginRename() {
  const c = S.chat;
  if (!c || !c.id) return;
  const el = $(".top .title .t");
  if (!el) return;
  const inp = document.createElement("input");
  inp.className = "ren"; inp.value = chatTitle(c);
  el.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    if (save && inp.value.trim() !== chatTitle(c)) {
      const r = await post("/api/rename", { id: c.id, title: inp.value, computer: c.computer });
      if (r.ok) { c.title = r.title || ""; c.named = !!r.title; toast(r.title ? "Renamed" : "Name cleared"); refreshRecent(); }
    }
    renderTop();
  };
  inp.onkeydown = (e) => { if (e.key === "Enter") commit(true); else if (e.key === "Escape") commit(false); };
  inp.onblur = () => commit(true);
}
function chooseFolder() {
  const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickFolder;
  if (wk) { wk.postMessage(S.newPath || ""); return; }
  const v = prompt("Folder Claude Code should work in:", S.newPath || S.roots[0] || "");
  if (v && v.trim()) useFolder(v.trim());
}
window.bridgeFolderPicked = (p) => useFolder(p);
/** make sure Bridge may read the folder, then start new chats there */
async function useFolder(path) {
  path = String(path || "").replace(/\/+$/, "");
  if (!path) return;
  if (!S.roots.some((r) => path === r || path.indexOf(r + "/") === 0)) await setRoots(S.roots.concat([path]));
  setChoice("proj", path);
  if (S.chat && !S.chat.id && !S.chat.msgs.length) { S.chat.path = path; S.chat.key = projKey(path); }
  render();
  toast("Working in " + projectName(path));
}
async function setRoots(roots) {
  S.roots = await post("/api/roots", { roots });
  S.dir = null;
  toast("Folders updated");
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  ls("bridgeTheme", next);
  renderSide();
  if ($("#modal").classList.contains("on")) openSettings();
}
function closeOverlays() {
  $("#scrim").classList.remove("on"); $("#palette").classList.remove("on"); $("#modal").classList.remove("on");
}
$("#scrim").addEventListener("click", closeOverlays);
// a tap outside the phone sidebar closes it
document.addEventListener("click", (e) => { const app = $("#app"); if (app.classList.contains("mnav") && !e.target.closest(".side") && !e.target.closest('[data-act="mnav"]')) { app.classList.remove("mnav"); e.stopPropagation(); } }, true);
$("#fileInput").addEventListener("change", (e) => { const fi = e.target; if (fi.files.length) addFiles(Array.from(fi.files)); fi.value = ""; });
document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key === "k") { e.preventDefault(); openPalette(); }
  else if (meta && e.key === "t") { e.preventDefault(); startNewChat(); }
  else if (meta && e.key === "f") { e.preventDefault(); openFinder(); }
  else if (meta && e.key === "j") { e.preventDefault(); toggleTheme(); }
  else if (meta && e.key === "i" && S.view === "chat") { e.preventDefault(); act("panel"); }
  else if (meta && e.key === "u" && $("#ta")) { e.preventDefault(); $("#fileInput").click(); }
  else if (meta && e.key === "s" && S.view === "doc" && S.doc && S.doc.editing) { e.preventDefault(); saveDoc(); }
  else if (e.key === "Escape") {
    if (window.Voice && Voice.isOpen()) { Voice.escape(); return; }
    if ($("#signinBg").classList.contains("on")) return closeSignin();
    if ($("#finder").classList.contains("on")) return closeFinder();
    if (menuEl) return closeMenu();
    if ($("#palette").classList.contains("on") || $("#modal").classList.contains("on")) return closeOverlays();
    if (S.view === "doc") return closeDoc();
  }
});
/* elapsed timers tick in place; nothing re-renders for them */
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll("[data-since]").forEach((el) => { el.textContent = fmtEl(now - +el.dataset.since); });
}, 1000);

/* ─────────────────────────── boot ─────────────────────────── */
async function boot() {
  document.body.classList.toggle("tech", S.tech);
  // paint as soon as Bridge knows who it is; chats, home and configs land as they arrive (a busy machine or a slow cloud never holds the page blank)
  const [rq, aq, cq2, oq, hq] = ["/api/recent?limit=120", "/api/agents", "/api/configs", "/api/roots", "/api/home"].map((u) => getJ(u).catch(() => null));
  let b = await getJ("/api/bootstrap").catch(() => null);
  if (b && (b.error || !Array.isArray(b.models))) b = null;
  Object.assign(S, { boot: b || { models: [], permissionModes: Object.keys(MODES), efforts: Object.keys(EFFORTS), home: "" }, auth: (b && b.auth) || { loggedIn: false } });
  if (!S.boot.permissionModes.includes(S.perm)) S.perm = "acceptEdits";
  const later = (p, apply) => p.then((v) => { if (v && !v.error) { apply(v); renderSide(); if (S.view !== "chat") softRender(); } });
  // anything that is not the expected shape (an HTML error page, a 401 body) is ignored rather than trusted
  later(rq, (v) => Array.isArray(v) && (S.recent = v));
  later(hq, (v) => v && Array.isArray(v.running) && (S.home = v));
  later(oq, (v) => Array.isArray(v) && (S.roots = v));
  later(cq2, (v) => { if (!Array.isArray(v)) return; S.configs = v; S.skills = v.filter((c) => c.group === "Skills"); });
  later(aq, (v) => {
    if (!Array.isArray(v)) return; S.agents = v; if (S.agent && S.agent !== "auto" && !v.some((a) => a.name === S.agent)) S.agent = "auto"; });
  const q = new URLSearchParams(location.search);
  if (q.get("v")) S.view = q.get("v");
  refreshComputers();
  render();
  window._bridgeBooted();
  if (!authed()) openSignin();
  setInterval(refreshHome, 5000);
  setInterval(refreshRecent, 30000);
  setInterval(refreshComputers, 20000);
  pollJobs();
  if (q.get("c")) { const [key, id] = q.get("c").split("|"); openChat(key, id); }
  getJ("/api/lifeos").then((l) => (S.lifeos = l)).catch(() => {});
}
