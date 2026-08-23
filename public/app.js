/* ══════════════════════════ Bridge client ══════════════════════════ */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const fmtAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
};
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n | 0));
const fmtB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");
const short = (p, n = 46) => (String(p).length > n ? "…" + String(p).slice(-n + 1) : String(p));

const S = {
  view: "chat", boot: null, recent: [], agents: [], skills: [], configs: [],
  cwd: "", roots: [], dir: null, acDir: null, filter: "", inspector: false,
  tabs: [], active: 0,      // session tabs, across the top
  page: {},                 // the open detail page, per view
  notes: [],                // sessions that finished or failed while you were elsewhere
  group: "Core",            // which Configs group the cards are showing
  agentCat: "All",          // which area of expertise the Agents pills are showing
  tree: {}, sel: "", preview: true, // Directory listings + selection; md editor preview pane
};
/** the active session tab */
const T = () => S.tabs[S.active] || null;

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

/* ───────────────────────── tool rendering ─────────────────────── */
const TOOL_ICON = {
  Bash: "$", Read: "▤", Write: "✎", Edit: "✎", Glob: "❋", Grep: "⌕", WebFetch: "◍", WebSearch: "⌕",
  Task: "◇", Agent: "◇", TodoWrite: "☑", NotebookEdit: "▦", Artifact: "◈", Skill: "✦", Workflow: "⛓",
};
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
    default: return Object.entries(inp).slice(0, 2).map(([k, v]) => k + "=" + String(v).slice(0, 40)).join(" ");
  }
}
function diffHtml(oldS, newS) {
  const a = String(oldS).split("\n"), b = String(newS).split("\n");
  return '<div class="pre">' +
    a.map((l) => '<span class="diff-l del">- ' + esc(l) + "</span>").join("") +
    b.map((l) => '<span class="diff-l add">+ ' + esc(l) + "</span>").join("") + "</div>";
}
function toolBody(name, inp, res) {
  inp = inp || {};
  let h = "";
  if (name === "Edit" && inp.old_string !== undefined)
    h += '<div class="tool-sec"><div class="tool-lab">' + esc(short(inp.file_path || "", 70)) + "</div>" + diffHtml(inp.old_string, inp.new_string) + "</div>";
  else if (name === "Write")
    h += '<div class="tool-sec"><div class="tool-lab">writes ' + esc(short(inp.file_path || "", 70)) + '</div><div class="pre">' + esc(String(inp.content || "").slice(0, 6000)) + "</div></div>";
  else if (name === "Bash")
    h += '<div class="tool-sec"><div class="tool-lab">command</div><div class="pre">' + esc(inp.command || "") + "</div></div>";
  else if (name === "TodoWrite")
    h += '<div class="tool-sec">' + (inp.todos || []).map((t) =>
      '<div style="font-size:12.5px;padding:2px 0">' + (t.status === "completed" ? "✔" : t.status === "in_progress" ? "◐" : "○") + " " + esc(t.content || t.activeForm || "") + "</div>").join("") + "</div>";
  else if (Object.keys(inp).length)
    h += '<div class="tool-sec"><div class="tool-lab">input</div><div class="pre">' + esc(JSON.stringify(inp, null, 2).slice(0, 4000)) + "</div></div>";
  if (res) {
    const txt = String(res.content == null ? "" : res.content);
    h += '<div class="tool-sec"><div class="tool-lab">' + (res.isError ? "error" : "result") + (txt.length > 4000 ? " · truncated" : "") +
      '</div><div class="pre">' + (esc(txt.slice(0, 4000)) || "<em>(empty)</em>") + "</div></div>";
  }
  return h || '<div class="tool-sec"><div class="pre plain" style="color:var(--fg-faint)">running…</div></div>';
}

/* ───────────────────────── message render ─────────────────────── */
const PHASES = ["OBSERVE", "THINK", "PLAN", "BUILD", "EXECUTE", "VERIFY", "LEARN"];
function renderMsg(m) {
  const name = (S.boot && S.boot.assistant) || "Claude";
  if (m.kind === "user")
    return '<div class="msg user' + (m.queued ? " queued" : "") + '"><div class="av u">' + esc(((S.boot && S.boot.user) || "You").slice(0, 1).toUpperCase()) + "</div>" +
      '<div class="msg-body"><div class="msg-name">You <span class="ts">' + fmtTime(m.ts) + "</span>" +
      (m.queued ? '<span class="tag">queued</span>' : "") + "</div>" +
      '<div class="bubble prose">' + md(m.text) + "</div></div></div>";
  if (m.kind === "assistant" || m.kind === "agent_text") {
    const side = m.kind === "agent_text";
    return '<div class="msg"><div class="av a">' + (side ? "◇" : esc(name.slice(0, 1).toUpperCase())) + "</div>" +
      '<div class="msg-body ' + (side ? "sidechain" : "") + '"><div class="msg-name">' + (side ? "subagent" : esc(name)) +
      (m.model ? ' <span class="tag">' + esc(String(m.model).replace("claude-", "")) + "</span>" : "") +
      '<span class="ts">' + fmtTime(m.ts) + "</span></div>" +
      '<div class="prose">' + md(m.text) + (m.live ? '<span class="typing"></span>' : "") + "</div></div></div>";
  }
  if (m.kind === "thinking")
    return '<div class="think ' + (m.open ? "open" : "") + '" data-think><div class="think-h">✦ thinking' +
      '<span style="color:var(--fg-faint);font-weight:400">' + (m.text.length > 60 ? " · " + fmtN(m.text.length) + " chars" : "") + "</span></div>" +
      '<div class="think-b">' + esc(m.text) + (m.live ? '<span class="typing"></span>' : "") + "</div></div>";
  if (m.kind === "tool") {
    const ok = m.result && !m.result.isError, bad = m.result && m.result.isError;
    return '<div class="tool ' + (m.open ? "open" : "") + " " + (m.side ? "sidechain" : "") + '" data-tool>' +
      '<div class="tool-h"><svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>' +
      '<span class="tool-ic">' + (TOOL_ICON[m.name] || "◆") + '</span><span class="tool-n">' + esc(m.name) + "</span>" +
      '<span class="tool-a">' + esc(toolSummary(m.name, m.input)) + "</span>" +
      (bad ? '<span class="tool-badge err">error</span>' : ok ? '<span class="tool-badge ok">done</span>' : '<span class="tool-badge"><span class="spin"></span></span>') +
      '</div><div class="tool-c">' + toolBody(m.name, m.input, m.result) + "</div></div>";
  }
  return "";
}
function renderStream() {
  const t = T();
  const box = $("#streamInner");
  box.innerHTML = (t && t.msgs.length ? t.msgs.map(renderMsg).join("") : "") || startScreen(t);
  box.querySelectorAll("[data-tool] .tool-h").forEach((h) => (h.onclick = () => h.parentElement.classList.toggle("open")));
  box.querySelectorAll("[data-think] .think-h").forEach((h) => (h.onclick = () => h.parentElement.classList.toggle("open")));
  box.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => {
    navigator.clipboard.writeText(b.parentElement.innerText.replace(/^copy\n?/, "")); toast("Copied");
  }));
  wireStart(box);
  renderPhases();
}
function startScreen(t) {
  const recents = S.recent.slice(0, 6);
  return '<div class="start"><div class="wordmark">BRIDGE</div>' +
    '<p class="start-sub">Working in <code>' + esc((t && t.path) || (S.boot && S.boot.home) || "") +
    "</code> · the real <code>claude</code> CLI, with your hooks, skills and PAI context intact.</p>" +
    '<button class="start-search" data-find><span>⌕</span><span>Search everything you have ever run…</span><kbd>⌘F</kbd></button>' +
    (recents.length ? '<div class="start-recent"><div class="section-h">Recent sessions</div>' +
      recents.map((s, i) => '<div class="start-row" data-recent="' + i + '"><span class="sr-t">' + esc(s.title) + "</span>" +
        '<span class="sr-m">' + esc(s.projectName) + " · " + fmtAgo(s.mtime) + "</span></div>").join("") + "</div>" : "") +
    "</div>";
}
function wireStart(box) {
  const fb = box.querySelector("[data-find]");
  if (fb) fb.onclick = () => openFinder("");
  box.querySelectorAll("[data-recent]").forEach((n) => (n.onclick = () => {
    const s = S.recent[+n.dataset.recent];
    openSessionIn(s.project, s.id, s.projectPath, s.title);
  }));
}
function scrollDown(force) {
  const s = $("#stream");
  if (force || s.scrollHeight - s.scrollTop - s.clientHeight < 220) s.scrollTop = s.scrollHeight;
}
function renderPhases() {
  if (S.view !== "chat") { $("#phaseStrip").innerHTML = ""; return; }
  const t = T();
  const text = t ? t.msgs.filter((m) => m.kind === "assistant").map((m) => m.text).join("\n") : "";
  const seen = PHASES.filter((p) => new RegExp("\\b" + p + "\\b").test(text));
  $("#phaseStrip").innerHTML = seen.length
    ? PHASES.map((p) => '<span class="ph ' + (seen.indexOf(p) >= 0 ? (p === seen[seen.length - 1] ? "on" : "done") : "") + '">' + p.slice(0, 3) + "</span>").join("")
    : "";
}

/* ────────────────────── session tabs (top bar) ─────────────────── */
function makeTab(opts) {
  const path = (opts && opts.path) || (T() && T().path) || S.cwd || S.roots[0] || (S.boot && S.boot.home);
  const t = Object.assign({
    id: null, key: null, path: path, name: String(path).split("/").pop() || "~",
    title: "New session", msgs: [], usage: null, model: "", branch: "",
    live: null, streaming: false, lastResult: null,
  }, opts || {});
  S.tabs.push(t);
  S.active = S.tabs.length - 1;
  return t;
}
function closeTab(i) {
  const t = S.tabs[i];
  if (t && t.streaming) abortTab(t);
  S.tabs.splice(i, 1);
  if (!S.tabs.length) makeTab();
  else if (S.active >= S.tabs.length) S.active = S.tabs.length - 1;
  else if (S.active > i) S.active--;
  paint();
}
function activate(i) { S.active = i; paint(); scrollDown(true); }
function tabTitle(t) {
  if (t.title && t.title !== "New session") return t.title;
  const first = t.msgs.filter((m) => m.kind === "user")[0];
  return first ? first.text.slice(0, 40) : "New session";
}
function renderTabs() {
  $("#tabs").innerHTML = S.tabs.map((t, i) =>
    '<div class="tab ' + (i === S.active ? "on" : "") + '" data-tab="' + i + '" title="' + esc(t.path || "") + '">' +
    (t.streaming ? '<span class="tab-live"></span>' : "") +
    '<span class="tab-t">' + esc(tabTitle(t)) + '</span><span class="tab-x" data-close="' + i + '">×</span></div>').join("");
  $("#tabs").querySelectorAll("[data-tab]").forEach((n) => (n.onclick = (e) => {
    if (e.target.dataset.close !== undefined) { e.stopPropagation(); closeTab(+e.target.dataset.close); return; }
    activate(+n.dataset.tab);
  }));
  const at = $("#tabs .tab.on");
  if (at) at.scrollIntoView({ block: "nearest", inline: "nearest" });
}
const unread = () => S.notes.filter((x) => !x.read).length;
function saveNotes() { try { localStorage.bridgeNotes = JSON.stringify(S.notes.slice(0, 60)); } catch (e) {} }
function loadNotes() { try { S.notes = JSON.parse(localStorage.bridgeNotes || "[]"); } catch (e) { S.notes = []; } }
function note(tab, kind, detail) {
  S.notes.unshift({
    id: tab.id || tab.live, key: tab.key, path: tab.path,
    title: tabTitle(tab), kind: kind, detail: detail || "", ts: Date.now(), read: false,
  });
  S.notes = S.notes.slice(0, 60);
  saveNotes();
  renderBell();
}
function renderBell() {
  const n = unread();
  const b = $("#bellCount");
  b.hidden = !n; b.textContent = n;
  $("#btnBell").classList.toggle("acc", !!n);
  if ($("#notes").classList.contains("on")) renderNotes();
}
function toggleNotes(force) {
  const el = $("#notes");
  const on = force === undefined ? !el.classList.contains("on") : force;
  el.classList.toggle("on", on);
  if (on) renderNotes();
}
function renderNotes() {
  const box = $("#notesList");
  box.innerHTML =
    (S.notes.length ? S.notes.map((x, i) =>
      '<div class="note ' + (x.read ? "" : "unread") + '" data-note="' + i + '">' +
      '<span class="note-dot ' + x.kind + '"></span>' +
      '<div style="flex:1;min-width:0"><div class="note-t">' + esc(x.title) + "</div>" +
      '<div class="note-m">' + (x.kind === "error" ? "failed" : "finished") + (x.detail ? " · " + esc(x.detail) : "") +
      " · " + esc(String(x.path || "").split("/").pop() || "") + " · " + fmtAgo(x.ts) + "</div></div>" +
      '<span class="note-go">open →</span></div>').join("")
      : '<div style="padding:22px 16px;color:var(--fg-faint);font-size:12.5px;text-align:center">Nothing waiting on you. Anything that finishes while you are elsewhere lands here and stays until you clear it.</div>');
  box.querySelectorAll("[data-note]").forEach((n) => (n.onclick = () => {
    const x = S.notes[+n.dataset.note];
    x.read = true; saveNotes(); renderBell();
    if (x.id) openSessionIn(x.key, x.id, x.path, x.title);
  }));
}
function toggleRecents(force) {
  const el = $("#recents");
  const on = force === undefined ? !el.classList.contains("on") : force;
  el.classList.toggle("on", on);
  if (on) { $("#recentsSearch").value = ""; fillRecents(""); $("#recentsSearch").focus(); }
}
function fillRecents(q) {
  const ql = q.toLowerCase();
  const list = S.recent.filter((s) => (s.title + " " + s.preview + " " + s.projectName).toLowerCase().indexOf(ql) >= 0).slice(0, 60);
  $("#recentsList").innerHTML =
    '<div class="item" data-findall><div class="item-row"><span>⌕</span><span class="item-t">Search every session…</span><span class="tag">⌘F</span></div></div>' +
    (list.map((s, i) => '<div class="item" data-open="' + i + '">' +
      '<div class="item-t">' + esc(s.title) + "</div>" +
      '<div class="item-s">' + esc(s.projectName) + " · " + fmtAgo(s.mtime) + " · " + fmtB(s.size) +
      (s.model ? " · " + esc(s.model.replace("claude-", "")) : "") + "</div></div>").join("") ||
      '<div style="padding:16px;color:var(--fg-faint);font-size:13px">No sessions match.</div>');
  const fa = $("#recentsList").querySelector("[data-findall]");
  if (fa) fa.onclick = () => { toggleRecents(false); openFinder($("#recentsSearch").value); };
  $("#recentsList").querySelectorAll("[data-open]").forEach((n) => (n.onclick = () => {
    const s = list[+n.dataset.open];
    toggleRecents(false);
    openSessionIn(s.project, s.id, s.projectPath, s.title);
  }));
}
async function openSessionIn(key, id, path, title) {
  clearInterval(actTimer); actTimer = null;
  const existing = S.tabs.map((t) => t.id).indexOf(id);
  if (existing >= 0) return activate(existing);
  const t = makeTab({ id: id, live: id, title: title || "Session", key: key, path: path || S.cwd });
  t.name = String(t.path).split("/").pop();
  S.view = "chat";
  paint();
  const r = await (await fetch("/api/session?key=" + encodeURIComponent(key) + "&id=" + id)).json();
  t.msgs = r.events || []; t.usage = r.meta.usage; t.model = r.meta.model; t.branch = r.meta.branch;
  if (r.meta.title) t.title = r.meta.title;
  paint(); scrollDown(true);
}
/** ask for the folder this session should run in */
function pickCwd() {
  const dirs = S.roots.concat(S.recent.map((r) => r.projectPath).filter(Boolean));
  const uniq = dirs.filter((d, i) => d && dirs.indexOf(d) === i).slice(0, 12);
  const pick = prompt(
    "Working directory — the folder Claude Code runs in for this session.\n" +
    "Everything it reads, writes and runs happens there.\n\n" +
    uniq.map((d, i) => (i + 1) + ". " + d).join("\n") +
    "\n\nType a number, or paste a path:", (T() && T().path) || "");
  if (!pick) return;
  const n = parseInt(pick, 10);
  setCwd(n >= 1 && n <= uniq.length ? uniq[n - 1] : pick.trim());
}

/** point the current session at a directory */
function setCwd(path) {
  S.cwd = path;
  localStorage.bridgeCwd = path;
  const t = T();
  if (t && !t.msgs.length && !t.id) { t.path = path; t.name = path.split("/").pop(); }
  else makeTab({ path: path });
  goChat();
}

/* ───────────────────────────── views ──────────────────────────── */
const GROUPS = ["Core", "Memory", "Skills"];
const RAIL = [
  { id: "chat", label: "Work sessions", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  { id: "activity", label: "Activity", icon: "M3 12h4l3 8 4-16 3 8h4" },
  { id: "agents", label: "Agents", icon: "M12 2a5 5 0 0 1 5 5v2a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" },
  { id: "files", label: "Directory", icon: "M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
  { id: "configs", label: "Configs", icon: "M6 2h9l5 5v15H6zM15 2v5h5M9 12h7M9 16h7" },
];
const railOn = (id) => S.view === id;
function renderRail() {
  $("#rail").innerHTML = '<button class="logo" id="railHome" title="Back to the conversation"><span>B</span></button>' + RAIL.map((r) =>
    '<button class="rail-btn ' + (railOn(r.id) ? "on" : "") + '" data-view="' + r.id + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="' + r.icon + '"/></svg>' +
    '<span class="tip">' + r.label + "</span></button>").join("") +
    '<div class="rail-spacer"></div>' +
    '<button class="rail-btn" id="railTheme"><span class="theme-ic" id="themeIc"></span><span class="tip">Theme (⌘J)</span></button>';
  $("#rail").querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => go(b.dataset.view)));
  $("#railHome").onclick = goChat;
  $("#railTheme").onclick = toggleTheme;
}

/* the second tab strip: group / browse tabs, then whatever files are open */
function agentCats() {
  const seen = [];
  S.agents.forEach((x) => { if (seen.indexOf(x.category) < 0) seen.push(x.category); });
  const count = (c) => S.agents.filter((x) => x.category === c).length;
  return seen.sort((x, y) => count(y) - count(x) || x.localeCompare(y));
}
const PAGE = () => S.page[S.view] || null;

function renderMain() {
  const isChat = S.view === "chat";
  const open = PAGE();
  $("#streamInner").classList.toggle("wide", !isChat);
  $("#streamInner").classList.toggle("editing", !!(open && open.editing));
  $("#composerWrap").style.display = isChat ? "" : "none";
  $("#tabbar").style.display = isChat ? "" : "none";
  const box = $("#streamInner");
  if (isChat) { renderStream(); return; }
  if (open) return renderDoc(box, open);
  if (S.view === "activity") return renderActivity(box);
  if (S.view === "files") return renderBrowser(box);
  return renderCards(box, S.view === "agents" ? "Agents" : S.group);
}

/* ── configs / agents: cards under group tabs ─────────────────────── */
function renderCards(box, group) {
  const q = S.filter;
  // a search looks everywhere: it ignores the pill you happen to be standing on
  const scope = group === "Agents" ? ["Agents"] : GROUPS;
  const all = S.configs.filter((c) => (q ? scope.indexOf(c.group) >= 0 : c.group === group));
  const shown = all.filter((c) => !q || (c.label + " " + (c.desc || "") + " " + (c.sub || "")).toLowerCase().indexOf(q) >= 0);
  const icon = group === "Agents" ? "◇" : group === "Skills" ? "✦" : "▤";
  const card = (c, withSub) => '<div class="gc" data-p="' + esc(c.path) + '" data-t="' + esc(c.label) + '">' +
    '<div class="gc-t">' + icon + " " + esc(c.label) + "</div>" +
    (c.desc ? '<div class="gc-d">' + esc(c.desc) + "</div>" : "") +
    (withSub || c.bytes ? '<div class="gc-m">' + (withSub ? esc(c.sub || "") : "") +
      (c.bytes ? (withSub ? " · " : "") + fmtB(c.bytes) : "") + (c.mtime ? " · " + fmtAgo(c.mtime) : "") + "</div>" : "") +
    "</div>";
  let bodyHtml, list = shown;
  if (group === "Agents") {
    if (S.agentCat !== "All" && !q) list = shown.filter((c) => (c.sub || "General purpose") === S.agentCat);
    if (S.agentCat === "All" || q) {
      const cats = {};
      list.forEach((c) => { (cats[c.sub || "General purpose"] = cats[c.sub || "General purpose"] || []).push(c); });
      bodyHtml = Object.keys(cats).sort((x, y) => cats[y].length - cats[x].length || x.localeCompare(y)).map((k) =>
        '<div class="section"><div class="section-h">' + esc(k) + '<span>' + cats[k].length + "</span></div>" +
        '<div class="grid-cards">' + cats[k].map((c) => card(c, false)).join("") + "</div></div>").join("");
    } else bodyHtml = '<div class="grid-cards">' + list.map((c) => card(c, false)).join("") + "</div>";
  } else if (q) {
    const gs = {};
    shown.forEach((c) => { (gs[c.group] = gs[c.group] || []).push(c); });
    bodyHtml = GROUPS.filter((g) => gs[g]).map((g) =>
      '<div class="section"><div class="section-h">' + g + "<span>" + gs[g].length + "</span></div>" +
      '<div class="grid-cards">' + gs[g].map((c) => card(c, true)).join("") + "</div></div>").join("") ||
      '<div class="item-s" style="padding:12px 2px">Nothing matches “' + esc(q) + '”.</div>';
  } else bodyHtml = '<div class="grid-cards">' + shown.map((c) => card(c, true)).join("") + "</div>";
  const nAgents = (cat) => S.agents.filter((x) => x.category === cat).length;
  const nGroup = (g) => S.configs.filter((x) => x.group === g).length;
  const pills = group === "Agents"
    ? '<div class="pills">' + ["All"].concat(agentCats()).map((cat) =>
      '<button class="pill ' + (S.agentCat === cat ? "on" : "") + '" data-cat="' + esc(cat) + '">' + esc(cat) +
      '<span>' + (cat === "All" ? S.agents.length : nAgents(cat)) + "</span></button>").join("") + "</div>"
    : '<div class="pills">' + GROUPS.map((g) =>
      '<button class="pill ' + (S.group === g ? "on" : "") + '" data-group="' + g + '">' + g +
      "<span>" + nGroup(g) + "</span></button>").join("") + "</div>";
  box.innerHTML = '<div class="doc-view">' +
    '<div class="view-head"><span class="count">' + (q ? "found " : "") + list.length +
    (list.length !== all.length ? " of " + all.length : "") + " " + (group === "Agents" ? "agents" : "files") +
    (q ? ' for “' + esc(q) + '”' : "") + '</span>' +
    "</div>" +
    pills + bodyHtml + "</div>";
  box.querySelectorAll("[data-cat]").forEach((n) => (n.onclick = () => { S.agentCat = n.dataset.cat; paint(); }));
  box.querySelectorAll("[data-group]").forEach((n) => (n.onclick = () => { S.group = n.dataset.group; S.filter = ""; paint(); }));
  box.querySelectorAll(".gc").forEach((n) => (n.onclick = () => openPage(n.dataset.p, n.dataset.t, group === "Agents" ? "Agents" : "Configs")));
}

/* ── directory: folder tree on the left, folder contents in the body ── */
const fmtWhen = (ms) => new Date(ms).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
async function loadDir(path) {
  if (S.tree[path]) return S.tree[path];
  const d = await (await fetch("/api/dir?path=" + encodeURIComponent(path))).json();
  if (d.error) { toast(d.error); return null; }
  if (d.roots) S.roots = d.roots;
  S.tree[path] = d;
  return d;
}
async function selectDir(path) {
  const d = await loadDir(path);
  if (!d) return;
  S.sel = path;
  S.dir = d;
  paint();
  requestAnimationFrame(() => { $("#stream").scrollTop = 0; });
}
function renderPanel() {
  const show = S.view === "files" && !PAGE();   // an open file gets the full width
  $("#panel").hidden = !show;
  if (!show) return;
  $("#panelTitle").textContent = "Folders";
  // the top-bar search is about what is inside a folder, not about the folder list itself
  const roots = S.roots;
  $("#panelCount").textContent = roots.length;
  // just the folders you added — everything inside them lives in the body
  $("#panelBody").innerHTML = (roots.map((r) =>
    '<div class="tree-row root ' + (S.sel === r || (S.sel || "").indexOf(r + "/") === 0 ? "on" : "") + '" data-dir="' + esc(r) + '">' +
    '<span class="tn">🗂 ' + esc(r.split("/").pop()) + "</span>" +
    '<span class="tab-x" data-drop="' + esc(r) + '" title="Remove folder">×</span></div>').join("") ||
    '<div style="padding:14px 10px;color:var(--fg-faint);font-size:12.5px">No folders yet.</div>') +
    '<div class="tree-row" data-addroot style="color:var(--accent);margin-top:10px"><span class="tn">＋ Add folder…</span></div>';
  $("#panelBody").querySelectorAll("[data-dir]").forEach((n) => (n.onclick = (e) => {
    const drop = e.target.dataset && e.target.dataset.drop;
    if (drop) { e.stopPropagation(); if (confirm("Stop showing " + drop + " in Bridge?")) setRoots(S.roots.filter((x) => x !== drop)); return; }
    selectDir(n.dataset.dir);
  }));
  const ar = $("#panelBody").querySelector("[data-addroot]");
  if (ar) ar.onclick = addRoot;
}
function renderBrowser(box) {
  const d = S.dir;
  if (!d) { box.innerHTML = '<div class="empty"><div><h2>Directory</h2><p>Pick a folder on the left.</p></div></div>'; return; }
  const q = S.filter;
  const files = d.entries.filter((e) => !e.dir && (!q || e.name.toLowerCase().indexOf(q) >= 0)).sort((a, b) => b.mtime - a.mtime);
  const dirs = d.entries.filter((e) => e.dir && (!q || e.name.toLowerCase().indexOf(q) >= 0));
  const root = S.roots.filter((r) => d.path === r || d.path.indexOf(r + "/") === 0)[0] || "";
  let acc = root;
  const crumbs = ['<button data-cd="' + esc(root) + '">' + esc(root.split("/").pop() || root) + "</button>"]
    .concat((root && d.path.length > root.length ? d.path.slice(root.length + 1).split("/") : []).map((seg) => {
      acc += "/" + seg;
      return '<span>/</span><button data-cd="' + esc(acc) + '">' + esc(seg) + "</button>";
    })).join("");
  box.innerHTML = '<div class="doc-view">' +
    '<div class="view-head"><span class="count">' + dirs.length + (dirs.length === 1 ? " folder" : " folders") +
    " · " + files.length + (files.length === 1 ? " file" : " files") + "</span></div>" +
    '<div class="crumbs" style="margin-bottom:18px">' + crumbs +
    (d.parent ? '<button data-cd="' + esc(d.parent) + '" style="margin-left:12px">↑ up</button>' : "") + "</div>" +
    (dirs.length ? '<div class="dircards">' + dirs.map((e) =>
      '<div class="dc" data-cd="' + esc((d.path + "/" + e.name).replace(/\/+/g, "/")) + '"><span>📁</span><span class="dc-n">' + esc(e.name) + "</span></div>").join("") + "</div>" : "") +
    (files.length
      ? '<table class="ftable"><thead><tr><th>Name</th><th style="width:110px">Size</th><th style="width:210px">Last edited</th></tr></thead><tbody>' +
      files.map((e) => '<tr data-open="' + esc((d.path + "/" + e.name).replace(/\/+/g, "/")) + '" data-name="' + esc(e.name) + '">' +
        '<td class="nm">' + esc(e.name) + '</td><td class="mono">' + fmtB(e.size) + '</td><td class="mono">' + fmtWhen(e.mtime) + "</td></tr>").join("") +
      "</tbody></table>"
      : '<div class="item-s" style="padding:10px 2px">No files directly in this folder.</div>') +
    "</div>";
  box.querySelectorAll("[data-cd]").forEach((n) => (n.onclick = () => selectDir(n.dataset.cd)));
  box.querySelectorAll("[data-open]").forEach((n) => (n.onclick = () => openPage(n.dataset.open, n.dataset.name, d.path.split("/").pop())));
}

/* ── activity: what Bridge has actually been doing ─────────────────── */
const LOG_KIND = {
  "turn.start": ["started", "k-start", "sent a prompt"],
  "turn.done": ["done", "k-done", "turn finished"],
  "turn.error": ["failed", "k-error", "turn failed"],
  "turn.exit": ["exited", "k-error", "process exited"],
  "turn.stop": ["stopped", "k-stop", "you interrupted it"],
  "file.save": ["saved", "k-save", "file written from Bridge"],
  folders: ["folders", "k-folders", "folder list changed"],
};
const fmtDur = (ms) => (ms >= 3600000 ? (ms / 3600000).toFixed(1) + "h" : ms >= 60000 ? Math.round(ms / 60000) + "m" : Math.round(ms / 1000) + "s");
let actTimer = null;
async function loadActivity() {
  try { S.activity = await (await fetch("/api/activity")).json(); } catch (e) {}
  if (S.view === "activity") { renderActivity($("#streamInner")); renderTop(); }
}
function renderActivity(box) {
  const A = S.activity;
  if (!A) { box.innerHTML = '<div class="empty"><div><h2>Loading activity…</h2></div></div>'; loadActivity(); return; }
  const s = A.summary;
  const tile = (label, value, sub) => '<div class="tile"><div class="tile-v">' + value + "</div>" +
    '<div class="tile-l">' + label + "</div>" + (sub ? '<div class="tile-s">' + sub + "</div>" : "") + "</div>";
  box.innerHTML = '<div class="doc-view">' +
    '<div class="view-head"><span class="count">live summary · today</span>' +
    '<span class="count" style="margin-left:auto">refreshed ' + fmtAgo(A.now) + "</span></div>" +
    '<div class="tiles">' +
      tile("running now", s.running, s.running ? "streaming" : "idle") +
      tile("turns", s.turns, s.done + " done · " + s.failed + " failed" + (s.stopped ? " · " + s.stopped + " stopped" : "")) +
      tile("spend", "$" + s.spend.toFixed(3), "model time " + fmtDur(s.wall)) +
      tile("sessions touched", s.sessionsToday, s.saves + " file saves") +
    "</div>" +
    (A.live.length ? '<div class="section"><div class="section-h">Running now<span>' + A.live.length + "</span></div>" +
      A.live.map((r) => '<div class="live-row" data-live="' + esc(r.id) + '">' +
        '<span class="tab-live"></span><span class="lr-t">' + esc(r.title || String(r.cwd).split("/").pop()) + "</span>" +
        '<span class="lr-m">' + esc(r.model || "default") + " · " + fmtDur(r.elapsed) + "</span>" +
        '<button class="chip" data-stop="' + esc(r.id) + '">Stop</button></div>').join("") + "</div>" : "") +
    '<div class="two-col">' +
      '<div class="section"><div class="section-h">Log<span>' + A.log.length + "</span></div>" +
        '<div class="logs">' + (A.log.length ? A.log.map((r) => {
          const k = LOG_KIND[r.kind] || [r.kind, "", r.kind];
          const where = r.cwd ? String(r.cwd).split("/").pop() : "";
          let sess = r.sessionTitle || "";
          if (sess && (sess === r.msg || r.msg.indexOf(sess) === 0 || sess.indexOf(r.msg) === 0)) sess = "";
          return '<div class="log-row" title="' + esc(k[2] + (where ? " · in " + where : "") + (r.session ? " · session " + r.session : "")) + '">' +
            '<span class="log-k ' + k[1] + '">' + k[0] + "</span>" +
            '<span class="log-t">' + esc(r.msg) + "</span>" +
            (sess ? '<span class="log-s"' + (r.sessionKey ? ' data-go="' + esc(r.sessionKey) + "|" + esc(r.session) + "|" + esc(r.sessionPath || "") + "|" + esc(sess) + '"' : "") +
              ">" + esc(sess) + "</span>" : (where ? '<span class="log-w">' + esc(where) + "</span>" : "")) +
            '<span class="log-m">' + (r.outcome && r.kind !== "turn.done" ? esc(r.outcome) + " · " : "") +
            (r.cost ? "$" + r.cost.toFixed(3) + " · " : "") + (r.ms ? fmtDur(r.ms) + " · " : "") +
            new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + "</span></div>";
        }).join("")
          : '<div class="item-s" style="padding:10px 2px">Nothing yet this run. Start a turn and it shows up here.</div>') + "</div></div>" +
      '<div class="section"><div class="section-h">Sessions touched today<span>' + A.sessions.length + "</span></div>" +
        '<div class="logs">' + A.sessions.map((x, i) => '<div class="log-row" data-sess="' + i + '">' +
          '<span class="log-k k-session">session</span><span class="log-t">' + esc(x.title) + "</span>" +
          '<span class="log-m">' + esc(x.projectName) + " · " + fmtAgo(x.mtime) + "</span></div>").join("") + "</div></div>" +
    "</div></div>";
  box.querySelectorAll("[data-go]").forEach((n) => (n.onclick = (e) => {
    e.stopPropagation();
    const [key, id, path, title] = n.dataset.go.split("|");
    openSessionIn(key, id, path, title);
  }));
  box.querySelectorAll("[data-stop]").forEach((n) => (n.onclick = (e) => {
    e.stopPropagation();
    fetch("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: n.dataset.stop }) })
      .then(() => { toast("Stopped"); loadActivity(); });
  }));
  box.querySelectorAll("[data-sess]").forEach((n) => (n.onclick = () => {
    const x = A.sessions[+n.dataset.sess];
    openSessionIn(x.project, x.id, x.projectPath, x.title);
  }));
}

/* ── one open document ─────────────────────────────────────────────── */
function renderDoc(box, c) {
  box.innerHTML = '<div class="doc-view' + (c.editing ? " wide" : "") + '">' +
    '<div class="view-head" style="margin-bottom:14px">' +
    (c.back ? '<button class="chip" data-back>← ' + esc(c.back) + "</button>" : "") +
    '<span class="count" style="font-family:var(--mono)">' + esc(c.path) + (c.size ? " · " + fmtB(c.size) : "") + '</span><div class="spacer"></div>' +
    (c.denied ? '<button class="chip acc" data-addthis>Add this folder</button>'
      : c.editing ? (c.lang === "markdown" ? '<button class="chip ' + (S.preview ? "acc" : "") + '" data-preview>' + (S.preview ? "◧ Preview" : "◻ Preview") + "</button>" : "") +
        '<button class="chip acc" data-save>Save ⌘S</button><button class="chip" data-cancel>Cancel</button>'
        : c.binary ? "" : '<button class="chip" data-edit>Edit</button><button class="chip" data-ask>Ask about this</button>') +
    "</div>" +
    (c.editing
      ? (c.lang === "markdown" && S.preview
        ? '<div class="split"><textarea class="editor" id="editor" spellcheck="false">' + esc(c.text) +
          '</textarea><div class="preview prose" id="preview">' + md(c.text) + "</div></div>"
        : '<textarea class="editor" id="editor" spellcheck="false">' + esc(c.text) + "</textarea>")
      : c.denied ? '<div class="empty" style="min-height:180px"><div><h2>Outside your folders</h2><p>' + esc(c.text) + "</p></div></div>"
        : c.binary ? '<img src="' + c.url + '" style="max-width:100%;border-radius:10px;border:1px solid var(--border)">'
          : c.lang === "markdown" ? '<div class="prose">' + md(c.text) + "</div>"
            : '<div class="prose"><pre><code>' + esc(c.text) + "</code></pre></div>") + "</div>";
  const q = (sel) => box.querySelector(sel);
  const bk = q("[data-back]");
  if (bk) bk.onclick = closePage;
  const pv = q("[data-preview]");
  if (pv) pv.onclick = () => { S.preview = !S.preview; renderMain(); const t = $("#editor"); if (t) t.focus(); };
  const eb = q("[data-edit]");
  if (eb) eb.onclick = () => { c.editing = true; renderMain(); const t = $("#editor"); if (t) { t.focus(); t.setSelectionRange(0, 0); } };
  const cb = q("[data-cancel]");
  if (cb) cb.onclick = () => { c.editing = false; c.dirty = false; paint(); };
  const sb = q("[data-save]");
  if (sb) sb.onclick = saveDoc;
  const ab = q("[data-ask]");
  if (ab) ab.onclick = () => { makeTab(); goChat(); $("#input").value = "Read " + c.path + " and explain it."; $("#input").focus(); };
  const ad = q("[data-addthis]");
  if (ad) ad.onclick = () => setRoots(S.roots.concat([c.path.slice(0, c.path.lastIndexOf("/"))]));
  const ed = q("#editor");
  if (ed) {
    let pT;
    ed.oninput = () => {
      if (!c.dirty) { c.dirty = true; }
      const pane = $("#preview");
      if (!pane) return;
      clearTimeout(pT);
      pT = setTimeout(() => { const p2 = $("#preview"); if (p2) p2.innerHTML = md(ed.value); }, 140);
    };
    ed.onkeydown = (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") { ev.preventDefault(); saveDoc(); }
      else if (ev.key === "Tab") {
        ev.preventDefault();
        const s0 = ed.selectionStart;
        ed.value = ed.value.slice(0, s0) + "  " + ed.value.slice(ed.selectionEnd);
        ed.selectionStart = ed.selectionEnd = s0 + 2;
      } else if (ev.key === "Escape") { c.editing = false; paint(); }
    };
  }
  box.querySelectorAll(".prose a").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (/^(https?:|mailto:|#)/.test(href)) return;
    link.onclick = (ev) => {
      ev.preventDefault();
      const base = c.path.slice(0, c.path.lastIndexOf("/"));
      openPage((base + "/" + href).replace(/\/+/g, "/"), href.split("/").pop(), c.back);
    };
  });
}

async function openPage(path, label, backLabel) {
  const d = await (await fetch("/api/file?path=" + encodeURIComponent(path))).json();
  S.page[S.view] = {
    path: path, title: label || path.split("/").pop(), back: backLabel,
    text: d.error ? d.error : d.text || "", lang: d.lang || "text",
    binary: !!d.binary, url: d.url, denied: !!d.error, editing: false, dirty: false, size: d.size || 0,
  };
  paint();
  requestAnimationFrame(() => { $("#stream").scrollTop = 0; });
}
function closePage() { delete S.page[S.view]; paint(); }
async function saveDoc() {
  const c = PAGE();
  if (!c) return;
  const ed = $("#editor");
  const text = ed ? ed.value : c.text;
  const r = await (await fetch("/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: c.path, text: text }) })).json();
  if (r.error) return toast(r.error);
  c.text = text; c.size = r.size; c.editing = false; c.dirty = false;
  if (S.sel) { delete S.tree[S.sel]; const d = await loadDir(S.sel); if (d) S.dir = d; }
  paint();
  toast("Saved " + c.title);
}

const SEARCH_HINT = {
  agents: "Search agents by name or expertise…",
  configs: "Search configs, memory and skills…",
  files: "Search files and folders here…",
};
function renderTop() {
  renderPhases();
  const ts = $("#topSearch");
  const hint = SEARCH_HINT[S.view];
  const showSearch = !!hint && !PAGE();
  ts.hidden = !showSearch;
  if (showSearch) { ts.placeholder = hint; if (ts.value !== S.filter) ts.value = S.filter; }
  const t = T(), c = PAGE();
  const chat = S.view === "chat";
  const label = S.view === "files" ? (S.dir ? S.dir.path.split("/").pop() : "Directory") : S.view === "agents" ? "Agents" : S.view === "activity" ? "Activity" : "Configs";
  $("#crumbTitle").textContent = chat ? (t ? tabTitle(t) : "Bridge") : c ? c.title : label;
  const cp = $("#crumbPath");
  if (chat && t) {
    cp.innerHTML = '<span class="cwd-lab">Working directory:</span> <button class="cwd-pick" title="Change the folder this session runs in">' +
      esc(short(t.path, 40)) + " ⌄</button>";
    const btn = cp.querySelector(".cwd-pick");
    if (btn) btn.onclick = pickCwd;
  } else {
    cp.textContent = c ? short(c.path, 44) : S.view === "files" && S.dir ? short(S.dir.path, 44) : "";
  }
  $("#cwdChip").textContent = "⌂ " + (t ? t.name : "~") + " ⌄";
  $("#cwdChip").title = "Working directory — click to change";
  const dark = document.documentElement.dataset.theme === "dark";
  const ti = $("#themeIc");
  if (ti) { ti.textContent = dark ? "☀" : "☾"; }
  const tb = $("#railTheme");
  if (tb) tb.title = dark ? "Switch to light" : "Switch to dark";
  const r = t && t.lastResult;
  $("#costHint").textContent = r ? (r.turns || "?") + " turns · " + (r.duration_ms / 1000).toFixed(1) + "s · $" + (r.total_cost_usd || 0).toFixed(4) : "";
}

function renderInspector() {
  $("#app").classList.toggle("with-inspector", S.inspector);
  $("#inspector").hidden = !S.inspector;
  if (!S.inspector) return;
  const t = T() || { msgs: [] };
  const outs = t.msgs.filter((m) => m.kind === "tool" && ["Write", "Edit", "NotebookEdit"].indexOf(m.name) >= 0)
    .map((m) => m.input && m.input.file_path).filter(Boolean);
  const uniq = outs.filter((p, i) => outs.indexOf(p) === i);
  const tools = {};
  t.msgs.filter((m) => m.kind === "tool").forEach((m) => (tools[m.name] = (tools[m.name] || 0) + 1));
  const u = t.usage || {};
  $("#inspBody").innerHTML =
    '<dl class="kv">' +
    "<dt>Directory</dt><dd>" + esc(t.path || "") + "</dd>" +
    "<dt>Session</dt><dd>" + esc(t.id || t.live || "new") + "</dd>" +
    "<dt>Model</dt><dd>" + esc(t.model || $("#selModel").value || "default") + "</dd>" +
    "<dt>Branch</dt><dd>" + esc(t.branch || "—") + "</dd></dl>" +
    '<div class="card"><h4>Token usage</h4>' +
    '<div class="stat"><span>Input</span><b>' + fmtN(u.input || 0) + "</b></div>" +
    '<div class="stat"><span>Output</span><b>' + fmtN(u.output || 0) + "</b></div>" +
    '<div class="stat"><span>Thinking</span><b>' + fmtN(u.thinking || 0) + "</b></div>" +
    '<div class="stat"><span>Cache read</span><b>' + fmtN(u.cacheRead || 0) + "</b></div>" +
    '<div class="stat"><span>Cache write</span><b>' + fmtN(u.cacheWrite || 0) + "</b></div></div>" +
    '<div class="card"><h4>Tool calls</h4>' +
    (Object.keys(tools).sort((a, b) => tools[b] - tools[a]).map((n) =>
      '<div class="stat"><span>' + (TOOL_ICON[n] || "◆") + " " + esc(n) + "</span><b>" + tools[n] + "</b></div>").join("") || '<div class="item-s">none</div>') +
    "</div>" +
    '<div class="card"><h4>Files written (' + uniq.length + ")</h4>" +
    (uniq.map((p) => '<div class="stat" style="cursor:pointer" data-out="' + esc(p) + '"><span style="font-family:var(--mono);font-size:11.5px;overflow-wrap:anywhere">' +
      esc(short(p, 44)) + "</span></div>").join("") || '<div class="item-s">none yet</div>') + "</div>";
  $("#inspBody").querySelectorAll("[data-out]").forEach((n) => (n.onclick = () => { S.view = "files"; openPage(n.dataset.out, n.dataset.out.split("/").pop(), "Directory"); }));
}

function paint() { renderRail(); renderTabs(); renderPanel(); renderMain(); renderTop(); renderInspector(); sendBtn(); }

/* ─────────────────────────── actions ──────────────────────────── */

async function addRoot() {
  const v = prompt("Folder to add — Bridge can only read the folders listed here:", S.roots[0] || "");
  if (v && v.trim()) await setRoots(S.roots.concat([v.trim().replace(/\/+$/, "")]));
}
async function setRoots(roots) {
  S.roots = await (await fetch("/api/roots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roots: roots }) })).json();
  S.tree = {};
  if (S.roots[0]) await selectDir(S.roots[0]);
  paint();
  toast("Folders updated");
}
function goChat() { S.view = "chat"; S.filter = ""; const ps = $("#topSearch"); if (ps) ps.value = ""; paint(); }
function go(view) {
  clearInterval(actTimer); actTimer = null;
  if (view === "activity") { loadActivity(); actTimer = setInterval(loadActivity, 3000); }
  if (view === "chat") return goChat();
  if (railOn(view)) return goChat();
  S.filter = "";
  const ps = $("#topSearch"); if (ps) ps.value = "";
  S.view = view;
  paint();
}
async function refreshRecent() {
  try { S.recent = await (await fetch("/api/recent?limit=80")).json(); } catch (e) {}
  renderTabs(); renderTop();
}

/* ─────────────────────────── streaming ────────────────────────── */
async function send() {
  const ta = $("#input");
  const text = ta.value.trim();
  const tab = T();
  if (!text || !tab) return;
  ta.value = ""; ta.style.height = "auto";
  const msg = { kind: "user", text: text, ts: Date.now() };
  tab.msgs.push(msg);
  // a turn already running is no reason to stop typing: queue it, same as the terminal
  if (tab.streaming) {
    msg.queued = true;
    (tab.queue = tab.queue || []).push(msg);
    if (T() === tab) { renderStream(); scrollDown(true); }
    return;
  }
  runTurn(tab, text);
}
async function runTurn(tab, text) {
  tab.streaming = true;
  if (T() === tab) renderStream();
  renderTabs(); sendBtn(); scrollDown(true);

  const body = {
    prompt: text, cwd: tab.path,
    resume: tab.live || tab.id || null,
    model: $("#selModel").value || null,
    permissionMode: $("#selPerm").value,
    effort: $("#selEffort").value || null,
    agent: $("#selAgent").value || null,
  };
  let blocks = {};
  const flush = () => { if (T() === tab) { renderStream(); scrollDown(); } };

  function onEvent(p) {
    if (p.t === "start") { tab.live = tab.live || p.sessionId; return; }
    if (p.t === "stderr") {
      const line = String(p.d).trim();
      if (line && !/hook|deprecat|warning/i.test(line)) { tab.msgs.push({ kind: "assistant", text: "```\n" + line + "\n```", ts: Date.now() }); flush(); }
      return;
    }
    if (p.t === "end" || p.t === "error" || p.t === "raw") return;
    const d = p.d;
    if (!d || !d.type) return;

    if (d.type === "system" && d.subtype === "init") {
      tab.live = d.session_id || tab.live;
      tab.id = tab.id || tab.live;
      tab.model = d.model || tab.model;
      return;
    }
    if (d.type === "stream_event") {
      const ev = d.event, side = !!d.parent_tool_use_id;
      if (!ev) return;
      if (ev.type === "message_start") { blocks = {}; return; }
      if (ev.type === "content_block_start") {
        const cb = ev.content_block || {};
        if (cb.type === "text") blocks[ev.index] = tab.msgs.push({ kind: side ? "agent_text" : "assistant", text: "", ts: Date.now(), live: true, model: tab.model }) - 1;
        else if (cb.type === "thinking") blocks[ev.index] = tab.msgs.push({ kind: "thinking", text: "", ts: Date.now(), live: true, open: true, side: side }) - 1;
        flush();
      } else if (ev.type === "content_block_delta") {
        const idx = blocks[ev.index];
        if (idx === undefined) return;
        const m = tab.msgs[idx];
        if (ev.delta.type === "text_delta") m.text += ev.delta.text;
        else if (ev.delta.type === "thinking_delta") m.text += ev.delta.thinking;
        else return;
        flush();
      } else if (ev.type === "content_block_stop") {
        const idx = blocks[ev.index];
        if (idx !== undefined) { tab.msgs[idx].live = false; if (tab.msgs[idx].kind === "thinking") tab.msgs[idx].open = false; }
        flush();
      }
      return;
    }
    if (d.type === "assistant") {
      const side = !!d.parent_tool_use_id;
      const streamed = Object.keys(blocks).length > 0;
      ((d.message && d.message.content) || []).forEach((c) => {
        if (c.type === "tool_use") tab.msgs.push({ kind: "tool", name: c.name, input: c.input, id: c.id, ts: Date.now(), side: side, result: null });
        else if (c.type === "text" && !streamed && c.text && c.text.trim())
          tab.msgs.push({ kind: side ? "agent_text" : "assistant", text: c.text, ts: Date.now(), model: d.message.model });
      });
      tab.usage = accUsage(tab.usage, d.message && d.message.usage);
      flush();
      return;
    }
    if (d.type === "user") {
      ((d.message && d.message.content) || []).forEach((c) => {
        if (c.type !== "tool_result") return;
        for (let i = tab.msgs.length - 1; i >= 0; i--) {
          const m = tab.msgs[i];
          if (m.kind === "tool" && m.id === c.tool_use_id) {
            m.result = {
              content: typeof c.content === "string" ? c.content : (c.content || []).map((z) => z.text || "[" + z.type + "]").join("\n"),
              isError: !!c.is_error,
            };
            break;
          }
        }
      });
      flush();
      return;
    }
    if (d.type === "result") {
      tab.lastResult = { total_cost_usd: d.total_cost_usd, duration_ms: d.duration_ms, turns: d.num_turns };
      if (T() === tab) { renderTop(); renderInspector(); }
      refreshSessions();
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
        let p;
        try { p = JSON.parse(raw.slice(6)); } catch (e) { continue; }
        onEvent(p);
      }
    }
  } catch (e) {
    tab.msgs.push({ kind: "assistant", text: "**Bridge error** — " + String(e), ts: Date.now() });
  }
  tab.streaming = false;
  tab.msgs.forEach((m) => (m.live = false));
  sendBtn(); renderTabs(); flush();
  if (T() === tab) renderInspector();
  else note(tab, tab.lastResult ? "done" : "error", tab.lastResult ? "$" + (tab.lastResult.total_cost_usd || 0).toFixed(3) : "");
  // drain anything typed while that turn was running
  const q = tab.queue || [];
  if (q.length) {
    const next = q.shift();
    next.queued = false;
    const at = tab.msgs.indexOf(next);
    if (at >= 0) { tab.msgs.splice(at, 1); tab.msgs.push(next); }
    if (T() === tab) renderStream();
    return runTurn(tab, next.text);
  }
}
function sendBtn() {
  const t = T(), b = $("#btnSend"), on = !!(t && t.streaming);
  b.classList.toggle("stop", on);
  b.innerHTML = on
    ? '<svg viewBox="0 0 24 24" fill="currentColor" style="width:12px;height:12px"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
}
function accUsage(u, x) {
  if (!x) return u;
  u = u || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  return {
    input: u.input + (x.input_tokens || 0),
    output: u.output + (x.output_tokens || 0),
    cacheRead: u.cacheRead + (x.cache_read_input_tokens || 0),
    cacheWrite: u.cacheWrite + (x.cache_creation_input_tokens || 0),
    thinking: u.thinking + ((x.output_tokens_details && x.output_tokens_details.thinking_tokens) || 0),
  };
}
function abortTab(t) {
  if (!t || !t.live) return;
  fetch("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: t.live }) });
  toast("Stopped");
}
async function refreshSessions() {
  if (!S.project) return;
  S.sessions = await (await fetch("/api/sessions?key=" + encodeURIComponent(S.project.key))).json();
  renderTabs(); renderTop();
}

/* ─────────────────────── composer affordances ─────────────────── */
let acItems = [], acSel = 0, acStart = 0;
function closeAc() { $("#ac").classList.remove("on"); acItems = []; }
function renderAc() {
  if (!acItems.length) return closeAc();
  $("#ac").innerHTML = acItems.slice(0, 40).map((it, i) =>
    '<div class="ac-i ' + (i === acSel ? "sel" : "") + '" data-i="' + i + '"><span class="ac-n">' + esc(it.label) + '</span><span class="ac-d">' + esc(it.desc || "") + "</span></div>").join("");
  $("#ac").classList.add("on");
  $("#ac").querySelectorAll(".ac-i").forEach((n) => (n.onclick = () => applyAc(+n.dataset.i)));
}
function applyAc(i) {
  const it = acItems[i];
  if (!it) return;
  const ta = $("#input");
  ta.value = ta.value.slice(0, acStart) + it.insert + ta.value.slice(ta.selectionStart);
  ta.selectionStart = ta.selectionEnd = acStart + it.insert.length;
  closeAc(); ta.focus();
}
async function updateAc() {
  const ta = $("#input"), pos = ta.selectionStart, before = ta.value.slice(0, pos);
  const mSlash = before.match(/(^|\s)\/([\w:-]*)$/);
  const mAt = before.match(/(^|\s)@(\S*)$/);
  if (mSlash) {
    acStart = pos - mSlash[2].length - 1;
    const q = mSlash[2].toLowerCase();
    acItems = S.skills.filter((s) => s.name.toLowerCase().indexOf(q) >= 0).slice(0, 40)
      .map((s) => ({ label: "/" + s.name, desc: s.description.slice(0, 70), insert: "/" + s.name + " " }));
    acSel = 0; renderAc();
  } else if (mAt) {
    acStart = pos - mAt[2].length - 1;
    const q = mAt[2].toLowerCase();
    const t = T();
    const want = (t && t.path) || S.roots[0] || "";
    if (!S.acDir || S.acDir.path !== want) {
      const r = await (await fetch("/api/dir?path=" + encodeURIComponent(want))).json();
      S.acDir = r.error ? { path: want, entries: [] } : r;
    }
    const d = S.acDir;
    acItems = d.entries.filter((e) => e.name.toLowerCase().indexOf(q) >= 0).slice(0, 40)
      .map((e) => ({ label: (e.dir ? "📁 " : "📄 ") + e.name, desc: "", insert: "@" + (d.path + "/" + e.name).replace(/\/+/g, "/") + " " }));
    acSel = 0; renderAc();
  } else closeAc();
}


/* ────────────────── full-screen session finder (⌘F) ───────────────── */
let findScope = "all", findSeq = 0;
function openFinder(seed) {
  $("#finder").classList.add("on");
  const inp = $("#finderInput");
  if (seed !== undefined) inp.value = seed;
  inp.focus(); inp.select();
  if (inp.value.trim()) runFind(); else runFind();
}
function closeFinder() { $("#finder").classList.remove("on"); }
function hl(text, terms) {
  let h = esc(text);
  terms.forEach((t) => {
    if (t.length < 3) return;
    h = h.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"), "<mark>$1</mark>");
  });
  return h;
}
async function runFind() {
  const q = $("#finderInput").value.trim();
  const body = $("#finderBody");
  if (!q) {
    body.innerHTML = '<div class="finder-empty">Say what you are after in your own words. Bridge reads every transcript on this machine, then summarises what each session actually did.</div>';
    $("#finderNote").textContent = "Type a few words and press ↵";
    return;
  }
  const seq = ++findSeq;
  $("#finderSpin").style.display = "";
  const url = "/api/find?q=" + encodeURIComponent(q) + "&scope=" + findScope +
    (T() && T().key ? "&key=" + encodeURIComponent(T().key) : "");
  let res = [];
  try { res = await (await fetch(url)).json(); } catch (e) { res = []; }
  if (seq !== findSeq) return;
  $("#finderSpin").style.display = "none";
  const terms = q.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 2);
  $("#finderNote").textContent = res.length + " sessions match, best first";
  body.innerHTML = res.length ? res.map((r, i) =>
    '<div class="res" data-i="' + i + '">' +
    '<div class="res-t">' + hl(r.title, terms) + "</div>" +
    '<div class="res-m"><span>' + esc(short(r.projectPath || r.project, 40)) + "</span><span>" + fmtAgo(r.mtime) + "</span>" +
    (r.model ? "<span>" + esc(r.model.replace("claude-", "")) + "</span>" : "") +
    "<span>" + fmtB(r.size) + "</span><span>" + r.tools + " tool calls</span>" +
    (r.wrote.length ? "<span>" + r.wrote.length + " files written</span>" : "") +
    "<span>" + r.covered + "/" + r.terms + " terms</span></div>" +
    (r.first ? '<div class="res-s"><b>asked</b>' + hl(r.first, terms) + "</div>" : "") +
    (r.last ? '<div class="res-s"><b>ended</b>' + hl(r.last, terms) + "</div>" : "") +
    r.snippets.map((s) => '<div class="res-snip">' + hl(s, terms) + "</div>").join("") +
    "</div>").join("") :
    '<div class="finder-empty">Nothing matched “' + esc(q) + '”.</div>';
  body.querySelectorAll(".res").forEach((n) => (n.onclick = () => {
    const r = res[+n.dataset.i];
    closeFinder();
    openSessionIn(r.project, r.id, r.projectPath, r.title);
  }));
}

/* ─────────────────────── command palette ──────────────────────── */
let palItems = [], palSel = 0;
function openPalette() {
  $("#paletteBg").classList.add("on");
  $("#paletteInput").value = "";
  $("#paletteInput").focus();
  palFill("");
}
function closePalette() { $("#paletteBg").classList.remove("on"); }
function palFill(q) {
  const ql = q.toLowerCase();
  const cmds = [
    { label: "New session", desc: "⌘T", run: () => { makeTab(); goChat(); $("#input").focus(); } },
    { label: "Search every session", desc: "⌘F", run: () => openFinder("") },
    { label: "Back to the conversation", desc: "Esc", run: goChat },
    { label: "Toggle theme", desc: "⌘J", run: toggleTheme },
    { label: "Toggle inspector", desc: "⌘I", run: () => { S.inspector = !S.inspector; renderInspector(); } },
  ]
    .concat(RAIL.filter((r) => r.id !== "chat").map((r) => ({ label: "Go to " + r.label, desc: "", run: () => go(r.id) })))
    .concat(S.roots.map((r) => ({ label: "Folder · " + r.split("/").pop(), desc: r, run: () => setCwd(r) })))
    .concat(S.configs.map((c) => ({ label: c.group + " · " + c.label, desc: c.desc ? c.desc.slice(0, 60) : c.path, run: () => { S.view = c.group === "Agents" ? "agents" : "configs"; openPage(c.path, c.label, c.group === "Agents" ? "Agents" : "Configs"); } })))
    .concat(S.recent.slice(0, 60).map((s) => ({ label: "Session · " + s.title, desc: s.projectName + " · " + fmtAgo(s.mtime), run: () => openSessionIn(s.project, s.id, s.projectPath, s.title) })));
  palItems = cmds.filter((c) => (c.label + " " + c.desc).toLowerCase().indexOf(ql) >= 0).slice(0, 60);
  palSel = 0; palRender();
}
function palRender() {
  $("#paletteList").innerHTML = palItems.map((c, i) =>
    '<div class="item ' + (i === palSel ? "on" : "") + '" data-i="' + i + '"><div class="item-t">' + esc(c.label) + "</div>" +
    (c.desc ? '<div class="item-s">' + esc(c.desc) + "</div>" : "") + "</div>").join("") ||
    '<div style="padding:16px;color:var(--fg-faint);font-size:13px">No matches</div>';
  $("#paletteList").querySelectorAll("[data-i]").forEach((n) => (n.onclick = () => { closePalette(); palItems[+n.dataset.i].run(); }));
}

/* ──────────────────────────── misc ────────────────────────────── */
let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("on"), 1800);
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.bridgeTheme = next;
  renderTop();
}

/* ──────────────────────────── boot ────────────────────────────── */
(async function boot() {
  document.documentElement.dataset.theme = localStorage.bridgeTheme || "dark";

  const urls = ["/api/bootstrap", "/api/recent?limit=80", "/api/agents", "/api/configs", "/api/roots"];
  const [b, recent, agents, configs, roots] = await Promise.all(urls.map((u) => fetch(u).then((r) => r.json())));
  Object.assign(S, { boot: b, recent: recent, agents: agents, configs: configs, roots: roots });
  S.skills = configs.filter((c) => c.group === "Skills");
  S.cwd = localStorage.bridgeCwd && roots.indexOf(localStorage.bridgeCwd) >= 0 ? localStorage.bridgeCwd : roots[0];

  $("#selModel").innerHTML = '<option value="">model</option>' + b.models.map((m) => "<option>" + m + "</option>").join("");
  $("#selPerm").innerHTML = b.permissionModes.map((m) => "<option " + (m === "acceptEdits" ? "selected" : "") + ">" + m + "</option>").join("");
  $("#selEffort").innerHTML = b.efforts.map((e) => '<option value="' + e + '">' + (e || "effort") + "</option>").join("");
  $("#selAgent").innerHTML = '<option value="">no agent</option>' + agents.map((a) => "<option>" + esc(a.name) + "</option>").join("");

  if (S.roots[0]) await selectDir(S.roots[0]);
  loadNotes();
  makeTab();
  paint(); renderBell();

  $("#btnPalette").onclick = openPalette;
  $("#btnInspector").onclick = () => { S.inspector = !S.inspector; renderInspector(); };
  $("#inspClose").onclick = () => { S.inspector = false; renderInspector(); };
  $("#topSearch").oninput = (e) => { S.filter = e.target.value.toLowerCase(); renderMain(); renderPanel(); };
  $("#tabAdd").onclick = () => { makeTab(); goChat(); $("#input").focus(); };
  $("#tabMenu").onclick = (e) => { e.stopPropagation(); toggleRecents(); };
  $("#btnBell").onclick = (e) => { e.stopPropagation(); toggleNotes(); };
  $("#notesClose").onclick = () => toggleNotes(false);
  $("#notesRead").onclick = () => { S.notes.forEach((x) => (x.read = true)); saveNotes(); renderBell(); };
  $("#notesClear").onclick = () => { S.notes = []; saveNotes(); renderBell(); };
  $("#recentsSearch").oninput = (e) => fillRecents(e.target.value);
  $("#recents").onclick = (e) => e.stopPropagation();
  document.addEventListener("click", () => toggleRecents(false));
  $("#cwdChip").style.cursor = "pointer";
  $("#cwdChip").onclick = pickCwd;
  $("#finderClose").onclick = closeFinder;
  let findT;
  $("#finderInput").oninput = () => { clearTimeout(findT); findT = setTimeout(runFind, 350); };
  $("#finderInput").onkeydown = (e) => {
    if (e.key === "Enter") { clearTimeout(findT); runFind(); }
    else if (e.key === "Escape") closeFinder();
  };
  $("#finder").querySelectorAll("[data-scope]").forEach((n) => (n.onclick = () => {
    findScope = n.dataset.scope;
    $("#finder").querySelectorAll("[data-scope]").forEach((x) => x.classList.toggle("on", x === n));
    runFind();
  }));
  $("#paletteBg").onclick = (e) => { if (e.target.id === "paletteBg") closePalette(); };
  $("#paletteInput").oninput = (e) => palFill(e.target.value);
  $("#paletteInput").onkeydown = (e) => {
    if (e.key === "ArrowDown") { palSel = Math.min(palSel + 1, palItems.length - 1); palRender(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { palSel = Math.max(palSel - 1, 0); palRender(); e.preventDefault(); }
    else if (e.key === "Enter") { closePalette(); if (palItems[palSel]) palItems[palSel].run(); }
    else if (e.key === "Escape") closePalette();
  };
  $("#btnSend").onclick = () => { const t = T(); if (t && t.streaming) abortTab(t); else send(); };

  const ta = $("#input");
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 260) + "px"; updateAc(); };
  ta.onkeydown = (e) => {
    if (acItems.length) {
      if (e.key === "ArrowDown") { acSel = Math.min(acSel + 1, acItems.length - 1); renderAc(); return e.preventDefault(); }
      if (e.key === "ArrowUp") { acSel = Math.max(acSel - 1, 0); renderAc(); return e.preventDefault(); }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) { applyAc(acSel); return e.preventDefault(); }
      if (e.key === "Escape") { closeAc(); return e.preventDefault(); }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };
  document.onkeydown = (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const edDoc = PAGE();
    if (meta && e.key === "s" && edDoc && edDoc.editing) { e.preventDefault(); saveDoc(); return; }
    if (meta && e.key >= "1" && e.key <= "9") { const i = +e.key - 1; if (S.view === "chat" && S.tabs[i]) { e.preventDefault(); activate(i); } return; }
    if (meta && e.key === "f") { e.preventDefault(); openFinder(); }
    else if (meta && e.key === "k") { e.preventDefault(); openPalette(); }
    else if (meta && e.key === "p") { e.preventDefault(); goChat(); toggleRecents(true); }
    else if (meta && e.key === "t") { e.preventDefault(); makeTab(); goChat(); $("#input").focus(); }
    else if (meta && e.key === "w") { e.preventDefault(); if (S.view === "chat") closeTab(S.active); else if (PAGE()) closePage(); }
    else if (meta && e.key === "j") { e.preventDefault(); toggleTheme(); }
    else if (meta && e.key === "i") { e.preventDefault(); S.inspector = !S.inspector; renderInspector(); }
    else if (e.key === "Escape") {
      if ($("#notes").classList.contains("on")) toggleNotes(false);
      else if ($("#finder").classList.contains("on")) closeFinder();
      else if ($("#recents").classList.contains("on")) toggleRecents(false);
          else if (PAGE()) closePage();
      else if (S.view !== "chat") goChat();
      else { const t = T(); if (t && t.streaming) abortTab(t); }
    }
  };
  ta.focus();
})();
