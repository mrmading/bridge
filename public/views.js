/* ══════════════════════ Bridge views ══════════════════════
 * Everything that is not the chat: Home, Inbox, Projects, Files, Agents & skills, documents,
 * Settings, the ⌘K palette, the ⌘F finder and the sign-in sheet. Uses app.js's state and helpers. */

const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const sec = (icon, label, tag, more) => '<h2 class="sec">' + ic(icon) + esc(label) + (tag !== undefined && tag !== null ? tag : "") + (more || "") + "</h2>";
const empty = (h, p) => '<div class="card" style="cursor:default"><p><b style="color:var(--fg)">' + esc(h) + "</b>" + (p ? "<br>" + esc(p) : "") + "</p></div>";

/* ── cards shared by several views ──────────────────────────────── */
function needCard(n) {
  return '<div class="card need"><div class="ch">' + projIco(n.projectName, 22) + '<span class="ct">' + esc(n.title) + '</span><span class="cm">' + fmtAgo(n.since) + "</span></div>" +
    "<p>Asks: <b style=\"color:var(--fg)\">" + esc(n.ask) + "</b></p>" +
    '<div class="row mt12"><button class="btn pri" data-open="' + esc(n.key + "|" + n.id) + '">Answer</button><span class="tag">' + esc(n.projectName) + "</span></div></div>";
}
function runCard(r) {
  return '<button class="card live" data-open="' + esc(r.key + "|" + r.id) + '"><div class="ch">' + (r.agent ? ava(r.agent) : projIco(r.projectName, 22)) + '<span class="ct">' + esc(r.title) + "</span>" +
    '<span class="mono" style="font-size:12px;color:var(--fg-muted)" data-since="' + r.started + '">' + fmtEl(Date.now() - r.started) + "</span></div>" +
    "<p>" + esc([r.agent, r.projectName, String(r.model || "").replace("claude-", "")].filter(Boolean).join(" · ")) + (r.jobs && r.jobs.length ? ' · <span style="color:var(--accent)">' + r.jobs.length + " in the background</span>" : "") + "</p>" +
    '<div class="bar indet mt8" style="margin-left:0"><i></i></div><div class="ticker"><span class="typing"><i></i><i></i><i></i></span><span class="tx">' + esc(r.step || "Working") + "</span></div></button>";
}
function fileTile(f) {
  const e = f.ext || extOf(f.path), img = /^(png|jpe?g|gif|webp|svg)$/.test(e);
  return '<button class="card ftile" data-doc="' + esc(f.path) + '" title="' + esc(f.path) + '"><div class="fthumb" style="background:linear-gradient(160deg,color-mix(in srgb,' + extColor(e) + ' 22%,var(--bg-sunken)),var(--bg-sunken))">' +
    '<span class="ext" style="background:' + extColor(e) + '">' + esc((e || "file").toUpperCase().slice(0, 4)) + "</span>" +
    (img ? '<img loading="lazy" src="/api/raw?path=' + encodeURIComponent(f.path) + '" alt="">' : '<div class="mock"><i class="h"></i><i></i><i style="width:80%"></i><i></i><i style="width:55%"></i></div>') + "</div>" +
    '<div class="fbody"><div class="ct">' + esc(f.name) + '</div><div class="row" style="margin-top:4px;font-size:12px;color:var(--fg-faint);min-width:0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.sessionTitle || projectName(f.path.slice(0, f.path.lastIndexOf("/")))) + " · " + fmtShortAgo(f.mtime) + "</span></div></div></button>";
}
function projCard(p) {
  const live = runningList().some((r) => r.cwd === p.path || String(r.cwd).indexOf(p.path + "/") === 0);
  return '<button class="card" data-proj="' + esc(p.key) + '"><div class="ch">' + projIco(p.name, 38) + '<div style="flex:1;min-width:0"><div class="ct">' + esc(p.name) + '</div><div class="cm">' + p.count + (p.count === 1 ? " chat" : " chats") + " · " + fmtAgo(p.mtime) + "</div></div>" + (live ? '<span class="dot run"></span>' : "") +
    '</div><p class="mono" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.path.replace(homeDir(), "~")) + "</p></button>";
}
function signinCard() {
  return '<div class="card signin-card" style="cursor:default"><div class="ch" style="justify-content:center"><span class="ct" style="flex:none">Sign in to Claude Code</span></div>' +
    "<p>Bridge drives the real <code>claude</code> CLI on this machine, and it is not signed in yet. Sign in here, no terminal needed.</p>" +
    '<div class="row mt12" style="justify-content:center"><button class="btn pri" data-act="signin">Sign in</button></div></div>';
}

/* ── views ───────────────────────────────────────────────────────── */
const VIEWS = {
  home() {
    const h = new Date().getHours();
    const greet = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    const runs = runningList(), needs = S.home.needs, made = S.home.made;
    const done = S.recent.filter((s) => !s.running && !s.needs && s.mtime >= today0()).length;
    const n = (k, one, many) => "<b>" + k + " " + (k === 1 ? one : many) + "</b>";
    const brief = needs.length || runs.length || done
      ? [needs.length ? n(needs.length, "thing needs you", "things need you") : "", runs.length ? n(runs.length, "chat is working", "chats are working") : "", done ? n(done, "chat finished today", "chats finished today") : ""].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1") + "."
      : "Nothing is running. Start something below, or tap the orb to talk.";
    const top = S.home.projects.filter((p) => p.path !== homeDir())[0];
    const chips = [["Catch me up on everything", 1], ["What's waiting on me?", 1], top ? ["What should I do next in " + top.name + "?", 0] : null, ["Review what changed today", 0]].filter(Boolean);
    return '<div class="view"><div class="wrap"><div class="hero">' +
      '<canvas id="orb" width="264" height="264" title="Talk to ' + esc(daName()) + '" data-act="voice"></canvas>' +
      '<h1 class="big">' + greet + ", " + esc(userName()) + "</h1>" +
      '<p class="brief">' + brief + "</p>" +
      (authed() ? composer("Ask anything, or tell your team what to do…") : signinCard()) +
      '<div class="suggest">' + chips.map(([t, cop]) => '<button class="chipx" ' + (cop ? 'data-ask="' : 'data-suggest="') + esc(t) + '">' + esc(t) + "</button>").join("") + "</div></div>" +
      sec("hand", "Needs you", needs.length ? '<span class="tag warn">' + needs.length + "</span>" : "", '<button class="more" data-go="inbox">Open inbox</button>') +
      (needs.length ? '<div class="grid two">' + needs.slice(0, 4).map(needCard).join("") + "</div>" : empty("Nothing is waiting on you.", "When a chat ends on a question, it shows up here.")) +
      sec("bolt", "Working now", runs.length ? '<span class="tag acc">' + runs.length + "</span>" : "") +
      (runs.length ? '<div class="grid two">' + runs.map(runCard).join("") + "</div>" : empty("No chat is running.", "Long jobs keep going here even after you close Bridge.")) +
      sec("file", "Recently made for you", "", '<button class="more" data-go="files">All files</button>') +
      (made.length ? '<div class="grid">' + made.slice(0, 4).map(fileTile).join("") + "</div>" : empty("No files yet this week.", "Documents, pages and code your chats write appear here.")) +
      sec("folder", "Jump back in", "", '<button class="more" data-go="projects">All projects</button>') +
      '<div class="grid">' + S.home.projects.filter((p) => p.path !== homeDir()).slice(0, 4).map(projCard).join("") + "</div>" +
      "</div></div>";
  },

  inbox() {
    const F = S.inboxF;
    const runs = runningList();
    const items = [
      ...S.home.needs.map((x) => ({ k: "need", key: x.key, id: x.id, t: x.title, d: x.ask, p: x.projectName, when: x.since })),
      ...runs.map((x) => ({ k: "run", key: x.key, id: x.id, t: x.title, d: x.step, p: x.projectName, when: x.started, since: x.started })),
      ...S.recent.filter((s) => !s.running && !s.needs).slice(0, 40).map((s) => ({ k: "done", key: s.project, id: s.id, t: s.title, d: s.preview, p: projectName(s.projectPath), when: s.mtime })),
    ].filter((x) => F === "all" || x.k === F);
    const col = { need: ["var(--warn-soft)", "var(--warn)", "hand", "Needs an answer"], run: ["var(--accent-soft)", "var(--accent)", "bolt", "Working"], done: ["var(--ok-soft)", "var(--ok)", "check", "Finished"] };
    const count = (k) => { const n = k === "need" ? S.home.needs.length : k === "run" ? runs.length : 0; return n ? " " + n : ""; };
    return '<div class="view"><div class="wrap"><h1 class="big">Inbox</h1><p class="sub mt8">Everything your team did, newest first. Questions float to the top.</p>' +
      '<div class="filters">' + [["all", "All"], ["need", "Needs you"], ["run", "Working"], ["done", "Done"]].map(([k, l]) => '<button class="pill ' + (F === k ? "on" : "") + '" data-filter="inbox:' + k + '">' + l + count(k) + "</button>").join("") +
      '<span style="flex:1"></span><button class="pill" data-filter="readall">' + ic("check") + "Mark all read</button></div>" +
      '<div class="list">' + (items.map((x) => {
        const unread = x.k !== "run" && x.when > S.readAt;
        return '<button class="li" data-open="' + esc(x.key + "|" + x.id) + '"><span class="ico" style="background:' + col[x.k][0] + ";color:" + col[x.k][1] + '">' + ic(col[x.k][2], 2) + "</span>" +
          '<div class="l"><b' + (unread ? "" : ' style="font-weight:500"') + ">" + esc(x.t) + "</b><span>" + esc(col[x.k][3]) + " · " + esc(x.p) + (x.d ? " · " + esc(String(x.d).slice(0, 160)) : "") + "</span></div>" +
          (x.k === "need" ? '<span class="btn pri" style="height:28px">Answer</span>' : x.k === "run" ? '<span class="r mono" data-since="' + x.since + '">' + fmtEl(Date.now() - x.since) + "</span>" : '<span class="r">' + (unread ? '<span class="dot" style="background:var(--accent);display:inline-block;margin-right:6px"></span>' : "") + fmtShortAgo(x.when) + "</span>") + "</button>";
      }).join("") || '<div class="empty-c">Nothing here</div>') + "</div></div></div>";
  },

  projects() {
    return '<div class="view"><div class="wrap wide"><div class="row"><h1 class="big" style="flex:1">Projects</h1><button class="btn pri" data-act="choosefolder">' + ic("plus", 2) + "New project</button></div>" +
      '<p class="sub mt8">A project is a folder your team works in. Its instructions, chats and files live together.</p>' +
      '<div class="search">' + ic("search") + '<input id="pq" placeholder="Find a project…" value="' + esc(S.projQ) + '" autocomplete="off"></div>' +
      '<div class="grid" id="plist" style="margin-top:18px">' + projList() + "</div></div></div>";
  },

  project() {
    const p = S.home.projects.find((x) => x.key === S.proj) || { key: S.proj, name: base(S.proj), path: "", count: 0, mtime: 0 };
    const info = PINFO[p.key];
    if (!info) loadProject(p);
    const made = S.home.made.filter((f) => p.path && f.path.indexOf(p.path + "/") === 0);
    const hooks = S.hooks || [];
    return '<div class="view"><div class="wrap wide"><div class="crumbs"><button data-go="projects">Projects</button>›<b>' + esc(p.name) + "</b></div>" +
      '<div class="row">' + projIco(p.name, 48) + '<div style="flex:1;min-width:0"><h1 class="big">' + esc(p.name) + '</h1><div class="sub mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(p.path.replace(homeDir(), "~")) + "</div></div>" +
      '<button class="btn pri" data-newin="' + esc(p.path) + '">' + ic("plus", 2) + '<span class="hide-sm">New chat here</span></button></div>' +
      '<div class="grid two" style="margin-top:22px">' +
      '<div class="card" style="cursor:default"><div class="ch">' + ic("book") + '<span class="ct">Instructions</span><span class="tag">CLAUDE.md</span></div>' +
      "<p>" + (info ? (info.claude ? esc(info.claude) : "No instructions yet. Rules you write here apply to every chat in " + esc(p.name) + ".") : "Loading…") + "</p>" +
      '<button class="btn mt12" data-doc-create="' + esc(p.path + "/CLAUDE.md") + '">' + (info && info.claude ? "Edit instructions" : "Write instructions") + "</button></div>" +
      '<div class="card" style="cursor:default"><div class="ch">' + ic("zap") + '<span class="ct">Automations</span><span class="tag">' + (hooks.length + (info ? info.hooks : 0)) + " hooks</span></div>" +
      "<p>" + (hooks.length ? "Every chat runs your automations: " + esc([...new Set(hooks.map((h) => h.event))].slice(0, 5).join(", ")) + "." : "No automations configured.") + (info && info.hooks ? " This project adds " + info.hooks + " of its own." : "") + "</p>" +
      '<button class="btn mt12" data-stab-open="advanced">Manage</button></div></div>' +
      sec("inbox", "Chats", '<span class="tag">' + p.count + "</span>") +
      '<div class="list">' + (info && info.sessions ? info.sessions.slice(0, 30).map((s) => {
        const run = runningList().find((r) => r.id === s.id), need = S.home.needs.find((x) => x.id === s.id);
        return '<button class="li" data-open="' + esc(p.key + "|" + s.id) + '"><span class="dot ' + (run ? "run" : need ? "wait" : "ok") + '"></span><div class="l"><b>' + esc(s.title) + "</b><span>" + esc(s.preview || "") + '</span></div><span class="r">' + (run ? '<span class="mono" data-since="' + run.started + '">' + fmtEl(Date.now() - run.started) + "</span>" : fmtShortAgo(s.mtime)) + "</span></button>";
      }).join("") : '<div class="empty-c">Loading…</div>') + "</div>" +
      sec("file", "Files made here", '<span class="tag">' + made.length + "</span>", '<button class="more" data-browse="' + esc(p.path) + '">Browse folder</button>') +
      (made.length ? '<div class="grid">' + made.slice(0, 8).map(fileTile).join("") + "</div>" : empty("Nothing made here this week.")) +
      "</div></div>";
  },

  files() {
    const F = S.filesF;
    return '<div class="view"><div class="wrap wide"><h1 class="big">Files</h1><p class="sub mt8">What your team made, and every folder Bridge can see.</p>' +
      '<div class="search">' + ic("search") + '<input id="fq" placeholder="Describe it: “the zeroship cloudflare deploy”, “padel occupancy excel”…" value="' + esc(S.filesQ) + '" autocomplete="off"><kbd>↵</kbd></div>' +
      '<div class="filters">' + [["made", "Made for you"], ["browse", "Browse folders"]].map(([k, l]) => '<button class="pill ' + (F === k ? "on" : "") + '" data-filter="files:' + k + '">' + l + "</button>").join("") +
      (F === "made" ? '<span style="width:8px"></span>' + Object.keys(KINDS).map((k) => '<button class="pill ' + (S.filesKind === k ? "on" : "") + '" data-filter="kind:' + k + '">' + k + "</button>").join("") : "") + "</div>" +
      '<div id="flist">' + (F === "made" ? madeList() : browseList()) + "</div></div></div>";
  },

  agents() {
    const cats = ["All"].concat([...new Set(S.agents.map((a) => a.category))].sort());
    return '<div class="view"><div class="wrap wide"><div class="row"><h1 class="big" style="flex:1">Agents &amp; skills</h1></div>' +
      '<p class="sub mt8">Your team. Give anyone a task, or leave it on Auto and Bridge picks who fits each message.</p>' +
      '<div class="search">' + ic("search") + '<input id="agq" placeholder="Find a teammate or a skill…" value="' + esc(S.agentQ) + '" autocomplete="off"></div>' +
      sec("agents", "Your team", '<span class="tag">' + S.agents.length + "</span>") +
      '<div class="filters" style="margin-top:0">' + cats.map((c) => '<button class="pill ' + (S.agentCat === c ? "on" : "") + '" data-filter="agentcat:' + esc(c) + '">' + esc(c) + "</button>").join("") + "</div>" +
      '<div class="grid" id="alist">' + agentList() + "</div>" +
      sec("spark", "Skills", '<span class="tag">' + S.skills.length + "</span>") +
      '<div class="list" id="slist">' + skillList() + "</div></div></div>";
  },

  doc() {
    const c = S.doc;
    if (!c) return VIEWS.home();
    const e = extOf(c.path);
    let body;
    if (c.loading) body = '<div class="empty-big"><span class="spin-s" style="display:inline-block"></span></div>';
    else if (c.denied) body = '<div class="empty-big"><h3>Outside your folders</h3>' + esc(c.text) + '<div class="row mt12" style="justify-content:center"><button class="btn pri" data-addfolder="' + esc(c.path.slice(0, c.path.lastIndexOf("/"))) + '">Let Bridge see this folder</button></div></div>';
    else if (c.editing) body = c.lang === "markdown" ? '<div class="split"><textarea class="editor" id="editor" spellcheck="false">' + esc(c.text) + '</textarea><div class="mdpreview prose" id="mdprev">' + md(c.text) + "</div></div>" : '<textarea class="editor" id="editor" spellcheck="false">' + esc(c.text) + "</textarea>";
    else if (c.binary && /^(png|jpe?g|gif|webp|svg)$/.test(e)) body = '<div class="docbody"><img src="' + esc(c.url) + '"></div>';
    else if (c.binary) body = '<div class="docbody"><iframe src="' + esc(c.url) + '"></iframe></div>';
    else if (e === "html" || e === "htm") body = '<div class="docbody" style="padding:0;overflow:hidden"><iframe sandbox="allow-scripts allow-popups" src="/api/raw?path=' + encodeURIComponent(c.path) + '" style="border:0;border-radius:0"></iframe></div>';
    else if (c.lang === "markdown") body = '<div class="docbody prose">' + md(c.text) + "</div>";
    else body = '<div class="docbody prose" style="padding:0"><pre style="margin:0;border:0"><code>' + esc(c.text) + "</code></pre></div>";
    const acts = c.loading || c.denied ? "" : c.editing
      ? '<button class="btn pri" data-docact="save">Save <kbd style="margin-left:4px">⌘S</kbd></button><button class="btn" data-docact="cancel">Cancel</button>'
      : (!c.binary ? '<button class="btn" data-docact="edit">' + ic("edit") + "Edit</button>" : "") + (e === "html" || e === "htm" ? '<button class="btn" data-docact="source">' + ic("term") + "Source</button>" : "") +
        '<button class="btn" data-docact="open">' + ic("ext") + "Open</button>" + '<button class="btn" data-docact="ask">' + ic("spark") + "Ask about this</button>";
    return '<div class="view"><div class="wrap wide" style="max-width:' + (c.editing ? "1240px" : "1000px") + '"><div class="docbar"><button class="btn" data-docact="back">' + ic("back") + esc(c.back || "Back") + "</button>" +
      '<span class="path">' + esc(c.path.replace(homeDir(), "~")) + (c.size ? " · " + fmtB(c.size) : "") + "</span>" + acts + "</div>" + body + "</div></div>";
  },

  activity() {
    const A = S.activity;
    if (!A) { loadActivity(); return '<div class="view"><div class="wrap"><h1 class="big">Activity</h1><div class="empty-big"><span class="spin-s" style="display:inline-block"></span></div></div></div>'; }
    const s = A.summary;
    const tile = (l, v, sub) => '<div class="tile"><div class="tile-v">' + v + '</div><div class="tile-l">' + l + "</div>" + (sub ? '<div class="tile-s">' + sub + "</div>" : "") + "</div>";
    const K = { "turn.start": ["started", "k-start"], "turn.done": ["done", "k-done"], "turn.error": ["failed", "k-error"], "turn.exit": ["exited", "k-error"], "turn.stop": ["stopped", ""], "file.save": ["saved", ""] };
    return '<div class="view"><div class="wrap"><div class="row"><h1 class="big" style="flex:1">Activity</h1><span class="faint" style="font-size:12px">today · since Bridge started</span></div>' +
      '<div class="tiles">' + tile("running now", s.running) + tile("turns", s.turns, s.done + " done · " + s.failed + " failed" + (s.stopped ? " · " + s.stopped + " stopped" : "")) +
      tile("spend", "$" + s.spend.toFixed(2), "model time " + fmtEl(s.wall)) + tile("chats touched", s.sessionsToday, s.saves + " file saves") + "</div>" +
      sec("pulse", "Log", '<span class="tag">' + A.log.length + "</span>") +
      '<div class="list">' + (A.log.map((r) => {
        const k = K[r.kind] || [r.kind.split(".").pop(), ""];
        return '<div class="li" ' + (r.sessionKey ? 'data-open="' + esc(r.sessionKey + "|" + r.session) + '" style="cursor:pointer"' : "") + '><span class="logk ' + k[1] + '">' + esc(k[0]) + '</span><div class="l"><b style="font-weight:500">' + esc(r.msg) + "</b><span>" + esc([r.sessionTitle, r.cwd ? projectName(r.cwd) : "", r.outcome && r.kind !== "turn.done" ? r.outcome : "", r.cost ? "$" + r.cost.toFixed(3) : "", r.ms ? fmtEl(r.ms) : ""].filter(Boolean).join(" · ")) + '</span></div><span class="r">' + new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "</span></div>";
      }).join("") || '<div class="empty-c">Nothing yet this run.</div>') + "</div></div></div>";
  },

  configs() {
    const groups = ["Core", "Memory", "Skills", "Agents"];
    const g = S.cfgGroup || "Core";
    return '<div class="view"><div class="wrap"><div class="crumbs"><button data-act="settings">Settings</button>›<b>Settings files</b></div><h1 class="big">Settings files</h1>' +
      '<p class="sub mt8">Everything under ~/.claude that shapes how your team works. Click to read or edit.</p>' +
      '<div class="filters">' + groups.map((x) => '<button class="pill ' + (g === x ? "on" : "") + '" data-filter="cfg:' + x + '">' + x + " " + S.configs.filter((c) => c.group === x).length + "</button>").join("") + "</div>" +
      '<div class="list">' + S.configs.filter((c) => c.group === g).map((c) => '<button class="li" data-doc="' + esc(c.path) + '"><span class="ico" style="background:var(--bg-active)">' + ic(g === "Agents" ? "agents" : g === "Skills" ? "spark" : "file") + '</span><div class="l"><b>' + esc(c.label) + "</b><span>" + esc(c.desc || c.path.replace(homeDir(), "~")) + '</span></div><span class="r">' + (c.bytes ? fmtB(c.bytes) : "") + "</span></button>").join("") + "</div></div></div>";
  },
};

/* ── list bodies that re-render on their own while you type ─────── */
function projList() {
  const q = S.projQ.toLowerCase();
  const list = S.home.projects.filter((p) => p.path !== homeDir() && (!q || (p.name + " " + p.path).toLowerCase().includes(q)));
  return list.map(projCard).join("") || '<div class="empty-c">No project matches.</div>';
}
const KINDS = { All: null, Documents: /^(md|txt|pdf|docx?|rtf)$/, Pages: /^html?$/, Code: /^(ts|tsx|js|jsx|py|dart|rs|go|sh|sql|css|json|ya?ml|toml|swift)$/, Images: /^(png|jpe?g|gif|webp|svg)$/, Spreadsheets: /^(xlsx?|csv)$/, Videos: /^(mp4|mov|webm)$/ };
function madeList() {
  const q = S.filesQ.toLowerCase(), re = KINDS[S.filesKind];
  const list = S.home.made.filter((f) => (!re || re.test(f.ext)) && (!q || (f.name + " " + f.sessionTitle + " " + f.path).toLowerCase().includes(q)));
  return list.length ? '<div class="grid">' + list.map(fileTile).join("") + "</div>" : '<div class="empty-c">' + (q ? "Nothing made this week matches. Press ↵ to search every chat for it." : "Nothing here this week.") + "</div>";
}
function browseList() {
  const d = S.dir;
  if (!d) return '<div class="list">' + S.roots.map((r) => '<button class="li" data-dir="' + esc(r) + '"><span class="ico" style="background:var(--accent-soft);color:var(--accent)">' + ic("folder") + '</span><div class="l"><b>' + esc(base(r)) + "</b><span>" + esc(r.replace(homeDir(), "~")) + '</span></div><span class="r">›</span></button>').join("") +
    '<button class="li" data-act="addroot"><span class="ico" style="background:var(--bg-active)">' + ic("plus") + '</span><div class="l"><b>Add a folder</b><span>Bridge only sees the folders you list here</span></div></button></div>';
  const q = S.filesQ.toLowerCase();
  const root = S.roots.filter((r) => d.path === r || d.path.indexOf(r + "/") === 0)[0] || "";
  let acc = root;
  const crumbs = '<button data-dir="">' + ic("folder") + "</button>›" + '<button data-dir="' + esc(root) + '"><b>' + esc(base(root)) + "</b></button>" +
    (root && d.path.length > root.length ? d.path.slice(root.length + 1).split("/").map((seg) => { acc += "/" + seg; return "›<button data-dir=\"" + esc(acc) + '">' + esc(seg) + "</button>"; }).join("") : "");
  const dirs = d.entries.filter((e) => e.dir && (!q || e.name.toLowerCase().includes(q)));
  const files = d.entries.filter((e) => !e.dir && (!q || e.name.toLowerCase().includes(q))).sort((a, b) => b.mtime - a.mtime);
  const full = (e) => (d.path + "/" + e.name).replace(/\/+/g, "/");
  return '<div class="crumbs" style="flex-wrap:wrap">' + crumbs + "</div>" + '<div class="list">' +
    (d.parent ? '<button class="li" data-dir="' + esc(d.parent) + '"><span class="ico" style="background:var(--bg-active)">' + ic("back") + '</span><div class="l"><b>Up</b></div></button>' : "") +
    dirs.map((e) => '<button class="li" data-dir="' + esc(full(e)) + '"><span class="ico" style="background:var(--accent-soft);color:var(--accent)">' + ic("folder") + '</span><div class="l"><b>' + esc(e.name) + '</b></div><span class="r">›</span></button>').join("") +
    files.map((e) => { const x = extOf(e.name); return '<button class="li" data-doc="' + esc(full(e)) + '"><span class="ico" style="background:' + extColor(x) + ';color:#fff;font-family:var(--mono);font-size:9px;font-weight:800">' + esc((x || "·").toUpperCase().slice(0, 4)) + '</span><div class="l"><b>' + esc(e.name) + "</b><span>" + fmtB(e.size) + '</span></div><span class="r">' + fmtShortAgo(e.mtime) + "</span></button>"; }).join("") +
    (!dirs.length && !files.length ? '<div class="empty-c">Empty</div>' : "") + "</div>";
}
function agentList() {
  const q = S.agentQ.toLowerCase();
  const runs = runningList();
  const list = S.agents.filter((a) => (S.agentCat === "All" || a.category === S.agentCat) && (!q || (a.name + " " + a.description + " " + a.category).toLowerCase().includes(q)));
  return list.map((a) => {
    const L = agentLook(a.name), busy = runs.filter((r) => r.agent === a.name).length;
    return '<div class="card agent-card" style="cursor:default"><div class="big-ava" style="background:' + L.color + '">' + esc(L.init) + '<span class="dot ' + (busy ? "run" : "ok") + '"></span></div>' +
      '<div class="ct" style="font-weight:600">' + esc(a.name) + '</div><p style="min-height:38px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">' + esc(L.role) + "</p>" +
      '<div class="row mt8"><span class="tag ' + (busy ? "acc" : "ok") + '">' + (busy ? "Busy in " + busy + (busy > 1 ? " chats" : " chat") : "Available") + '</span><span class="cm" style="font-size:11.5px;color:var(--fg-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(a.category || "") + "</span></div>" +
      '<div class="row mt12"><button class="btn" style="flex:1;justify-content:center" data-assign="' + esc(a.name) + '">Give a task</button><button class="icon-btn" data-doc="' + esc(a.path) + '" title="Read its instructions">' + ic("book") + "</button></div></div>";
  }).join("") || '<div class="empty-c">No teammate matches.</div>';
}
function skillList() {
  const q = S.agentQ.toLowerCase();
  const list = S.skills.filter((s) => !q || (s.label + " " + (s.desc || "")).toLowerCase().includes(q));
  return list.slice(0, q ? 200 : 60).map((s) => '<button class="li" data-doc="' + esc(s.path) + '"><span class="ico" style="background:var(--think-soft);color:var(--think)">' + ic("spark") + '</span><div class="l"><b>' + esc(s.label) + "</b><span>" + esc(String(s.desc || "").replace(/\s+/g, " ").slice(0, 160)) + '</span></div><span class="tag">' + esc(String(s.sub || "").replace(/^plugin:/, "")) + "</span></button>").join("") +
    (!q && list.length > 60 ? '<div class="empty-c">' + (list.length - 60) + " more. Search to find them.</div>" : "") || '<div class="empty-c">No skill matches.</div>';
}

/* project details: its sessions, whether it has instructions, its own hooks */
const PINFO = {};
async function loadProject(p) {
  PINFO[p.key] = PINFO[p.key] || null;
  const [sessions, claude, settings, hooks] = await Promise.all([
    getJ("/api/sessions?key=" + encodeURIComponent(p.key)).catch(() => []),
    p.path ? getJ("/api/file?path=" + encodeURIComponent(p.path + "/CLAUDE.md")).catch(() => ({})) : {},
    p.path ? getJ("/api/file?path=" + encodeURIComponent(p.path + "/.claude/settings.json")).catch(() => ({})) : {},
    S.hooks ? S.hooks : getJ("/api/hooks").catch(() => []),
  ]);
  S.hooks = hooks;
  let own = 0;
  try { const j = JSON.parse(settings.text || "{}"); own = Object.values(j.hooks || {}).reduce((a, arr) => a + (Array.isArray(arr) ? arr.reduce((b, m) => b + ((m.hooks || []).length), 0) : 0), 0); } catch (e) {}
  PINFO[p.key] = { sessions: Array.isArray(sessions) ? sessions : [], claude: claude.text ? plainText(claude.text).slice(0, 220) + (claude.text.length > 220 ? "…" : "") : "", hooks: own };
  if (S.view === "project" && S.proj === p.key) softRender();
}
const plainText = (t) => String(t || "").replace(/^---[\s\S]*?---/, "").replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|-]/g, " ").replace(/\s+/g, " ").trim();
async function openDir(path) {
  if (!path) { S.dir = null; paintFiles(); return; }
  const d = await getJ("/api/dir?path=" + encodeURIComponent(path)).catch((e) => ({ error: String(e) }));
  if (d.error) return toast(d.error);
  if (d.roots) S.roots = d.roots;
  S.dir = d;
  paintFiles();
}
function paintFiles() { const b = $("#flist"); if (b) b.innerHTML = S.filesF === "made" ? madeList() : browseList(); }
async function loadActivity() {
  try { S.activity = await getJ("/api/activity"); } catch (e) { return; }
  if (S.view === "activity") softRender();
}

/* ── documents: read, edit, save ─────────────────────────────────── */
async function openDoc(path, title, opts) {
  opts = opts || {};
  const back = S.view === "doc" ? (S.doc && S.doc.back) : { home: "Home", chat: "Chat", inbox: "Inbox", projects: "Projects", project: "Project", files: "Files", agents: "Agents & skills", configs: "Settings files", activity: "Activity" }[S.view] || "Back";
  const from = S.view === "doc" && S.doc ? S.doc.from : S.view;
  S.doc = { path, title: title || base(path), back, from, loading: true, text: "" };
  go("doc");
  const d = await getJ("/api/file?path=" + encodeURIComponent(path)).catch((e) => ({ error: String(e) }));
  if (!S.doc || S.doc.path !== path) return;
  const missing = d.error && /not a file/.test(d.error);
  if (missing && opts.create) Object.assign(S.doc, { loading: false, text: "", lang: extOf(path) === "md" ? "markdown" : "text", editing: true, isNew: true });
  else Object.assign(S.doc, { loading: false, text: d.error ? d.error : d.text || "", lang: d.lang || "text", binary: !!d.binary, url: d.url, denied: !!d.error && !missing, size: d.size || 0 });
  if (missing && !opts.create) S.doc.text = "This file no longer exists.";
  softRender();
}
function closeDoc() { const from = (S.doc && S.doc.from) || "home"; S.doc = null; go(from === "doc" ? "home" : from); }
async function saveDoc() {
  const c = S.doc; if (!c) return;
  const ed = $("#editor");
  const text = ed ? ed.value : c.text;
  const r = await post("/api/save", { path: c.path, text });
  if (r.error) return toast(r.error);
  Object.assign(c, { text, size: r.size, editing: false, isNew: false });
  previewCache.delete(c.path);
  render();
  toast("Saved " + c.title);
}

/* ── per-view wiring after each render ──────────────────────────── */
window.VIEW_BIND = function () {
  const orb = $("#orb"); if (orb) startOrb(orb, 0.5);
  const tickers = $$(".ticker .tx"); if (tickers.length) { /* the step text is live data; it changes with refreshHome */ }
  const bindQ = (id, set, paint) => { const el = $("#" + id); if (!el) return; el.oninput = () => { set(el.value); paint(); }; return el; };
  bindQ("pq", (v) => (S.projQ = v), () => ($("#plist").innerHTML = projList()));
  const fq = bindQ("fq", (v) => (S.filesQ = v), paintFiles);
  if (fq) fq.onkeydown = (e) => { if (e.key === "Enter" && fq.value.trim()) openFinder(fq.value.trim(), "all"); };
  bindQ("agq", (v) => (S.agentQ = v), () => { $("#alist").innerHTML = agentList(); $("#slist").innerHTML = skillList(); });
  const ed = $("#editor");
  if (ed) {
    let pT;
    ed.focus();
    ed.oninput = () => { const pv = $("#mdprev"); if (!pv) return; clearTimeout(pT); pT = setTimeout(() => (pv.innerHTML = md(ed.value)), 140); };
    ed.onkeydown = (e) => {
      if (e.key === "Tab") { e.preventDefault(); const s0 = ed.selectionStart; ed.value = ed.value.slice(0, s0) + "  " + ed.value.slice(ed.selectionEnd); ed.selectionStart = ed.selectionEnd = s0 + 2; }
      else if (e.key === "Escape") { e.stopPropagation(); S.doc.editing = false; render(); }
    };
  }
};
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-filter],[data-dir],[data-docact],[data-doc-create],[data-browse],[data-stab-open],[data-addfolder]");
  if (!t) return;
  const d = t.dataset;
  if (d.filter) {
    const [k, v] = d.filter.split(":");
    if (k === "inbox") S.inboxF = v;
    else if (k === "readall") { S.readAt = Date.now(); ls("bridgeReadAt", String(S.readAt)); }
    else if (k === "files") { S.filesF = v; if (v === "browse" && !S.dir && S.roots.length === 1) openDir(S.roots[0]); }
    else if (k === "kind") S.filesKind = v;
    else if (k === "agentcat") S.agentCat = v;
    else if (k === "cfg") S.cfgGroup = v;
    softRender();
  }
  else if (d.dir !== undefined) openDir(d.dir);
  else if (d.docCreate) openDoc(d.docCreate, "Instructions", { create: true });
  else if (d.browse) { S.filesF = "browse"; go("files"); openDir(d.browse); }
  else if (d.stabOpen) { S.setTab = d.stabOpen; openSettings(); }
  else if (d.addfolder) { setRoots(S.roots.concat([d.addfolder])).then(() => S.doc && openDoc(S.doc.path)); }
  else if (d.docact) {
    const c = S.doc; if (!c) return;
    const a = d.docact;
    if (a === "back") closeDoc();
    else if (a === "edit") { c.editing = true; render(); }
    else if (a === "source") { c.editing = true; render(); }
    else if (a === "cancel") { if (c.isNew) closeDoc(); else { c.editing = false; render(); } }
    else if (a === "save") saveDoc();
    else if (a === "open") post("/api/open", { path: c.path }).then((r) => toast(r.error || "Opened on your Mac"));
    else if (a === "ask") { const p = c.path; startNewChat(p.slice(0, p.lastIndexOf("/"))); setTimeout(() => { const ta = $("#ta"); if (ta) { ta.value = "Read " + p + " and tell me what it is and what state it is in."; ta.dispatchEvent(new Event("input")); } }, 40); }
  }
});
document.addEventListener("click", (e) => { const t = e.target.closest("[data-act=addroot]"); if (t) addRoot(); }, true);
function addRoot() {
  const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickFolder;
  if (wk) { window.bridgeFolderPicked = async (p) => { await setRoots(S.roots.concat([String(p).replace(/\/+$/, "")])); window.bridgeFolderPicked = useFolder; softRender(); if ($("#modal").classList.contains("on")) openSettings(); }; wk.postMessage(S.roots[0] || ""); return; }
  const v = prompt("Folder to add. Bridge can only read the folders listed here:", S.roots[0] || "");
  if (v && v.trim()) setRoots(S.roots.concat([v.trim().replace(/\/+$/, "")])).then(() => { softRender(); if ($("#modal").classList.contains("on")) openSettings(); });
}

/* ── the home orb (the voice overlay draws its own, richer one) ──── */
const orbs = new Map();
function startOrb(cv, energy) {
  if (orbs.has(cv)) return; orbs.set(cv, 1);
  const ctx = cv.getContext("2d"), W = cv.width, R = W * 0.3, t0 = performance.now();
  (function frame(now) {
    if (!cv.isConnected) { orbs.delete(cv); return; }
    const t = (now - t0) / 1000; ctx.clearRect(0, 0, W, W);
    const cs = getComputedStyle(document.documentElement), acc = cs.getPropertyValue("--accent").trim(), acc2 = cs.getPropertyValue("--accent2").trim(), th = cs.getPropertyValue("--think").trim();
    const busy = runningList().length ? 1.6 : 1;
    const g = ctx.createRadialGradient(W / 2, W / 2, R * 0.2, W / 2, W / 2, W / 2);
    g.addColorStop(0, acc + "55"); g.addColorStop(1, "transparent"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, W);
    ctx.globalCompositeOperation = "lighter";
    [acc, acc2, th].forEach((c, k) => {
      ctx.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
        const wob = 1 + energy * 0.06 * Math.sin(a * (3 + k) + t * busy * (1.2 + k * 0.4)) + 0.03 * Math.sin(t * 2 + k);
        const x = W / 2 + Math.cos(a) * R * wob, y = W / 2 + Math.sin(a) * R * wob;
        a ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      const gg = ctx.createRadialGradient(W / 2 - R * 0.3, W / 2 - R * 0.35, 2, W / 2, W / 2, R * 1.1);
      gg.addColorStop(0, "#ffffffcc"); gg.addColorStop(0.35, c + "cc"); gg.addColorStop(1, c + "00");
      ctx.fillStyle = gg; ctx.globalAlpha = 0.55; ctx.fill();
    });
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(frame);
  })(t0);
}

/* ── ⌘K palette ──────────────────────────────────────────────────── */
let palSel = 0;
function openPalette() {
  $("#scrim").classList.add("on"); $("#palette").classList.add("on");
  const i = $("#palIn"); i.value = ""; palRender(""); i.focus();
}
function palRender(q) {
  q = q.toLowerCase();
  const rows = [
    ...[["New chat", "act", "new", "⌘T"], ["Talk to " + daName(), "act", "voice", ""], ["Search every chat's transcript", "act", "finder", "⌘F"], ["Inbox", "go", "inbox", ""], ["Files", "go", "files", ""], ["Activity log", "go", "activity", ""], ["Settings files", "go", "configs", ""],
      ["Toggle theme", "act", "theme", "⌘J"], ["Settings", "act", "settings", ""], [S.tech ? "Hide technical details" : "Show technical details", "act", "tech", ""], [authed() ? "Claude account" : "Sign in to Claude Code", "act", "signin", ""]]
      .map(([l, k, v, kb]) => ["Actions", "data-" + k + '="' + v + '"', l, kb, "bolt"]),
    ...runningList().map((r) => ["Working now", 'data-open="' + esc(r.key + "|" + r.id) + '"', r.title, r.projectName + " · " + r.step, "bolt"]),
    ...S.recent.slice(0, 80).map((s) => ["Chats", 'data-open="' + esc(s.project + "|" + s.id) + '"', s.title, projectName(s.projectPath) + " · " + fmtAgo(s.mtime), "inbox"]),
    ...S.home.projects.filter((p) => p.path !== homeDir()).map((p) => ["Projects", 'data-proj="' + esc(p.key) + '"', p.name, p.path.replace(homeDir(), "~"), "folder"]),
    ...S.home.made.map((f) => ["Files", 'data-doc="' + esc(f.path) + '"', f.name, f.sessionTitle, "file"]),
    ...S.agents.map((a) => ["Agents", 'data-assign="' + esc(a.name) + '"', a.name, String(a.description || "").slice(0, 90), "agents"]),
    ...S.skills.map((s) => ["Skills", 'data-doc="' + esc(s.path) + '"', s.label, String(s.desc || "").slice(0, 90), "spark"]),
    ...S.configs.filter((c) => c.group === "Core" || c.group === "Memory").map((c) => ["Settings files", 'data-doc="' + esc(c.path) + '"', c.label, c.path.replace(homeDir(), "~"), "file"]),
  ].filter((r) => !q || (r[2] + " " + r[3]).toLowerCase().includes(q));
  let last = "";
  const shown = rows.slice(0, 60);
  palSel = Math.min(palSel, Math.max(0, shown.length - 1));
  $("#palRes").innerHTML = shown.map((r, i) => { const h = r[0] !== last ? '<div class="menu-h">' + r[0] + "</div>" : ""; last = r[0]; return h + '<button class="mi ' + (i === palSel ? "sel" : "") + '" ' + r[1] + ">" + ic(r[4]) + '<span class="l"><b>' + esc(r[2]) + "</b>" + (r[3] ? "<span>" + esc(r[3]) + "</span>" : "") + "</span></button>"; }).join("") || '<div class="empty-c">No matches</div>';
  const sel = $("#palRes .mi.sel"); if (sel) { sel.style.background = "var(--bg-hover)"; sel.scrollIntoView({ block: "nearest" }); }
}
$("#palIn").addEventListener("input", (e) => { palSel = 0; palRender(e.target.value); });
$("#palIn").addEventListener("keydown", (e) => {
  const n = $$("#palRes .mi").length;
  if (e.key === "ArrowDown") { palSel = Math.min(palSel + 1, n - 1); palRender($("#palIn").value); e.preventDefault(); }
  else if (e.key === "ArrowUp") { palSel = Math.max(palSel - 1, 0); palRender($("#palIn").value); e.preventDefault(); }
  else if (e.key === "Enter") { const b = $("#palRes .mi.sel"); if (b) b.click(); }
});
$("#palRes").addEventListener("click", (e) => {
  const b = e.target.closest(".mi"); if (!b) return;
  closeOverlays();
  if (b.dataset.act === "finder") { e.stopPropagation(); openFinder(); }
});

/* ── ⌘F finder: searches whole transcripts ───────────────────────── */
let findScope = "folder", findSeq = 0, findT = 0;
const findCwd = () => (S.view === "chat" && S.chat && S.chat.path) || S.newPath || "";
function openFinder(seed, scope) {
  $("#finder").classList.add("on");
  if (scope) { findScope = scope; $$("#finder [data-scope]").forEach((x) => x.classList.toggle("on", x.dataset.scope === scope)); }
  const nm = projectName(findCwd());
  $("#segFolder").textContent = findCwd() && findCwd() !== homeDir() ? "In " + nm : "This folder";
  const inp = $("#finderIn");
  if (seed !== undefined) inp.value = seed;
  inp.focus(); inp.select();
  runFind();
}
function closeFinder() { $("#finder").classList.remove("on"); }
function hl(text, terms) {
  let h = esc(text);
  terms.forEach((t) => { if (t.length >= 3) h = h.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"), "<mark>$1</mark>"); });
  return h;
}
async function runFind() {
  const q = $("#finderIn").value.trim(), body = $("#finderBody");
  if (!q) { body.innerHTML = '<div class="empty-big">Say what you are after in your own words. Bridge searches the folder you are in first, then everywhere else, reading whole transcripts, not just titles.</div>'; $("#finderNote").textContent = "Bridge reads every transcript, not just titles."; return; }
  const seq = ++findSeq;
  $("#finderSpin").style.display = "";
  const hit = (scope) => getJ("/api/find?q=" + encodeURIComponent(q) + "&scope=" + scope + "&cwd=" + encodeURIComponent(findCwd())).catch(() => []);
  let res = await hit(findScope), widened = false;
  if (!res.length && findScope !== "all") { res = await hit("all"); widened = res.length > 0; }
  if (seq !== findSeq) return;
  $("#finderSpin").style.display = "none";
  const terms = q.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 2);
  $("#finderNote").textContent = widened ? "Nothing in this folder. " + res.length + " matches everywhere else" : res.length + " chats match, best first";
  body.innerHTML = res.length ? res.map((r) => '<button class="fres" data-open="' + esc(r.project + "|" + r.id) + '"><div class="t">' + hl(r.title, terms) + "</div>" +
    '<div class="m"><span>' + esc(projectName(r.projectPath)) + "</span><span>" + fmtAgo(r.mtime) + "</span><span>" + r.tools + " steps</span>" + (r.wrote.length ? "<span>" + r.wrote.length + " files written</span>" : "") + "</div>" +
    (r.first ? '<div class="s"><b>asked</b>' + hl(r.first, terms) + "</div>" : "") + (r.last ? '<div class="s"><b>ended</b>' + hl(r.last, terms) + "</div>" : "") +
    r.snippets.map((s) => '<div class="snip">' + hl(s, terms) + "</div>").join("") + "</button>").join("") : '<div class="empty-big">Nothing matched “' + esc(q) + "”.</div>";
}
$("#finderClose").onclick = closeFinder;
$("#finderIn").addEventListener("input", () => { clearTimeout(findT); findT = setTimeout(runFind, 350); });
$("#finderIn").addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(findT); runFind(); } });
$$("#finder [data-scope]").forEach((n) => (n.onclick = () => { findScope = n.dataset.scope; $$("#finder [data-scope]").forEach((x) => x.classList.toggle("on", x === n)); runFind(); }));
$("#finderBody").addEventListener("click", (e) => { if (e.target.closest(".fres")) closeFinder(); });

/* ── Settings ────────────────────────────────────────────────────── */
async function openSettings() {
  const tabs = [["general", "General"], ["voice", "Voice"], ["defaults", "Defaults"], ["computers", "Computers"], ["advanced", "Advanced"]];
  const row = (b, s, ctl) => '<div class="setting"><div class="l"><b>' + b + "</b><span>" + s + "</span></div>" + ctl + "</div>";
  const tog = (on, attr) => '<button class="toggle ' + (on ? "on" : "") + '" ' + attr + "></button>";
  const theme = document.documentElement.dataset.theme;
  const V = window.Voice ? Voice.state() : {};
  const L = S.lifeos;
  const body = {
    general: () => row("Appearance", "Dark is the Bridge default", '<div class="seg" style="width:170px"><button class="' + (theme === "light" ? "on" : "") + '" data-act="theme">Light</button><button class="' + (theme === "dark" ? "on" : "") + '" data-act="theme">Dark</button></div>') +
      row("Claude account", authed() ? "Signed in as " + esc(S.auth.email || (S.auth.keyAuth ? "an API key" : "Claude")) : "Not signed in", '<button class="btn" data-act="signin">' + (authed() ? "Manage" : "Sign in") + "</button>") +
      row("Notifications", "A card, a voice line and a Mac notification when a chat finishes or needs you", tog(ls("bridgeNotify") !== "0", 'data-sv="notify"')) +
      row("LifeOS", L && L.installed ? esc(L.versions.slice(0, 2).join(" · ")) : "Not installed under ~/.claude", L && L.dims && L.dims.length ? "" : "") +
      (L && L.dims && L.dims.length ? '<div class="dims">' + L.dims.map((d) => '<div class="dim"><span>' + esc(d.name) + '</span><span class="dim-bar"><span style="width:' + Math.max(0, Math.min(100, d.pct)) + '%"></span></span><span class="mono">' + d.pct + "%</span></div>").join("") + "</div>" : ""),
    voice: () => row("Speak answers aloud", esc(daName()) + " reads the short summary line", tog(!V.muted, 'data-sv="voice"')) +
      row("Hands-free", "The microphone reopens after each spoken answer", tog(V.hands, 'data-sv="hands"')) +
      row("Engines", V.health ? "Voice: " + esc({ elevenlabs: "ElevenLabs", kokoro: "Kokoro on this Mac", pulse: "Pulse", browser: "the browser" }[V.health.tts] || V.health.tts) + " · Ears: " + esc({ parakeet: "Parakeet on this Mac", mlx: "whisper (GPU)", none: "none installed" }[V.health.stt] || V.health.stt) : "Checking…", "") +
      row("Copilot model", "What " + esc(daName()) + " runs on when you talk", '<div class="seg" style="width:auto">' + ["", "sonnet", "opus", "haiku"].map((m) => '<button class="' + ((V.da && V.da.model) === m || (!(V.da && V.da.model) && !m) ? "on" : "") + '" data-damodel="' + m + '">' + esc(MODELS[m] ? MODELS[m][0] : m) + "</button>").join("") + "</div>") +
      row("Start a fresh conversation", "Clears what " + esc(daName()) + " remembers from this desk session", '<button class="btn" data-dareset>Reset</button>'),
    defaults: () => row("Default teammate", "Who gets a new chat. Change it in any composer too", '<span class="tag">' + esc(agentLook(S.agent === "" ? "none" : S.agent).name) + "</span>") +
      row("Default freedom", esc((MODES[S.perm] || {}).help || ""), '<span class="tag">' + esc((MODES[S.perm] || {}).label || S.perm) + "</span>") +
      row("Default model", "Effort " + esc(EFFORTS[S.effort] || S.effort), '<span class="tag">' + esc(S.ultra ? "God mode" : (MODELS[S.model] || [S.model])[0]) + "</span>") +
      row("New chats start in", esc(S.newPath ? S.newPath.replace(homeDir(), "~") : "Your home folder"), '<button class="btn" data-act="choosefolder">Change</button>') +
      '<p class="faint" style="font-size:12px;margin-top:10px">Bridge remembers whatever you last picked in the composer and uses it for the next chat.</p>',
    computers: () => row(esc(userName()) + "'s Mac", "Online · runs every chat here, with your local tools and simulators", '<span class="tag ok">Online</span>') +
      row("Cloud computer", "A second Bridge on a Fly sprite keeps working when this Mac sleeps. It is its own app for now: open it to run chats there.", '<a class="btn" href="https://bridge-x2x6.sprites.app/" target="_blank" rel="noopener">' + ic("ext") + "Open</a>") +
      row("Chats survive closing Bridge", "A chat keeps running on this Mac when you close the window. Reopen it and it picks up where it is.", '<span class="tag acc">Always on</span>'),
    advanced: () => row("Show technical details", "Raw tool calls next to each step, and their input and output on click", '<button class="toggle ' + (S.tech ? "on" : "") + '" data-act="tech"></button>') +
      row("Settings files", "CLAUDE.md, settings.json, memory, skills and agents", '<button class="btn" data-go="configs">Open</button>') +
      row("Global instructions", "~/.claude/CLAUDE.md applies to every chat", '<button class="btn" data-doc="' + esc(S.boot.claudeDir + "/CLAUDE.md") + '">Edit</button>') +
      row("Activity log", "Every turn, stop and save since Bridge started", '<button class="btn" data-go="activity">Open</button>') +
      '<div class="side-h" style="padding-left:0">Automations (hooks)</div>' + (S.hooks ? (S.hooks.map((h) => '<div class="hookrow"><b>' + esc(h.event) + "</b>" + esc([h.matcher !== "*" ? h.matcher : "", h.command ? short(h.command, 90) : h.type + " hook"].filter(Boolean).join(" · ")) + "</div>").join("") || '<p class="faint">None configured.</p>') : '<p class="faint">Loading…</p>') +
      '<div class="side-h" style="padding-left:0">Folders Bridge can see</div><div class="roots">' + S.roots.map((r) => '<div class="li"><span class="ico" style="background:var(--accent-soft);color:var(--accent)">' + ic("folder") + '</span><div class="l"><b>' + esc(base(r)) + "</b><span>" + esc(r.replace(homeDir(), "~")) + '</span></div><button class="icon-btn" data-rmroot="' + esc(r) + '" title="Stop showing this folder">' + ic("x") + "</button></div>").join("") +
      '<button class="btn mt8" data-act="addroot">' + ic("plus") + "Add a folder</button></div>",
  }[S.setTab]();
  $("#modal").innerHTML = '<div class="modal-h">' + ic("gear") + 'Settings<span style="flex:1"></span><button class="icon-btn" data-act="close">' + ic("x") + "</button></div>" +
    '<div class="modal-b"><div class="modal-nav">' + tabs.map(([k, l]) => '<button class="nav-i ' + (S.setTab === k ? "on" : "") + '" data-stab="' + k + '">' + l + "</button>").join("") + '</div><div class="modal-c">' + body + "</div></div>";
  $("#scrim").classList.add("on"); $("#modal").classList.add("on");
  if (S.setTab === "advanced" && !S.hooks) { S.hooks = await getJ("/api/hooks").catch(() => []); if (S.setTab === "advanced" && $("#modal").classList.contains("on")) openSettings(); }
}
$("#modal").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-stab],[data-sv],[data-rmroot],[data-damodel],[data-dareset],[data-go],[data-doc]");
  if (!t) return;
  const d = t.dataset;
  if (d.stab) { S.setTab = d.stab; openSettings(); }
  else if (d.go || d.doc) closeOverlays();
  else if (d.sv === "notify") { ls("bridgeNotify", ls("bridgeNotify") === "0" ? "1" : "0"); openSettings(); }
  else if (d.sv === "voice" && window.Voice) { Voice.setMuted(!Voice.state().muted); openSettings(); }
  else if (d.sv === "hands" && window.Voice) { Voice.setHands(!Voice.state().hands); openSettings(); }
  else if (d.rmroot) { if (confirm("Stop showing " + d.rmroot + " in Bridge?")) { await setRoots(S.roots.filter((x) => x !== d.rmroot)); openSettings(); } }
  else if (d.damodel !== undefined) { toast("Restarting " + daName() + "…"); await post("/api/da/config", { model: d.damodel }); if (window.Voice) await Voice.refresh(); openSettings(); }
  else if (d.dareset !== undefined) { await post("/api/da/reset"); if (window.Voice) Voice.refresh(); toast("Fresh conversation started"); }
});

/* ── sign in to Claude Code ──────────────────────────────────────────
 * The CLI's login is a terminal conversation: it prints a link, opens the browser, and waits on
 * stdin for the code the callback page shows. Bridge runs that same conversation here. */
const AUTH = { view: "idle", mode: "claudeai", url: "", err: "", busy: false };
function openSignin(why) {
  AUTH.view = "idle"; AUTH.err = why || ""; AUTH.url = ""; AUTH.busy = false;
  $("#signinBg").classList.add("on");
  renderSignin();
}
function closeSignin() {
  $("#signinBg").classList.remove("on");
  if (AUTH.view === "code") post("/api/auth/cancel");
  AUTH.view = "idle"; AUTH.url = "";
}
function renderSignin() {
  const a = S.auth || {}, body = $("#signinBody");
  const err = AUTH.err ? '<div class="sheet-err">' + esc(AUTH.err) + "</div>" : "";
  $("#signinTitle").textContent = AUTH.view === "code" ? "Finish signing in" : authed() ? "Your Claude account" : "Sign in to Claude Code";
  if (AUTH.view === "code") {
    body.innerHTML = err + '<p class="sheet-p">Your browser is open on the Claude sign-in page. Approve it, then paste the code it gives you back here.</p>' +
      '<ol class="sheet-steps"><li>Approve the sign-in in the browser.</li><li>Copy the code shown on the page it lands on.</li><li>Paste it below.</li></ol>' +
      '<a class="sheet-link" href="' + esc(AUTH.url) + '" target="_blank" rel="noreferrer">' + esc(AUTH.url) + "</a>" +
      '<input class="sheet-in" id="authCode" placeholder="Paste the code here" spellcheck="false" autocomplete="off">' +
      '<div class="sheet-row" style="margin-top:12px"><button class="btn pri" id="authGo"' + (AUTH.busy ? " disabled" : "") + ">" + (AUTH.busy ? "Signing in…" : "Finish sign-in") + '</button><button class="btn" id="authBack">Cancel</button></div>';
    const inp = $("#authCode");
    inp.onkeydown = (e) => { if (e.key === "Enter") finishSignin(); };
    setTimeout(() => inp.focus(), 30);
    $("#authGo").onclick = finishSignin;
    $("#authBack").onclick = () => { post("/api/auth/cancel"); AUTH.view = "idle"; AUTH.err = ""; renderSignin(); };
    return;
  }
  if (authed()) {
    body.innerHTML = err + '<p class="sheet-p">Bridge runs the real <b>claude</b> CLI as this account. Signing out here signs out every Claude Code session on this machine.</p>' +
      '<div class="sheet-kv"><span>Account</span><b>' + esc(a.email || (a.keyAuth ? "API key in the environment" : "signed in")) + "</b></div>" +
      '<div class="sheet-kv"><span>Plan</span><b>' + esc(a.subscriptionType || a.authMethod || "—") + "</b></div>" +
      (a.orgName ? '<div class="sheet-kv"><span>Organisation</span><b>' + esc(a.orgName) + "</b></div>" : "") +
      '<div class="sheet-row" style="margin-top:16px"><button class="btn" id="authOut"' + (a.keyAuth ? " disabled" : "") + '>Sign out</button><button class="btn" id="authAgain">Sign in as someone else</button></div>';
    const out = $("#authOut");
    if (out && !a.keyAuth) out.onclick = async () => {
      out.disabled = true; out.textContent = "Signing out…";
      const r = await post("/api/auth/logout");
      S.auth = r.status || (await refreshAuth(true));
      AUTH.err = r.ok ? "" : r.out || "logout did not take";
      toast(r.ok ? "Signed out" : "Could not sign out"); render(); renderSignin();
    };
    $("#authAgain").onclick = () => beginSignin(AUTH.mode);
    return;
  }
  body.innerHTML = err + '<p class="sheet-p">Bridge drives the <b>claude</b> CLI, and the CLI is not signed in yet. This does the whole thing here, no terminal.</p>' +
    '<div class="seg" style="margin:0 0 14px"><button class="' + (AUTH.mode === "claudeai" ? "on" : "") + '" data-mode="claudeai" title="Pro or Max">Claude subscription</button><button class="' + (AUTH.mode === "console" ? "on" : "") + '" data-mode="console" title="Pay per token">Anthropic Console</button></div>' +
    '<button class="btn pri" id="authStart"' + (AUTH.busy ? " disabled" : "") + ">" + (AUTH.busy ? "Opening your browser…" : "Sign in") + "</button>" +
    (a.cli === false ? '<p class="sheet-p" style="margin-top:14px">The <code>claude</code> command was not found on this machine. Install Claude Code first.</p>' : "");
  $$("[data-mode]", body).forEach((n) => (n.onclick = () => { AUTH.mode = n.dataset.mode; renderSignin(); }));
  $("#authStart").onclick = () => beginSignin(AUTH.mode);
}
async function beginSignin(mode) {
  AUTH.busy = true; AUTH.err = ""; AUTH.mode = mode || "claudeai"; AUTH.view = "idle"; renderSignin();
  const r = await post("/api/auth/login", { mode: AUTH.mode });
  AUTH.busy = false;
  if (r.error || !r.url) { AUTH.err = r.error || "could not start the sign-in"; renderSignin(); return; }
  AUTH.url = r.url; AUTH.view = "code"; renderSignin();
}
async function finishSignin() {
  const inp = $("#authCode"), code = inp ? inp.value.trim() : "";
  if (!code) { AUTH.err = "paste the code from the browser first"; renderSignin(); return; }
  AUTH.busy = true; AUTH.err = ""; renderSignin();
  const r = await post("/api/auth/code", { code });
  AUTH.busy = false;
  S.auth = r.status || (await refreshAuth(true));
  if (r.ok) { AUTH.view = "idle"; closeSignin(); render(); toast("Signed in" + (S.auth && S.auth.email ? " as " + S.auth.email : "")); return; }
  AUTH.err = r.error || "that did not go through";
  AUTH.view = r.restart ? "idle" : "code";
  renderSignin();
}
$("#signinClose").onclick = closeSignin;
$("#signinBg").onclick = (e) => { if (e.target.id === "signinBg") closeSignin(); };

boot();
