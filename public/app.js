/* ══════════════════════════ Bridge client ══════════════════════════ */
/** resolves once boot() has painted; desk.js waits on it */
window.BridgeReady = new Promise((r) => (window._bridgeBooted = r));
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
  view: "chat", boot: null, auth: { loggedIn: true }, recent: [], agents: [], skills: [], configs: [],
  cwd: "", roots: [], dir: null, acDir: null, filter: "", inspector: false,
  tabs: [], active: 0,      // session tabs, across the top
  page: {},                 // the open detail page, per view
  notes: [],                // sessions that finished or failed while you were elsewhere
  group: "Core",            // which Configs group the cards are showing
  agentCat: "All",          // which area of expertise the Agents pills are showing
  tree: {}, sel: "", preview: true, // Directory listings + selection; md editor preview pane
  attachments: [],          // files staged in the composer for the next turn
  editingTab: null,         // index of the tab whose title is being edited inline
  lastTabClick: null,       // {i, ts} — hand-rolled double-click detection on tabs
  live: [],                 // the terminal sessions Claude Code has open right now (from its registry)
  dismissed: {},            // mirror tabs closed by hand: not reopened while that terminal lives
};
/** the active session tab */
const T = () => S.tabs[S.active] || null;
/** plain-language help for the composer options (shown as tooltips) */
const HELP = {
  model: {
    "": "your settings.json default",
    opus: "deepest reasoning, best for hard design and debugging work",
    sonnet: "fast and capable, the everyday choice",
    haiku: "cheapest and fastest, for trivial or mechanical turns",
    fable: "Anthropic's latest top model",
  },
  perm: {
    acceptEdits: "edits files without asking, still asks before running commands",
    auto: "Claude decides what is safe to run and asks only when unsure",
    plan: "read-only: explores and proposes a plan, changes nothing",
    bypassPermissions: "never asks, runs everything. Only in folders you trust",
    manual: "asks you before every edit and every command",
    default: "asks before every edit and every command",
    dontAsk: "never prompts; anything not pre-allowed is refused instead of asked",
  },
  effort: {
    "": "your default",
    low: "quick, minimal thinking",
    medium: "balanced",
    high: "thinks longer, multi-step work",
    xhigh: "very thorough, slower",
    max: "maximum budget, slowest",
    ultracode: "max effort plus multi-agent orchestration: Claude Code fans the task out to a team of agents. Slowest, most thorough, most expensive",
  },
  agent: { "": "plain Claude Code with your CLAUDE.md and hooks",
    auto: "Bridge reads each message and hands it to the agent that fits, switching as the work moves. No match means plain Claude Code" },
};

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
      (m.queued ? '<span class="tag">queued</span>' : "") + (m.ultra ? '<span class="tag ultra">ultracode</span>' : "") +
      (m.routedTo ? '<span class="tag agent" title="AUTO routed this message to the ' + esc(m.routedTo) + ' agent">→ ' + esc(m.routedTo) + "</span>" : "") + "</div>" +
      '<div class="bubble prose">' + md(m.text) + "</div></div></div>";
  if (m.kind === "assistant" || m.kind === "agent_text") {
    const side = m.kind === "agent_text";
    return '<div class="msg"><div class="av a">' + (side ? "◇" : esc(name.slice(0, 1).toUpperCase())) + "</div>" +
      '<div class="msg-body ' + (side ? "sidechain" : "") + '"><div class="msg-name">' + (side ? "subagent" : esc(name)) +
      (m.model ? ' <span class="tag">' + esc(String(m.model).replace("claude-", "")) + "</span>" : "") +
      '<span class="ts">' + fmtTime(m.ts) + "</span></div>" +
      '<div class="prose"><div class="md">' + md(m.live ? m.text : extractChoices(m.text).body) + "</div>" + (m.live ? '<span class="typing"></span>' : "") + "</div>" +
      (m.live ? "" : renderChoices(extractChoices(m.text).choices)) + "</div></div>";
  }
  if (m.kind === "plan") {
    return '<div class="msg"><div class="av a">' + esc(name.slice(0, 1).toUpperCase()) + "</div>" +
      '<div class="msg-body"><div class="msg-name">' + esc(name) + ' <span class="tag plan">plan</span><span class="ts">' + fmtTime(m.ts) + "</span></div>" +
      '<div class="plan-card"><div class="prose"><div class="md">' + md(m.text) + "</div></div>" +
      (m.file ? '<div class="plan-file">' + esc(short(m.file, 60)) + "</div>" : "") +
      (m.decided ? '<div class="plan-decided">' + esc(m.decided) + "</div>" :
        '<div class="plan-actions"><button class="choice primary" data-plan="approve">Approve &amp; build</button><button class="choice" data-plan="revise">Revise</button></div>') +
      "</div></div></div>";
  }
  if (m.kind === "status") return "";   // the live turn state lives above the composer, not in the transcript
  if (m.kind === "thinking") {
    /* Thinking blocks arrive with an empty `thinking` field and a signature only — the
       reasoning text is not exposed — so a card would be an empty box. Show none until
       real text turns up; the pulsing state above the composer carries the waiting. */
    if (!m.text.trim()) return "";
    return '<div class="think ' + (m.open ? "open" : "") + '" data-think><div class="think-h">✦ thinking' +
      '<span class="think-count" style="color:var(--fg-faint);font-weight:400">' + (m.text.length > 60 ? " · " + fmtN(m.text.length) + " chars" : "") + "</span>" +
      '<span class="think-x" title="Collapse">×</span></div>' +
      '<div class="think-b"><span class="md">' + esc(m.text) + "</span>" + (m.live ? '<span class="typing"></span>' : "") + "</div></div>";
  }
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
/** options the user can answer with one click: an explicit ```choices block, or a short list under a question */
function extractChoices(text) {
  const m = /```choices\s*\n([\s\S]*?)```/.exec(text || "");   // anywhere: a closing line may follow the block
  if (m) return { body: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n").trim(), choices: m[1].split("\n").map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean).slice(0, 6) };
  const t = String(text || "").trimEnd();
  if (!/\?\s*$/.test(t) && !/\?\s*\n[^\n]*$/.test(t)) return { body: text, choices: [] };
  const lines = t.split("\n"), opts = [];
  for (let i = lines.length - 1; i >= 0 && opts.length < 6; i--) {
    const mm = /^\s*(?:\d+[.)]|[-*•])\s+(.{2,70})$/.exec(lines[i]);
    if (mm) opts.unshift(mm[1].replace(/\*\*/g, "").trim()); else if (opts.length) break;
  }
  return { body: text, choices: opts.length >= 2 ? opts : [] };
}
function renderChoices(list) {
  return list.length ? '<div class="choices">' + list.map((c) => '<button class="choice" data-choice="' + esc(c) + '">' + esc(c) + "</button>").join("") + "</div>" : "";
}
/** update only what changed in a live row; false = caller must rebuild the row */
function patchRow(el, m) {
  const cursor = (host) => {
    const c = host.querySelector(".typing");
    if (m.live && !c) { const t = document.createElement("span"); t.className = "typing"; host.appendChild(t); }
    else if (!m.live && c) c.remove();
  };
  if (m.kind === "assistant" || m.kind === "agent_text") {
    if (!m.live) return false;                       // final: full row render adds the choice chips
    const box = el.querySelector(".prose .md"); if (!box) return false;
    box.innerHTML = md(m.text); cursor(box.parentElement); return true;
  }
  if (m.kind === "thinking") {
    const box = el.querySelector(".think-b .md"), n = el.querySelector(".think-count"); if (!box || !n) return false;
    box.textContent = m.text; n.textContent = m.text.length > 60 ? " · " + fmtN(m.text.length) + " chars" : "";
    cursor(box.parentElement); return true;
  }
  if (m.kind === "status") {
    if (m.done) { el.innerHTML = ""; return true; }
    const t = el.querySelector(".status-t"), sec = el.querySelector(".status-secs"); if (!t || !sec) return false;
    const secs = Math.max(0, Math.round((Date.now() - m.ts) / 1000));
    t.textContent = m.text; sec.textContent = secs >= 2 ? secs + "s" : ""; return true;
  }
  return false;
}
function wireMsgHandlers(root) {
  // open/closed is written back onto the message so a later rebuild keeps it
  const persist = (h, cls) => (h.onclick = () => {
    const open = h.parentElement.classList.toggle("open");
    const row = h.closest("[data-mi]"), t = T();
    if (row && t && t.msgs[+row.dataset.mi]) t.msgs[+row.dataset.mi].open = open;
  });
  root.querySelectorAll("[data-tool] .tool-h").forEach((h) => persist(h));
  root.querySelectorAll("[data-think] .think-h").forEach((h) => persist(h));
  /* A click on an option is the user speaking: record it as their message, exactly as
     typing it would, before the turn starts — otherwise the answer vanishes from the thread. */
  root.querySelectorAll("[data-choice]").forEach((b) => (b.onclick = () => { const t = T(); if (t) sendText(t, b.dataset.choice); }));
  root.querySelectorAll("[data-plan]").forEach((b) => (b.onclick = () => {
    const t = T(), row = b.closest("[data-mi]"), m = t && row && t.msgs[+row.dataset.mi];
    if (!m) return;
    if (b.dataset.plan === "approve") {
      m.decided = "Approved — building with edits enabled";
      if (DIALS.perm) DIALS.perm.set("acceptEdits");
      renderStream();
      sendText(t, "Approved. Implement the plan" + (m.file ? " in " + m.file : " above") + " exactly as written, then report what changed.");
    } else { m.decided = "Revising"; renderStream(); const ta = $("#input"); ta.focus(); ta.placeholder = "What should change in the plan?"; }
  }));
  root.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => {
    navigator.clipboard.writeText(b.parentElement.innerText.replace(/^copy\n?/, "")); toast("Copied");
  }));
}
/** Draw only the messages the transcript does not have yet. Appending a row leaves every
 *  existing node untouched; rebuilding the list re-parses all the markdown and re-creates
 *  every sender row, which is seen as the whole thread flashing when a message arrives.
 *  Falls back to a full render whenever the DOM and the model could have drifted. */
function appendRows(t) {
  const box = $("#streamInner");
  const have = box.querySelectorAll("[data-mi]").length;
  if (!t || !t.msgs.length || !have || have >= t.msgs.length) { renderStream(); return; }
  for (let i = have; i < t.msgs.length; i++) {
    const el = document.createElement("div");
    el.className = "mrow";
    el.dataset.mi = i;
    el.innerHTML = renderMsg(t.msgs[i]);
    wireMsgHandlers(el);
    box.appendChild(el);
  }
  renderPhases();
}
function renderStream() {
  const t = T();
  const box = $("#streamInner");
  box.innerHTML = (t && t.msgs.length ? t.msgs.map((m, i) => '<div class="mrow" data-mi="' + i + '">' + renderMsg(m) + "</div>").join("") : "") || startScreen(t);
  wireMsgHandlers(box);
  wireStart(box);
  renderPhases();
}
/** A project is the folder one level below a workspace root, never a container and never a
 *  subfolder: ballers-society/app and ballers-society/assets-src are both "ballers-society". */
function projectRootOf(path) {
  const home = String((S.boot && S.boot.home) || "").replace(/\/+$/, "");
  const GENERIC = ["Desktop", "Documents", "Downloads", "Developer", "Projects", "Code", "dev", "repos", "src", "workspace"];
  const containers = S.roots.concat(GENERIC.map((d) => home + "/" + d), [home])
    .map((d) => String(d).replace(/\/+$/, "")).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (path.indexOf(home + "/.claude") === 0) return null;   // Bridge's own config tree is not a project
  for (const c of containers) {
    if (path === c) return null;                            // the container itself is not a project
    if (path.indexOf(c + "/") === 0) return c + "/" + path.slice(c.length + 1).split("/")[0];
  }
  return path;
}
/** the distinct projects behind the recent sessions, newest first */
function recentProjects(n) {
  const by = new Map();
  for (const s of S.recent) {
    const root = s.projectPath && projectRootOf(s.projectPath);
    if (!root) continue;
    const hit = by.get(root);
    if (hit) { hit.count++; if (s.mtime > hit.mtime) hit.mtime = s.mtime; }
    else by.set(root, { path: root, name: root.split("/").pop(), mtime: s.mtime, count: 1 });
  }
  return [...by.values()].sort((a, b) => b.mtime - a.mtime).slice(0, n || 10);
}
function startScreen(t) {
  const picked = t && t.pick;
  const projects = picked ? [picked] : recentProjects(10);
  const head = picked ? "What are we going to do in " + esc(picked.name) + "?" : "What are we working on?";
  // signed out, there is exactly one thing worth offering — everything below needs the CLI
  if (!authed()) {
    return '<div class="start"><div class="wordmark">BRIDGE</div>' +
      '<p class="start-sub">Bridge drives the real <code>claude</code> CLI on this machine, and it is not signed in yet.</p>' +
      '<div class="start-auth"><h3>Sign in to Claude Code</h3>' +
      "<p>Opens the Claude sign-in page in your browser and finishes right here. No terminal.</p>" +
      '<button class="btn-go" data-signin>Sign in</button></div></div>';
  }
  return '<div class="start"><div class="wordmark">BRIDGE</div>' +
    '<p class="start-sub">Working in <code>' + esc((t && t.path) || (S.boot && S.boot.home) || "") +
    "</code> · the real <code>claude</code> CLI, with your hooks, skills and PAI context intact.</p>" +
    '<button class="start-search" data-find><span>⌕</span><span>Search everything you have ever run…</span><kbd>⌘F</kbd></button>' +
    (projects.length ? '<div class="start-recent"><div class="section-h">' + head + "</div>" +
      '<div class="start-projects' + (picked ? " one" : "") + '">' + projects.map((pr, i) =>
        '<div class="pcard' + (picked ? " on" : "") + '" data-project="' + i + '" title="' +
        esc(picked ? "Click to pick a different project" : pr.path) + '">' +
        '<span class="pc-n">' + esc(pr.name) + "</span>" +
        '<span class="pc-m">' + esc(fmtAgo(pr.mtime)) + " · " + pr.count + (pr.count === 1 ? " session" : " sessions") + "</span>" +
        '<span class="pc-p">' + esc(short(pr.path, 40)) + "</span></div>").join("") + "</div></div>" : "") +
    "</div>";
}
/** Picking a project names the tab after it, points the session at its folder and
 *  collapses the grid to the one card, so the start screen becomes the question. */
async function pickProject(pr) {
  const t = T();
  if (!t) return;
  t.pick = { path: pr.path, name: pr.name, mtime: pr.mtime, count: pr.count };
  t.title = pr.name.charAt(0).toUpperCase() + pr.name.slice(1);
  t.named = true;
  await useFolder(pr.path);
  paint();
  const ta = $("#input");
  if (ta) { ta.placeholder = "What are we going to do in " + pr.name + "?"; ta.focus(); }
}
function wireStart(box) {
  const sb = box.querySelector("[data-signin]");
  if (sb) sb.onclick = () => openSignin();
  const fb = box.querySelector("[data-find]");
  if (fb) fb.onclick = () => openFinder("");
  const t = T();
  const projects = t && t.pick ? [t.pick] : recentProjects(10);
  box.querySelectorAll("[data-project]").forEach((n) => (n.onclick = () => {
    if (t && t.pick) { t.pick = null; paint(); return; }   // clicking the chosen card reopens the grid
    const pr = projects[+n.dataset.project];
    if (pr) pickProject(pr);
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
    id: null, key: null, path: path, name: String(path).split("/").pop() || "~", pick: null,
    title: "New session", msgs: [], usage: null, model: "", branch: "",
    live: null, streaming: false, lastResult: null,
  }, opts || {});
  S.tabs.push(t);
  S.active = S.tabs.length - 1;
  return t;
}
function closeTab(i) {
  const t = S.tabs[i];
  if (!t || t.da) return;
  if (t.streaming) abortTab(t);
  if (t.mirror) { if (!t.mirror.ended) S.dismissed[t.id] = true; stopFollow(t); }
  S.tabs.splice(i, 1);
  if (!S.tabs.some((x) => !x.da)) makeTab();
  else if (S.active >= S.tabs.length) S.active = S.tabs.length - 1;
  else if (S.active > i) S.active--;
  paint();
}
function activate(i) { S.active = i; paint(); scrollDown(true); }
function tabTitle(t) {
  if (t.da) return (S.boot && S.boot.assistant) || "Desk";
  if (t.title && t.title !== "New session") return t.title;
  const first = t.msgs.filter((m) => m.kind === "user")[0];
  return first ? first.text.slice(0, 40) : "New session";
}

/* ─────────────── mirrored terminals ───────────────
 * Every interactive `claude` on this machine registers itself; Bridge shows each one as a
 * tab that follows the transcript as the terminal writes it. Read-only while the terminal
 * lives — typing into it goes through the desk, which relays the message to that session. */
async function syncLive() {
  let r;
  try { r = await (await fetch("/api/live")).json(); } catch (e) { return; }
  S.live = r.sessions || [];
  const seen = {};
  let changed = false;
  for (const s of S.live) {
    seen[s.id] = true;
    if (S.dismissed[s.id]) continue;
    let t = S.tabs.find((x) => x.id === s.id);
    if (!t) {
      const keep = S.active;                 // a terminal opening must not steal the tab you are on
      t = makeTab({ id: s.id, key: s.key, path: s.cwd, title: s.title, named: false });
      t.name = s.folder;
      S.active = keep;
      t.mirror = s;
      changed = true;
      loadMirror(t);
    } else {
      const was = t.mirror;
      t.mirror = Object.assign(t.mirror || {}, s, { ended: false });
      if (!was) { changed = true; if (t.msgs.length && !t.follow) startFollow(t, t.offset || 0); else if (!t.msgs.length) loadMirror(t); }
      else if (was.status !== s.status || (was.waiting && was.waiting.text) !== (s.waiting && s.waiting.text)) changed = true;
      if (s.title && !t.named && t.title !== s.title) { t.title = s.title; changed = true; }
    }
  }
  for (const t of S.tabs) {
    if (t.mirror && !t.mirror.ended && !seen[t.id]) {
      t.mirror.ended = true; t.mirror.status = "ended";
      t.live = t.id;                         // the terminal is gone, so the session is Bridge's to continue
      delete S.dismissed[t.id];
      stopFollow(t); changed = true;
    }
  }
  if (changed) { renderTabs(); renderTop(); if (T() && T().mirror) renderMirrorBar(); }
  if (window.Desk) window.Desk.board();
}
async function loadMirror(t) {
  let r;
  try { r = await (await fetch("/api/session?key=" + encodeURIComponent(t.key) + "&id=" + t.id)).json(); } catch (e) { return; }
  if (r.error) return;
  t.msgs = r.events || []; t.usage = r.meta.usage; t.model = r.meta.model; t.branch = r.meta.branch; t.offset = r.offset || 0;
  if (r.meta.title && !t.named) t.title = r.meta.title;
  if (T() === t) { paint(); scrollDown(true); } else renderTabs();
  if (t.mirror && !t.mirror.ended) startFollow(t, t.offset);
}
function startFollow(t, from) {
  stopFollow(t);
  const es = new EventSource("/api/follow?key=" + encodeURIComponent(t.key) + "&id=" + t.id + "&from=" + (from | 0));
  t.follow = es;
  es.onmessage = (e) => {
    let p; try { p = JSON.parse(e.data); } catch (err) { return; }
    if (p.t !== "events") { if (p.t === "gone") stopFollow(t); return; }
    t.offset = p.offset;
    for (const ev of p.events) t.msgs.push(ev);
    for (const pt of p.patches || []) {
      for (let i = t.msgs.length - 1; i >= 0; i--) {
        const m = t.msgs[i];
        if (m.kind === "tool" && m.id === pt.id) { m.result = pt.result; if (T() === t) { const el = $('#streamInner [data-mi="' + i + '"]'); if (el) { el.innerHTML = renderMsg(m); wireMsgHandlers(el); } } break; }
      }
    }
    if (p.usage) t.usage = accUsage(t.usage, { input_tokens: p.usage.input, output_tokens: p.usage.output, cache_read_input_tokens: p.usage.cacheRead, cache_creation_input_tokens: p.usage.cacheWrite });
    if (p.model) t.model = p.model;
    if (p.events.length && T() === t) { appendRows(t); scrollDown(); renderInspector(); }
  };
  es.onerror = () => { /* EventSource reconnects on its own; a dead file ends with "gone" */ };
}
function stopFollow(t) { if (t.follow) { try { t.follow.close(); } catch (e) {} t.follow = null; } }
/** the bar that stands in for the composer on a live mirror */
function renderMirrorBar() {
  const t = T();
  const el = $("#mirrorBar");
  if (!el) return;
  const on = !!(t && t.mirror && !t.mirror.ended && S.view === "chat");
  el.hidden = !on;
  if (!on) return;
  const m = t.mirror, da = (S.boot && S.boot.assistant) || "the desk";
  const w = m.waiting;
  el.innerHTML = '<span class="mb-dot ' + (m.status === "busy" ? "busy" : w ? "wait" : "") + '"></span>' +
    '<span class="mb-t">Live in your terminal · <b>' + esc(m.name) + "</b> · " + (m.status === "busy" ? "working" : w ? "waiting on you" : "idle") + "</span>" +
    (w ? '<span class="mb-q" title="' + esc(w.text) + '">' + esc(w.text.slice(0, 90)) + "</span>" : "") +
    '<input class="mb-in" id="mirrorIn" placeholder="' + esc(w ? "Answer it — " + da + " relays your reply to the terminal" : "Tell this session something — relayed through " + da) + '" spellcheck="false">' +
    '<button class="chip" data-ask>Ask ' + esc(da) + "</button>";
  const ab = el.querySelector("[data-ask]");
  if (ab) ab.onclick = () => { if (window.Desk) window.Desk.ask("What is the " + m.folder + " session (" + m.name + ") doing right now, and does it need anything from me?"); };
  const inp = el.querySelector("#mirrorIn");
  if (inp) inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && inp.value.trim() && window.Desk) { window.Desk.relay(m, inp.value.trim()); inp.value = ""; }
  };
}
/** Rename a session. The name lives in Bridge's sidecar, never in Claude Code's transcript,
 *  so it survives resume and compaction. Sessions with no id yet are renamed locally only. */
function beginRename(i) {
  if (S.tabs[i]) { S.editingTab = i; renderTabs(); }
}
async function commitRename(i, value) {
  const t = S.tabs[i];
  S.editingTab = null;
  if (!t) { paint(); return; }
  const name = String(value == null ? "" : value).trim();
  const was = t.title;
  t.title = name || "New session";
  t.named = !!name;
  paint();
  if (was === t.title) return;
  if (t.id) {
    await fetch("/api/rename", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: t.id, title: name }) });
    const hit = S.recent.find((x) => x.id === t.id); if (hit) hit.title = t.title;
    const ses = S.sessions && S.sessions.find((x) => x.id === t.id); if (ses) ses.title = t.title;
  }
  toast(name ? "Renamed" : "Name cleared");
}

function renderTabs() {
  const editing = S.editingTab;
  const live = $("#tabs .tab-edit");
  if (live && document.activeElement === live && +live.dataset.edit === editing) return;  // never clobber the open field
  $("#tabs").innerHTML = S.tabs.map((t, i) => {
    const m = t.mirror;
    const busy = t.streaming || (m && !m.ended && m.status === "busy");
    const wait = m && !m.ended && m.waiting;
    const tip = m ? (m.ended ? "This terminal has closed — the session is yours to continue here" : "Live in your terminal (" + m.name + ") · " + (m.status === "busy" ? "working" : wait ? "waiting on you" : "idle")) : esc(t.path || "") + " · double-click the title to rename";
    return '<div class="tab ' + (i === S.active ? "on" : "") + (m ? " mirror" : "") + (m && m.ended ? " ended" : "") + '" data-tab="' + i + '" title="' + esc(tip) + '">' +
      (m ? '<span class="tab-term" title="terminal">▮</span>' : "") +
      (busy ? '<span class="tab-live"></span>' : wait ? '<span class="tab-wait" title="waiting on you">⏳</span>' : "") +
      (i === editing
        ? '<input class="tab-edit" data-edit="' + i + '" value="' + esc(tabTitle(t)) + '" spellcheck="false">'
        : '<span class="tab-t">' + esc(tabTitle(t)) + "</span>") +
      '<span class="tab-x" data-close="' + i + '">×</span></div>';
  }).join("");
  /* Double-click is detected by hand: the first click repaints and replaces every
     tab node, so a native dblclick lands on #tabs, never on the tab itself. */
  $("#tabs").querySelectorAll("[data-tab]").forEach((n) => (n.onclick = (e) => {
    if (e.target.dataset.close !== undefined) { e.stopPropagation(); closeTab(+e.target.dataset.close); return; }
    const i = +n.dataset.tab, now = Date.now();
    if (S.lastTabClick && S.lastTabClick.i === i && now - S.lastTabClick.ts < 450) {
      S.lastTabClick = null; e.preventDefault(); beginRename(i); return;
    }
    S.lastTabClick = { i: i, ts: now };
    activate(i);
  }));
  const inp = $("#tabs .tab-edit");
  if (inp) {
    inp.onclick = (e) => e.stopPropagation();
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commitRename(+inp.dataset.edit, inp.value); }
      else if (e.key === "Escape") { e.preventDefault(); S.editingTab = null; inp.onblur = null; paint(); }
    };
    inp.onblur = () => { if (S.editingTab !== null) commitRename(+inp.dataset.edit, inp.value); };
    inp.focus(); inp.select();
  }
  const at = $("#tabs .tab.on");
  if (at && editing === null) at.scrollIntoView({ block: "nearest", inline: "nearest" });
}
const unread = () => S.notes.filter((x) => !x.read).length;
function saveNotes() { try { localStorage.bridgeNotes = JSON.stringify(S.notes.slice(0, 60)); } catch (e) {} }
function loadNotes() { try { S.notes = JSON.parse(localStorage.bridgeNotes || "[]"); } catch (e) { S.notes = []; } }
function note(tab, kind, detail) {
  noteRaw({ id: tab.id || tab.live, key: tab.key, path: tab.path, title: tabTitle(tab), kind: kind, detail: detail || "" });
}
/** kinds: done · error · waiting (a session is asking you something) · started · ended */
function noteRaw(x) {
  S.notes.unshift(Object.assign({ ts: Date.now(), read: false }, x));
  S.notes = S.notes.slice(0, 60);
  saveNotes();
  renderBell();
}
const NOTE_LABEL = { done: "finished", error: "failed", waiting: "needs you", started: "terminal opened", ended: "terminal closed" };
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
      '<div class="note-m">' + (NOTE_LABEL[x.kind] || x.kind) + (x.detail ? " · " + esc(x.detail) : "") +
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
  S.view = "chat";                                  // a session always opens in Work sessions, wherever it was clicked
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
/** the working-folder menu — anchored to whichever folder button was clicked */
function pickCwd(ev) {
  closeFolderMenu();
  const anchor = ev && ev.currentTarget ? ev.currentTarget : $("#cwdChip");
  const cur = (T() && T().path) || S.cwd || "";
  const recent = S.recent.map((r) => r.projectPath).filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i && S.roots.indexOf(d) < 0).slice(0, 8);
  const row = (d, ic, act) => '<div class="fmenu-i ' + (d === cur ? "cur" : "") + (act ? " act" : "") + '" data-dir="' + esc(d) + '" title="' + esc(d) + '">' +
    '<span class="fm-ic">' + ic + '</span><span class="fm-n">' + esc(d.split("/").pop() || d) + '</span><span class="fm-p">' + esc(short(d, 48)) + "</span></div>";
  const m = document.createElement("div");
  m.className = "fmenu"; m.id = "fmenu";
  m.innerHTML = '<div class="fmenu-h">Working folder — where Claude Code reads, writes and runs</div>' +
    (S.roots.length ? '<div class="fmenu-h">Your folders</div>' + S.roots.map((d) => row(d, "⌂")).join("") : "") +
    (recent.length ? '<div class="fmenu-h">Recent sessions</div>' + recent.map((d) => row(d, "◷")).join("") : "") +
    '<div class="fmenu-sep"></div><div class="fmenu-i act" data-choose><span class="fm-ic">＋</span><span class="fm-n">Choose another folder…</span>' +
    '<span class="fm-p">' + (document.documentElement.dataset.native ? "opens a Finder picker" : "type a path") + "</span></div>";
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), W = m.offsetWidth, H = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - W - 8)) + "px";
  if (r.bottom + H + 8 > innerHeight) m.style.top = Math.max(8, r.top - H - 6) + "px";
  else m.style.top = (r.bottom + 6) + "px";
  m.querySelectorAll("[data-dir]").forEach((n) => (n.onclick = () => { closeFolderMenu(); useFolder(n.dataset.dir); }));
  m.querySelector("[data-choose]").onclick = () => { closeFolderMenu(); chooseFolder(cur); };
  m.onclick = (e) => e.stopPropagation();
  setTimeout(() => {
    document.addEventListener("click", closeFolderMenu, { once: true });
    document.addEventListener("keydown", escFolderMenu);
  }, 0);
}
function closeFolderMenu() { const m = $("#fmenu"); if (m) m.remove(); document.removeEventListener("keydown", escFolderMenu); }
function escFolderMenu(e) { if (e.key === "Escape") closeFolderMenu(); }
/** native Finder picker inside the app, a typed path in a plain browser */
function chooseFolder(start) {
  const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickFolder;
  if (wk) { wk.postMessage(start || ""); return; }
  const v = prompt("Folder Claude Code should work in:", start || "");
  if (v && v.trim()) useFolder(v.trim());
}
window.bridgeFolderPicked = (p) => useFolder(p);
/** make sure Bridge is allowed to read the folder, then point the session at it */
async function useFolder(path) {
  path = String(path || "").replace(/\/+$/, "");
  if (!path) return;
  const inside = S.roots.some((r) => path === r || path.indexOf(r + "/") === 0);
  if (!inside) await setRoots(S.roots.concat([path]));   // the server refuses a cwd outside its roots
  setCwd(path);
  toast("Working in " + (path.split("/").pop() || path));
}

/** point the current session at a directory */
function setCwd(path) {
  S.cwd = path;
  localStorage.bridgeCwd = path;
  const t = T();
  if (t && !t.da && !t.msgs.length && !t.id) { t.path = path; t.name = path.split("/").pop(); }
  else makeTab({ path: path });
  goChat();
}

/* ───────────────────────────── views ──────────────────────────── */
const GROUPS = ["Core", "Memory", "Skills"];
const RAIL = [
  { id: "copilot", label: "Copilot", icon: "" },
  { id: "chat", label: "Work sessions", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  { id: "activity", label: "Activity", icon: "M3 12h4l3 8 4-16 3 8h4" },
  { id: "agents", label: "Agents", icon: "M12 2a5 5 0 0 1 5 5v2a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" },
  { id: "files", label: "Directory", icon: "M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
  { id: "configs", label: "Configs", icon: "M6 2h9l5 5v15H6zM15 2v5h5M9 12h7M9 16h7" },
];
const railOn = (id) => S.view === id;
function renderRail() {
  const deskPhase = (window.Desk && window.Desk.phase()) || "idle";
  $("#rail").innerHTML = '<button class="logo" id="railHome" title="Back to the conversation"><span>B</span></button>' + RAIL.map((r) =>
    r.id === "copilot"
      ? '<button class="rail-btn copilot ' + (railOn(r.id) ? "on" : "") + ' ph-' + deskPhase + '" data-view="copilot"><span class="rail-orb"></span>' +
        '<span class="tip">' + esc((S.boot && S.boot.assistant) || "Copilot") + " — Copilot</span></button>"
      : '<button class="rail-btn ' + (railOn(r.id) ? "on" : "") + '" data-view="' + r.id + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="' + r.icon + '"/></svg>' +
        '<span class="tip">' + r.label + "</span></button>").join("") +
    '<div class="rail-spacer"></div>' +
    '<button class="rail-btn ' + (authed() ? "in" : "") + '" id="railAuth">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 2a5 5 0 0 1 5 5v1a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>' +
    '<span class="dot"></span><span class="tip">' +
    (authed() ? esc((S.auth && S.auth.email) || "Signed in") : "Not signed in — click to sign in") + "</span></button>" +
    '<button class="rail-btn" id="railTheme"><span class="theme-ic" id="themeIc"></span><span class="tip">Theme (⌘J)</span></button>';
  $("#rail").querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => go(b.dataset.view)));
  $("#railHome").onclick = goChat;
  $("#railAuth").onclick = () => openSignin();
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
  const t = T();
  const desk = S.view === "copilot";
  const mirror = isChat && !!(t && t.mirror && !t.mirror.ended);
  $("#streamInner").classList.toggle("wide", !isChat);
  $("#streamInner").classList.toggle("editing", !!(open && open.editing));
  $("#composerWrap").style.display = isChat && !mirror ? "" : "none";
  $("#tabbar").style.display = isChat ? "" : "none";
  $("#desk").hidden = !desk;
  $("#stream").style.display = desk ? "none" : "";
  renderMirrorBar();
  if (window.Desk) window.Desk.shown(desk);
  const box = $("#streamInner");
  if (desk) return;
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
  const label = S.view === "files" ? (S.dir ? S.dir.path.split("/").pop() : "Directory") : S.view === "agents" ? "Agents" : S.view === "activity" ? "Activity" : S.view === "copilot" ? "Copilot" : "Configs";
  const crumb = $("#crumbTitle");
  crumb.textContent = chat ? (t ? tabTitle(t) : "Bridge") : c ? c.title : label;
  crumb.title = chat && t ? "Double-click to rename this session" : "";
  crumb.classList.toggle("renamable", chat && !!t);
  crumb.ondblclick = chat && t ? () => beginRename(S.active) : null;
  const cp = $("#crumbPath");
  if (S.view === "copilot") {
    cp.innerHTML = '<span class="cwd-lab">' + (S.live.length ? S.live.length + (S.live.length === 1 ? " terminal session live" : " terminal sessions live") : "no terminal sessions open") + "</span>";
  } else if (chat && t && t.mirror && !t.mirror.ended) {
    cp.innerHTML = '<span class="cwd-lab">Terminal session</span> <span class="cwd-pick" style="cursor:default">' + esc(short(t.path, 40)) + "</span>";
  } else if (chat && t) {
    cp.innerHTML = '<span class="cwd-lab">Working directory:</span> <button class="cwd-pick caret-r" title="Working directory — the folder Claude Code runs in for this session. Click to change it.">' +
      esc(short(t.path, 40)) + "</button>";
    const btn = cp.querySelector(".cwd-pick");
    if (btn) btn.onclick = pickCwd;
  } else {
    cp.textContent = c ? short(c.path, 44) : S.view === "files" && S.dir ? short(S.dir.path, 44) : "";
  }
  $("#cwdChip").textContent = "⌂ " + (t ? t.name : "~");
  $("#cwdChip").classList.add("caret-r");
  $("#cwdChip").title = "Working directory — the folder Claude Code runs in for this session. Click to change it.";
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

/** The live turn state: a pulsing dot and a label above the composer, replacing the row of
 *  empty thinking cards that used to march down the transcript while a turn ran. */
function renderTurnState() {
  const el = $("#turnState");
  if (!el) return;
  const t = T();
  const s = t && S.view === "chat" ? t.msgs.filter((m) => m.kind === "status" && !m.done).pop() : null;
  if (!s) { el.hidden = true; el.innerHTML = ""; return; }
  const secs = Math.max(0, Math.round((Date.now() - s.ts) / 1000));
  el.hidden = false;
  el.innerHTML = '<span class="ts-dot"></span><span class="ts-t">' + esc(s.text) + "</span>" +
    (secs >= 2 ? '<span class="ts-s">' + secs + "s</span>" : "");
}
function paint() { renderRail(); renderTabs(); renderPanel(); renderMain(); renderTop(); renderInspector(); sendBtn(); renderTurnState(); }

/* ─────────────────────────── actions ──────────────────────────── */

async function addRoot() {
  const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickFolder;
  if (wk) { window.bridgeFolderPicked = async (p) => { await setRoots(S.roots.concat([String(p).replace(/\/+$/, "")])); window.bridgeFolderPicked = useFolder; }; wk.postMessage(S.roots[0] || ""); return; }
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
  if (railOn(view) && view !== "copilot") return goChat();
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
/* composer attachments — top level: send() calls renderAttachments() */
function renderAttachments() {
  const box = $("#attachments");
  if (!S.attachments.length) { box.innerHTML = ""; box.style.display = "none"; return; }
  box.style.display = "flex";
  box.innerHTML = S.attachments.map((a, i) =>
    '<div class="att ' + (a.error ? "err" : "") + '" title="' + esc(a.name) + (a.error ? "\n" + a.error : "") + '" data-i="' + i + '">' +
    (a.preview ? '<img src="' + esc(a.preview) + '">' : '<span class="att-ic">' + esc(a.ext || "📄") + "</span>") +
    '<span class="att-n">' + esc(a.name) + "</span>" +
    (a.error ? '<span class="att-e">' + esc(a.error) + "</span>" : "") +
    '<span class="att-x" data-rm="' + i + '">×</span></div>').join("");
  box.querySelectorAll("[data-rm]").forEach((n) => (n.onclick = (e) => { e.stopPropagation(); S.attachments.splice(+n.dataset.rm, 1); renderAttachments(); }));
}
async function addFiles(files) {
  for (const f of files) await addAttachment({ name: f.name, ext: (f.name.split(".").pop() || "").toLowerCase(), file: f });
}
async function addAttachment(a) {
  if (S.attachments.some((x) => x.name === a.name && x.path === a.path)) return;
  if (a.file && a.ext && ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(a.ext)) {
    a.preview = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(a.file);
    });
    const m = a.preview.match(/^data:([^;]+);base64,(.+)$/);
    if (m) { a.kind = "image"; a.mediaType = m[1]; a.data = m[2]; }
  } else if (a.file) {
    a.preview = "";
    if (a.file.size > 200_000) { a.error = "too large to inline (" + fmtB(a.file.size) + ")"; }
    else { a.data = await a.file.text(); a.kind = "text"; }
  }
  if (!a.error && !a.kind) a.error = "unreadable attachment";
  S.attachments.push(a);
  renderAttachments();
  const ta2 = $("#input"); ta2.focus(); if (!ta2.value.trim()) ta2.placeholder = S.attachments.length + " file" + (S.attachments.length > 1 ? "s" : "") + " attached — type a message or press ↵";
}

/** Send `text` as the user's own message on `tab` — the shared path for typed input,
 *  clicked options and plan decisions, so every one of them shows up in the thread. */
function sendText(tab, text) {
  if (!tab || !String(text || "").trim()) return;
  const msg = { kind: "user", text: String(text).trim(), ts: Date.now() };
  tab.msgs.push(msg);
  if (tab.streaming) {
    msg.queued = true;
    (tab.queue = tab.queue || []).push(msg);
    if (T() === tab) { appendRows(tab); scrollDown(true); }
    return;
  }
  if (T() === tab) { appendRows(tab); scrollDown(true); }
  runTurn(tab, msg.text, []);
}

async function send() {
  const ta = $("#input");
  const text = ta.value.trim();
  const tab = T();
  const ats = S.attachments;
  if ((!text && !ats.length) || !tab) return;
  // nothing can run signed out; keep what was typed and ask for the sign-in instead
  if (!authed()) { await refreshAuth(true); paint(); if (!authed()) { openSignin("Sign in first — Claude Code has no account on this machine yet."); return; } }
  ta.value = ""; ta.style.height = "auto";
  const msg = { kind: "user", text: text, ultra: !!(window.BridgeEffort && window.BridgeEffort.ultra), attachments: ats.map((a) => ({ name: a.name, path: a.path, kind: a.kind, mediaType: a.mediaType, data: a.data, error: a.error })), ts: Date.now() };
  S.attachments = []; renderAttachments();
  tab.msgs.push(msg);
  // a turn already running is no reason to stop typing: queue it, same as the terminal
  if (tab.streaming) {
    msg.queued = true;
    (tab.queue = tab.queue || []).push(msg);
    if (T() === tab) { appendRows(tab); scrollDown(true); }
    return;
  }
  runTurn(tab, text, msg.attachments);
}
async function runTurn(tab, text, attachments) {
  tab.streaming = true;
  // Show a thinking row immediately — the CLI can take a long time (hooks, session
  // start) before its first byte, and silence reads as "nothing happened".
  const statusIdx = tab.msgs.push({ kind: "status", text: "Thinking", ts: Date.now(), live: true }) - 1;
  const status = tab.msgs[statusIdx];
  if (T() === tab) appendRows(tab);
  renderTabs(); sendBtn(); scrollDown(true);

  const ultra = !!(window.BridgeEffort && window.BridgeEffort.ultra);
  const planning = $("#selPerm").value === "plan";
  let planFile = null;
  const body = {
    prompt: (ultra ? "ultracode " : "") + text, cwd: tab.path,   // the keyword switches on multi-agent orchestration in the CLI
    resume: tab.live || tab.id || null,
    model: $("#selModel").value || null,
    permissionMode: $("#selPerm").value,
    effort: $("#selEffort").value || null,
    agent: $("#selAgent").value || null,
    attachments: attachments || [],
  };
  let blocks = {};
  // Text/thinking deltas only touch one message, so update that row in place
  // instead of rebuilding the transcript — this is what makes streaming smooth.
  const dirty = new Set();
  let deltaQueued = false;
  const flushDelta = (idx) => {
    if (T() !== tab) return;
    dirty.add(idx);
    if (deltaQueued) return;
    deltaQueued = true;
    requestAnimationFrame(() => {
      deltaQueued = false;
      if (T() !== tab) { dirty.clear(); return; }
      let miss = false;
      for (const i of dirty) {
        const box = $("#streamInner"), m = tab.msgs[i];
        let el = box.querySelector('[data-mi="' + i + '"]');
        if (!el && m && box.querySelectorAll("[data-mi]").length === i) {
          // a brand-new message at the end: append its row instead of rebuilding everything
          el = document.createElement("div"); el.className = "mrow"; el.dataset.mi = i;
          el.innerHTML = renderMsg(m); wireMsgHandlers(el); box.appendChild(el); continue;
        }
        if (!el || !m) { miss = true; continue; }
        if (!patchRow(el, m)) { el.innerHTML = renderMsg(m); wireMsgHandlers(el); }
      }
      dirty.clear();
      if (miss) renderStream();
      renderTurnState();
      scrollDown();
    });
  };
  const setStatus = (txt) => { if (status.done) return; status.text = txt; flushDelta(statusIdx); };
  const endStatus = () => { if (status.done) return; status.done = true; clearInterval(tick); flushDelta(statusIdx); };
  const tick = setInterval(() => { if (status.done) clearInterval(tick); else flushDelta(statusIdx); }, 1000);

  function onEvent(p) {
    if (p.t === "start") { tab.live = tab.live || p.sessionId; setStatus("Starting Claude Code"); return; }
    if (p.t === "auth") {                    // the CLI is signed out — the turn never started
      S.auth = p.d || S.auth; endStatus(); paint();
      openSignin("Claude Code is not signed in, so that message did not run. Sign in and send it again.");
      return;
    }
    if (p.t === "stderr") {
      const line = String(p.d).trim();
      if (line && !/hook|deprecat|warning/i.test(line)) { tab.msgs.push({ kind: "assistant", text: "```\n" + line + "\n```", ts: Date.now() }); flushDelta(tab.msgs.length - 1); }
      return;
    }
    if (p.t === "ping") return;                 // heartbeat: keeps a long fan-out from timing out
    if (p.t === "end" || p.t === "error" || p.t === "raw") return;
    const d = p.d;
    if (!d || !d.type) return;

    if (d.type === "system" && d.subtype === "init") {
      tab.live = d.session_id || tab.live;
      tab.id = tab.id || tab.live;
      tab.model = d.model || tab.model;
      setStatus("Thinking");
      return;
    }
    if (d.type === "system" && d.subtype === "hook_started") { setStatus("Running " + (d.hook_name || "hook")); return; }
    if (d.type === "system" && d.subtype === "hook_response") { setStatus(planning ? "Planning" : "Thinking"); return; }
    if (d.type === "stream_event") {
      const ev = d.event, side = !!d.parent_tool_use_id;
      if (!ev) return;
      if (ev.type === "message_start") { blocks = {}; setStatus("Composing"); return; }
      if (ev.type === "content_block_start") {
        endStatus();
        const cb = ev.content_block || {};
        if (cb.type === "text") blocks[ev.index] = tab.msgs.push({ kind: side ? "agent_text" : "assistant", text: "", ts: Date.now(), live: true, model: tab.model }) - 1;
        else if (cb.type === "thinking") blocks[ev.index] = tab.msgs.push({ kind: "thinking", text: "", ts: Date.now(), live: true, open: true, side: side }) - 1;
        // Blocks we do not render (tool_use, server_tool_use, redacted_thinking) push no
        // message, so there is nothing new to draw. Rebuilding the whole transcript here is
        // what made earlier messages and their sender rows flash on every tool call.
        if (blocks[ev.index] !== undefined) flushDelta(blocks[ev.index]);
      } else if (ev.type === "content_block_delta") {
        const idx = blocks[ev.index];
        if (idx === undefined) return;
        const m = tab.msgs[idx];
        if (ev.delta.type === "text_delta") m.text += ev.delta.text;
        else if (ev.delta.type === "thinking_delta") m.text += ev.delta.thinking;
        else return;
        flushDelta(idx);
      } else if (ev.type === "content_block_stop") {
        const idx = blocks[ev.index];
        if (idx !== undefined) {
          tab.msgs[idx].live = false;
          flushDelta(idx);
        }
      }
      return;
    }
    if (d.type === "assistant") {
      if (tab.flow && !tab.flow.done && tab.lastResult) tab.flow.done = true;   // the report is landing
      endStatus();
      const side = !!d.parent_tool_use_id;
      const streamed = Object.keys(blocks).length > 0;
      ((d.message && d.message.content) || []).forEach((c) => {
        if (c.type === "tool_use") {
          if (c.name === "Write" && c.input && /\/Plans\/[^/]+\.md$/.test(String(c.input.file_path || ""))) planFile = c.input.file_path;
          // A workflow returns a task id in milliseconds and then the turn goes quiet for as
          // long as the agents run. Track it so the wait reads as work, not as a hang.
          if (c.name === "Workflow") tab.flow = { at: Date.now(), id: null, name: (c.input && c.input.name) || "", done: false };
          flushDelta(tab.msgs.push({ kind: "tool", name: c.name, input: c.input, id: c.id, ts: Date.now(), side: side, result: null }) - 1);
        }
        else if (c.type === "text" && !streamed && c.text && c.text.trim())
          flushDelta(tab.msgs.push({ kind: side ? "agent_text" : "assistant", text: c.text, ts: Date.now(), model: d.message.model }) - 1);
      });
      tab.usage = accUsage(tab.usage, d.message && d.message.usage);
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
            if (m.name === "Workflow" && tab.flow) {
              const idm = /Task ID:\s*(\S+)/.exec(m.result.content || "");
              const sm = /Summary:\s*(.+)/.exec(m.result.content || "");
              if (idm) tab.flow.id = idm[1];
              if (sm) tab.flow.summary = sm[1].trim();
              if (m.result.isError) tab.flow.done = true;
            }
            flushDelta(i);
            break;
          }
        }
      });
      return;
    }
    if (d.type === "result") {
      tab.lastResult = { total_cost_usd: d.total_cost_usd, duration_ms: d.duration_ms, turns: d.num_turns };
      // `claude -p` stays alive past this result to report a workflow back, so the turn is only
      // over when the process closes. Until then, say what is being waited on.
      if (tab.flow && !tab.flow.done) setStatus("Workflow running" + (tab.flow.name ? " · " + tab.flow.name : "") + " — agents are working");
      if (T() === tab) { renderTop(); renderInspector(); }
      refreshSessions();
    }
  }

  // AUTO resolves here, one message before the turn: the pick is shown, kept on the tab so the
  // next message can stay with it, and sent as the agent for this turn only.
  if (body.agent === "auto") {
    setStatus("Choosing an agent");
    let r = { agent: "" };
    try {
      r = await (await fetch("/api/route", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text, previous: tab.agent || "" }) })).json();
    } catch (e) {}
    body.agent = r.agent || null;
    tab.agent = r.agent || "";
    tab.route = r;
    const um = tab.msgs.filter((m) => m.kind === "user").pop();
    if (um) { um.routedTo = r.agent || ""; flushDelta(tab.msgs.indexOf(um)); }
    setStatus(r.agent ? "Handing this to " + r.agent : "Thinking");
    if (T() === tab) renderTop();
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
  endStatus();
  tab.streaming = false;
  tab.msgs.forEach((m, i) => { if (m.live) { m.live = false; flushDelta(i); } });
  if (planning) {
    // the plan is the last assistant text with a "Plan" heading (or whatever was written to Plans/)
    const last = tab.msgs.filter((m) => m.kind === "assistant").pop();
    const planText = last && /^#{1,4}\s*\**Plan/m.test(last.text) ? last.text.slice(last.text.search(/^#{1,4}\s*\**Plan/m)) : null;
    if (planText || planFile) flushDelta(tab.msgs.push({ kind: "plan", text: planText || "Plan written to `" + planFile + "`.", file: planFile, ts: Date.now() }) - 1);
  }
  sendBtn(); renderTabs(); if (T() === tab) renderPhases();
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
    return runTurn(tab, next.text, next.attachments || []);
  }
}
/* ── segmented dial: folded to the chosen rung, unfolds as an overlay ──
   Generic; the hidden <select> stays in sync so older code reading .value
   keeps working. Effort and Guardrails are both instances of it. */
function makeDial(o) {
  const dial = $(o.dial), track = $(o.track), sel = $(o.select), thumb = track.querySelector(".ed-thumb");
  let closeT = 0;
  let cur = localStorage[o.key];
  if (!o.tiers.some((t) => t.v === cur)) cur = o.initial;
  track.querySelectorAll(".ed-p,.ed-h").forEach((n) => n.remove());
  if (o.name) { const h = document.createElement("span"); h.className = "ed-h"; h.textContent = o.name; track.appendChild(h); }
  o.tiers.forEach((t) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ed-p" + (t.cls ? " " + t.cls : ""); b.dataset.v = t.v; b.setAttribute("role", "radio");
    b.title = t.title || (t.label + ": " + (t.help || ""));
    b.innerHTML = esc(t.label) + (t.extra || "") + (t.help ? '<span class="ed-help">' + esc(t.help) + "</span>" : "");
    // a click is a decision: choose and fold at once, no waiting for the pointer to leave
    b.onclick = () => { choose(t.v, true); clearTimeout(closeT); setOpen(false); };
    track.appendChild(b);
  });
  const place = () => {
    if (!dial.classList.contains("open")) { dial.style.minWidth = ""; dial.style.minWidth = dial.offsetWidth + "px"; }
    const b = track.querySelector('.ed-p[data-v="' + CSS.escape(cur) + '"]');
    if (!b || !b.offsetWidth) return;
    thumb.style.left = b.offsetLeft + "px"; thumb.style.top = b.offsetTop + "px";
    thumb.style.width = b.offsetWidth + "px"; thumb.style.height = b.offsetHeight + "px";
  };
  // place() runs synchronously (forces layout with the new class) and again next frame
  const setOpen = (on) => {
    if (dial.classList.contains("open") === on) return;
    dial.classList.add("snap");                 // no slide between folded and open geometry
    dial.classList.toggle("open", on); place();
    // keep transitions off until the frame after the ladder has fully laid out
    requestAnimationFrame(() => { place(); requestAnimationFrame(() => dial.classList.remove("snap")); });
  };
  // hover intent: crossing the gap between chip and ladder must not close it
  const openSoon = () => { clearTimeout(closeT); setOpen(true); };
  const closeSoon = () => { clearTimeout(closeT); closeT = setTimeout(() => setOpen(false), 220); };
  const choose = (v, byUser) => {
    const was = cur; cur = v;
    localStorage[o.key] = v;
    sel.value = o.toSelect ? o.toSelect(v) : v;
    sel.dispatchEvent(new Event("change"));
    track.querySelectorAll(".ed-p").forEach((b) => b.setAttribute("aria-checked", b.dataset.v === cur ? "true" : "false"));
    if (o.onChoose) o.onChoose(v, was, byUser);
    requestAnimationFrame(place);
  };
  if (o.ascending) dial.classList.add("asc");
  dial.onkeydown = (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = o.tiers.findIndex((t) => t.v === cur), j = Math.max(0, Math.min(o.tiers.length - 1, i + step));
    choose(o.tiers[j].v, true);
    const b = track.querySelector('.ed-p[data-v="' + CSS.escape(o.tiers[j].v) + '"]'); if (b) b.focus();
  };
  addEventListener("resize", place);
  dial.addEventListener("pointerenter", openSoon);
  dial.addEventListener("pointerleave", closeSoon);
  dial.addEventListener("focusin", openSoon);
  dial.addEventListener("focusout", (e) => { if (!dial.contains(e.relatedTarget)) closeSoon(); });
  choose(cur, false);
  return { get value() { return cur; }, set: (v) => choose(v, false), dial };
}

/* effort: auto … max, then ULTRACODE "God mode" (max + the multi-agent keyword) */
function initEffortDial(efforts) {
  const tiers = efforts.map((e) => ({ v: e, label: e === "" ? "auto" : e === "medium" ? "med" : e, help: HELP.effort[e] }))
    .concat([{ v: "ultracode", label: "ULTRA", cls: "ultra", extra: '<span class="ed-god">· GOD MODE</span>', help: "max + a team of agents", title: "ULTRACODE — God mode: " + HELP.effort.ultracode }]);
  const d = makeDial({
    name: "Effort — how long it thinks", ascending: true, dial: "#labEffort", track: "#edTrack", select: "#selEffort", key: "bridgeEffort", initial: "", tiers,
    toSelect: (v) => (v === "ultracode" ? "max" : v),
    onChoose: (v, was, byUser) => {
      const god = v === "ultracode";
      $("#labEffort").classList.toggle("god", god);
      $("#composer").classList.toggle("god", god);
      $("#btnSend").classList.toggle("god", god);
      if (byUser && god && was !== "ultracode" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const w = document.createElement("span"); w.className = "ed-wave"; $("#labEffort").appendChild(w);
        w.addEventListener("animationend", () => w.remove());
        toast("God mode armed — every message runs as a team of agents");
      }
    },
  });
  window.BridgeEffort = { get value() { return d.value === "ultracode" ? "max" : d.value; }, get ultra() { return d.value === "ultracode"; } };
}

/* model: default + whatever the CLI reports */
function initModelDial(models) {
  const tiers = [{ v: "", label: "default", help: HELP.model[""] }].concat(models.map((m) => ({ v: m, label: m, help: HELP.model[m] || "" })));
  makeDial({ name: "Model — which Claude answers", dial: "#labModel", track: "#modelTrack", select: "#selModel", key: "bridgeModel", initial: "", tiers });
}
/* agent: none + your custom agents, description as the help line */
function initAgentDial(agents) {
  const tiers = [{ v: "", label: "none", help: "plain Claude Code" }]
    .concat(agents.map((a) => ({ v: a.name, label: a.name, help: a.description ? String(a.description).replace(/\s+/g, " ").slice(0, 70) : "" })));
  // AUTO leads and is the default: the agent is chosen per message from what you actually
  // wrote, and changes as the work changes, instead of staying pinned wherever you left it.
  tiers.unshift({ v: "auto", label: "AUTO", cls: "auto", help: "Bridge picks the agent for each message" });
  // one-time move to AUTO: a stored "" is the old default, not a choice anyone made
  if (!localStorage.bridgeAgentV2) {
    if (!localStorage.bridgeAgent) localStorage.bridgeAgent = "auto";
    localStorage.bridgeAgentV2 = "1";
  }
  makeDial({ name: "Agent — run as a custom agent", dial: "#labAgent", track: "#agentTrack", select: "#selAgent", key: "bridgeAgent", initial: "auto", tiers });
}
/* guardrails: four rungs in plain words, mapped onto the CLI's permission modes */
const GUARDRAILS = [
  { v: "plan", label: "plan", help: "read-only, proposes a plan" },
  { v: "manual", label: "ask first", help: "asks before every edit and command" },
  { v: "acceptEdits", label: "edit freely", help: "edits alone, asks before commands" },
  { v: "bypassPermissions", label: "no limits", cls: "danger", help: "never asks, runs everything" },
];
const DIALS = {};
function initPermDial(modes) {
  const tiers = GUARDRAILS.filter((g) => modes.indexOf(g.v) >= 0);
  DIALS.perm = makeDial({
    name: "Mode — what it may do without asking", ascending: true, dial: "#labPerm", track: "#permTrack", select: "#selPerm", key: "bridgePerm", initial: "acceptEdits", tiers,
    onChoose: (v) => $("#labPerm").classList.toggle("danger", v === "bypassPermissions"),
  });
}
function sendBtn() {
  // Send never turns into Stop: a running turn is no reason to stop typing, the
  // message just queues. Cancelling is a separate, quieter control on the left.
  const t = T(), on = !!(t && t.streaming);
  $("#btnCancel").hidden = !on;
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
/** Search starts where you are working. "folder" covers this session's directory and everything
 *  under it; when that finds nothing the search widens to every project on its own, so a miss in
 *  the near scope never costs a second query. */
let findScope = "folder", findSeq = 0;
const findCwd = () => (T() && T().path) || S.cwd || "";
function openFinder(seed) {
  $("#finder").classList.add("on");
  const seg = $("#segFolder");
  const name = String(findCwd()).split("/").pop();
  if (seg) { seg.textContent = name ? "In " + name : "This folder"; seg.title = findCwd(); }
  const inp = $("#finderInput");
  if (seed !== undefined) inp.value = seed;
  inp.focus(); inp.select();
  runFind();
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
    body.innerHTML = '<div class="finder-empty">Say what you are after in your own words. Bridge searches the folder you are working in first, then everywhere else if nothing matches — reading whole transcripts, not just titles.</div>';
    $("#finderNote").textContent = "Type a few words and press ↵";
    return;
  }
  const seq = ++findSeq;
  $("#finderSpin").style.display = "";
  const hit = async (scope) => {
    const url = "/api/find?q=" + encodeURIComponent(q) + "&scope=" + scope +
      "&cwd=" + encodeURIComponent(findCwd()) +
      (T() && T().key ? "&key=" + encodeURIComponent(T().key) : "");
    try { return await (await fetch(url)).json(); } catch (e) { return []; }
  };
  let res = await hit(findScope), widened = false;
  if (!res.length && findScope !== "all") { res = await hit("all"); widened = res.length > 0; }
  if (seq !== findSeq) return;
  $("#finderSpin").style.display = "none";
  const terms = q.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 2);
  const here = String(findCwd()).split("/").pop() || "this folder";
  $("#finderNote").textContent = widened
    ? "Nothing in " + here + " — " + res.length + " matches everywhere else"
    : res.length + " sessions match, best first";
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
    '<div class="finder-empty">Nothing matched “' + esc(q) + '” — not in ' + esc(here) + ', and not in any other project.</div>';
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
    { label: authed() ? "Claude account" : "Sign in to Claude Code",
      desc: authed() ? (S.auth && S.auth.email) || "signed in" : "not signed in", run: () => openSignin() },
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

/* ─────────────────────── sign in to Claude Code ─────────────────────
 * The CLI's login is a terminal conversation: it prints a link, opens the browser, and
 * waits on stdin for the code the callback page shows. Bridge runs that same conversation
 * through this sheet, so a fresh machine gets from "not signed in" to a working session
 * without ever opening a terminal. */
const AUTH = { view: "idle", mode: "claudeai", url: "", err: "", busy: false };
const authed = () => !!(S.auth && S.auth.loggedIn);

async function refreshAuth(fresh) {
  try { S.auth = await (await fetch("/api/auth" + (fresh ? "?fresh=1" : ""))).json(); } catch (e) {}
  return S.auth;
}
function openSignin(why) {
  AUTH.view = "idle"; AUTH.err = why || ""; AUTH.url = ""; AUTH.busy = false;
  $("#signinBg").classList.add("on");
  renderSignin();
}
function closeSignin() {
  $("#signinBg").classList.remove("on");
  if (AUTH.view === "code") fetch("/api/auth/cancel", { method: "POST" });
  AUTH.view = "idle"; AUTH.url = "";
}
const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then((r) => r.json());

function renderSignin() {
  const a = S.auth || {};
  const body = $("#signinBody");
  const err = AUTH.err ? '<div class="sheet-err">' + esc(AUTH.err) + "</div>" : "";
  $("#signinTitle").textContent = AUTH.view === "code" ? "Finish signing in"
    : authed() ? "Your Claude account" : "Sign in to Claude Code";

  if (AUTH.view === "code") {
    body.innerHTML = err +
      '<p class="sheet-p">Your browser is open on the Claude sign-in page. Approve it, then paste the code it gives you back here.</p>' +
      '<ol class="sheet-steps"><li>Approve the sign-in in the browser.</li>' +
      "<li>Copy the code shown on the page it lands on.</li><li>Paste it below.</li></ol>" +
      '<a class="sheet-link" href="' + esc(AUTH.url) + '" target="_blank" rel="noreferrer" title="Open the sign-in page again">' + esc(AUTH.url) + "</a>" +
      '<input class="sheet-in" id="authCode" placeholder="Paste the code here" spellcheck="false" autocomplete="off">' +
      '<div class="sheet-row" style="margin-top:12px"><button class="btn-go" id="authGo"' + (AUTH.busy ? " disabled" : "") + ">" +
      (AUTH.busy ? "Signing in…" : "Finish sign-in") + '</button><button class="btn-ghost" id="authBack">Cancel</button></div>';
    const inp = $("#authCode");
    inp.onkeydown = (e) => { if (e.key === "Enter") finishSignin(); };
    setTimeout(() => inp.focus(), 30);
    $("#authGo").onclick = finishSignin;
    $("#authBack").onclick = () => { fetch("/api/auth/cancel", { method: "POST" }); AUTH.view = "idle"; AUTH.err = ""; renderSignin(); };
    return;
  }

  if (authed()) {
    body.innerHTML = err +
      '<p class="sheet-p">Bridge runs the real <b>claude</b> CLI as this account. Signing out here signs out every Claude Code session on this machine.</p>' +
      '<div class="sheet-kv"><span>Account</span><b>' + esc(a.email || (a.keyAuth ? "API key in the environment" : "signed in")) + "</b></div>" +
      '<div class="sheet-kv"><span>Plan</span><b>' + esc(a.subscriptionType || a.authMethod || "—") + "</b></div>" +
      (a.orgName ? '<div class="sheet-kv"><span>Organisation</span><b>' + esc(a.orgName) + "</b></div>" : "") +
      '<div class="sheet-row" style="margin-top:16px"><button class="btn-ghost" id="authOut"' + (a.keyAuth ? " disabled" : "") + ">Sign out</button>" +
      '<button class="btn-ghost" id="authAgain">Sign in as someone else</button></div>';
    const out = $("#authOut");
    if (out && !a.keyAuth) out.onclick = async () => {
      out.disabled = true; out.textContent = "Signing out…";
      const r = await post("/api/auth/logout");
      S.auth = r.status || (await refreshAuth(true));
      AUTH.err = r.ok ? "" : r.out || "logout did not take";
      toast(r.ok ? "Signed out" : "Could not sign out"); paint(); renderSignin();
    };
    $("#authAgain").onclick = () => beginSignin(AUTH.mode);
    return;
  }

  const seg = (v, label, help) => '<button class="seg ' + (AUTH.mode === v ? "on" : "") + '" data-mode="' + v + '" title="' + esc(help) + '">' + label + "</button>";
  body.innerHTML = err +
    '<p class="sheet-p">Bridge drives the <b>claude</b> CLI, and the CLI is not signed in yet. This does the whole thing here — no terminal.</p>' +
    '<div class="sheet-row">' + seg("claudeai", "Claude subscription", "Pro or Max — the usual choice") +
    seg("console", "Anthropic Console", "Pay per token against an API account") + "</div>" +
    '<button class="btn-go" id="authStart"' + (AUTH.busy ? " disabled" : "") + ">" +
    (AUTH.busy ? "Opening your browser…" : "Sign in") + "</button>" +
    (S.auth && S.auth.cli === false ? '<p class="sheet-p" style="margin-top:14px">The <code>claude</code> command was not found on this machine. Install Claude Code first.</p>' : "");
  body.querySelectorAll("[data-mode]").forEach((n) => (n.onclick = () => { AUTH.mode = n.dataset.mode; renderSignin(); }));
  $("#authStart").onclick = () => beginSignin(AUTH.mode);
}

async function beginSignin(mode) {
  AUTH.busy = true; AUTH.err = ""; AUTH.mode = mode || "claudeai";
  AUTH.view = "idle"; renderSignin();
  const r = await post("/api/auth/login", { mode: AUTH.mode });
  AUTH.busy = false;
  if (r.error || !r.url) { AUTH.err = r.error || "could not start the sign-in"; renderSignin(); return; }
  AUTH.url = r.url; AUTH.view = "code"; renderSignin();
}
async function finishSignin() {
  const inp = $("#authCode");
  const code = inp ? inp.value.trim() : "";
  if (!code) { AUTH.err = "paste the code from the browser first"; renderSignin(); return; }
  AUTH.busy = true; AUTH.err = ""; renderSignin();
  const r = await post("/api/auth/code", { code: code });
  AUTH.busy = false;
  S.auth = r.status || (await refreshAuth(true));
  if (r.ok) {
    AUTH.view = "idle"; AUTH.err = "";
    closeSignin(); paint();
    toast("Signed in" + (S.auth && S.auth.email ? " as " + S.auth.email : ""));
    return;
  }
  AUTH.err = r.error || "that did not go through";
  AUTH.view = r.restart ? "idle" : "code";
  renderSignin();
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
  Object.assign(S, { boot: b, recent: recent, agents: agents, configs: configs, roots: roots, auth: b.auth || { loggedIn: false } });
  S.skills = configs.filter((c) => c.group === "Skills");
  S.cwd = localStorage.bridgeCwd && roots.indexOf(localStorage.bridgeCwd) >= 0 ? localStorage.bridgeCwd : roots[0];

  const opt = (v, label, help, sel) => '<option value="' + esc(v) + '"' + (sel ? " selected" : "") + (help ? ' title="' + esc(help) + '"' : "") + ">" + esc(label) + "</option>";
  $("#selModel").innerHTML = opt("", "model", HELP.model[""]) + b.models.map((m) => opt(m, m, HELP.model[m])).join("");
  $("#selPerm").innerHTML = b.permissionModes.map((m) => opt(m, m, HELP.perm[m], m === "acceptEdits")).join("");
  initPermDial(b.permissionModes);
  $("#selEffort").innerHTML = b.efforts.map((e) => opt(e, e || "effort", HELP.effort[e])).join("") + opt("ultracode", "ULTRACODE", HELP.effort.ultracode);
  initEffortDial(b.efforts);
  $("#selAgent").innerHTML = opt("auto", "auto", HELP.agent.auto) + opt("", "no agent", HELP.agent[""]) + agents.map((a) => opt(a.name, a.name, a.description ? String(a.description).slice(0, 160) : "")).join("");
  // Model and Agent are dials too (after the selects have options, since the dial sets sel.value)
  initModelDial(b.models);
  initAgentDial(agents);
  // the label's tooltip explains the control, then what the current choice means
  const explain = (labId, selId, group, head) => {
    const lab = $("#" + labId), sel = $("#" + selId);
    const upd = () => {
      const v = sel.value, o = sel.options[sel.selectedIndex];
      const d = (HELP[group] && HELP[group][v]) || (o && o.title) || "";
      lab.title = head + (d ? "\n\nNow: " + (o ? o.textContent : v) + " — " + d : "");
    };
    sel.addEventListener("change", upd); upd();
  };
  explain("labModel", "selModel", "model", "Model — which Claude answers this turn. Default uses your settings.json.");
  explain("labPerm", "selPerm", "perm", "Guardrails — how much Claude Code may do without asking you first. Left is safest, right is fastest.");
  explain("labEffort", "selEffort", "effort", "Effort — how long the model thinks before it answers. Higher is slower and more thorough; auto uses the default. ULTRACODE is God mode: max effort plus a team of agents.");
  explain("labAgent", "selAgent", "agent", "Agent — run this turn as one of your custom agents (its own instructions, tools and model). None = plain Claude Code.");

  if (S.roots[0]) await selectDir(S.roots[0]);
  loadNotes();
  makeTab();
  S.view = "copilot";                         // Bridge opens on the copilot, above the sessions
  paint(); renderBell();
  syncLive(); setInterval(syncLive, 4000);    // terminals come and go on their own
  window._bridgeBooted();

  if (!authed()) openSignin();               // first run: the sheet is the app until there is an account
  $("#signinClose").onclick = closeSignin;
  $("#signinBg").onclick = (e) => { if (e.target.id === "signinBg") closeSignin(); };
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
  $("#btnSend").onclick = () => send();
  $("#btnCancel").onclick = () => abortTab(T());

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
  ta.onpaste = (e) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };

  const composer = $("#composer");
  composer.ondragover = (e) => { e.preventDefault(); composer.classList.add("drag"); };
  composer.ondragleave = (e) => { composer.classList.remove("drag"); };
  composer.ondrop = (e) => {
    e.preventDefault(); composer.classList.remove("drag");
    const files = Array.from(e.dataTransfer.files);
    if (files.length) addFiles(files);
    else if (e.dataTransfer.getData("text/plain")) {
      const p = e.dataTransfer.getData("text/plain").trim();
      if (p && !p.includes("\n")) fetch("/api/file?path=" + encodeURIComponent(p))
        .then((r) => r.json()).then((d) => { if (!d.error) addAttachment({ name: d.path.split("/").pop(), path: d.path }); });
    }
  };

  const fi = $("#fileInput");
  $("#btnAttach").onclick = () => fi.click();
  fi.onchange = () => { if (fi.files.length) addFiles(Array.from(fi.files)); fi.value = ""; };

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
    else if (e.key === "Escape" && S.view === "copilot" && window.Desk && window.Desk.escape()) { e.preventDefault(); }
    else if (meta && e.key === "j") { e.preventDefault(); toggleTheme(); }
    else if (meta && e.key === "i") { e.preventDefault(); S.inspector = !S.inspector; renderInspector(); }
    else if (e.key === "Escape") {
      if ($("#signinBg").classList.contains("on")) closeSignin();
      else if ($("#notes").classList.contains("on")) toggleNotes(false);
      else if ($("#finder").classList.contains("on")) closeFinder();
      else if ($("#recents").classList.contains("on")) toggleRecents(false);
          else if (PAGE()) closePage();
      else if (S.view !== "chat") goChat();
      else { const t = T(); if (t && t.streaming) abortTab(t); }
    }
  };
  ta.focus();
})();
