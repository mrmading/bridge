/* ══════════════════════ Bridge reorganize ══════════════════════
 * Projects › Reorganize: sort the work folder into projects one folder at a time. Plain code, no model:
 * pick a type (project / working folder / codebase / skip), then the project it belongs to. Nothing moves
 * until Review › Apply. Talks to /api/reorganize* (reorganize.ts). Keys: 1-4 pick, Backspace goes back. */
(function () {
  const R = { v: null, comp: null, step: "kind", kind: "", plan: null, busy: false, result: null };
  const KINDS = [["project", "Project", "This folder is the project's home"], ["working", "Working folder", "Docs, assets, deliverables of a project"], ["codebase", "Codebase", "Code that belongs to a project"], ["skip", "Skip", "Leave it where it is"]];
  const comp = () => R.comp || (cloudInfo().configured ? "cloud" : "mac");
  const q = (p) => "/api/reorganize" + p + (comp() === "cloud" ? "?computer=cloud" : "");
  const call = (p, body) => post("/api/reorganize/" + p, Object.assign({}, body || {}, comp() === "cloud" ? { computer: "cloud" } : {}));
  const ok = (r) => { if (!r || r.error) { toast((r && r.error) || "Something went wrong"); return false; } return true; };
  const short = (p) => String(p || "").replace(/^\/(home\/[^/]+|Users\/[^/]+)/, "~");
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

  async function load() {
    const r = await getJ(q("")).catch((e) => ({ error: String(e) }));
    R.v = r; R.step = "kind"; R.kind = "";
    paint();
  }
  function paint() { if (S.view !== "reorganize") return; const v = $("#roView"), y = v ? v.scrollTop : 0; $("#viewHost").innerHTML = VIEWS.reorganize(); const n = $("#roView"); if (n) n.scrollTop = y; }

  const kindLabel = (k) => (KINDS.find((x) => x[0] === k) || [k, k])[1];
  function factsCard(f) {
    const g = f.git;
    const rows = [
      f.broken ? '<span class="tag warn">Broken link → ' + esc(f.link) + "</span>" : f.link ? '<span class="tag">Link → ' + esc(short(f.link)) + "</span>" : "",
      g ? '<span class="tag acc">' + (g.worktree ? "git worktree of " + esc(g.of) : "git") + "</span>" : '<span class="tag">no git</span>',
      g && g.branch ? '<span class="tag">' + esc(g.branch) + "</span>" : "",
      g ? (g.remote ? '<span class="tag ok">' + esc(g.remote) + "</span>" : '<span class="tag warn">no remote</span>') : "",
      g && g.dirty ? '<span class="tag warn">' + g.dirty + " uncommitted</span>" : "",
      f.items ? '<span class="tag">' + f.items + " items</span>" : "",
      f.modified ? '<span class="tag">edited ' + day(f.modified) + "</span>" : "",
    ].filter(Boolean).join(" ");
    return '<div class="card" style="cursor:default;padding:18px"><div class="ch">' + ic("folder") + '<span class="ct" style="font-size:18px">' + esc(f.name) + "</span></div>" +
      '<div class="row" style="flex-wrap:wrap;gap:6px;margin:8px 0">' + rows + "</div>" +
      (f.readme ? "<p>" + esc(f.readme) + "</p>" : "") +
      (g && g.last ? '<p class="faint" style="font-size:12px;margin-top:6px">Last commit: ' + esc(g.last) + "</p>" : "") +
      (f.sample && f.sample.length ? '<p class="faint mono" style="font-size:12px;margin-top:6px">' + esc(f.sample.join("  ")) + "</p>" : "") + "</div>";
  }
  function stepKind(f) {
    return '<div class="grid" style="margin-top:12px">' + KINDS.map(([k, l, d], i) =>
      '<button class="card" data-ro="kind" data-v="' + k + '"><div class="ch"><span class="tag">' + (i + 1) + '</span><span class="ct">' + l + "</span></div><p>" + d + "</p></button>").join("") + "</div>";
  }
  function stepProject(f) {
    const v = R.v, guess = f.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const opts = v.projects.map((p) => ({ name: p.name, note: p.root ? "home: " + p.root : p.count ? p.count + " filed" : "", taken: R.kind === "project" && !!p.root }));
    return '<p class="sub mt12"><b>' + esc(kindLabel(R.kind)) + "</b> · which project " + (R.kind === "project" ? "is this the home of?" : "does it belong to?") + ' <button class="more" data-ro="back">Back</button></p>' +
      '<div class="grid" style="margin-top:10px">' + opts.map((o, i) =>
        '<button class="card" data-ro="pick" data-v="' + esc(o.name) + '"' + (o.taken ? " disabled style=\"opacity:.45\"" : "") + '><div class="ch">' + (i < 9 ? '<span class="tag">' + (i + 1) + "</span>" : "") + '<span class="ct">' + esc(o.name) + "</span></div><p>" + esc(o.taken ? "already has a home" : o.note || "") + "</p></button>").join("") + "</div>" +
      '<div class="row mt12" style="gap:8px"><input class="sheet-in" id="roNew" placeholder="New project name" value="' + esc(R.kind === "project" ? guess : "") + '" autocomplete="off" spellcheck="false" style="flex:1"><button class="btn pri" data-ro="new">Create &amp; file</button></div>';
  }
  function planView() {
    const p = R.plan;
    return sec("folder", "Moves", '<span class="tag">' + p.moves.length + "</span>", ' <button class="more" data-ro="close-plan">Back to sorting</button>') +
      '<p class="sub">From <code>' + esc(short(p.root)) + "</code> into <code>" + esc(short(p.target)) + "</code>. Each folder leaves a link at its old path, its chats follow it, and git worktrees are repaired. Undo reverses the whole batch.</p>" +
      (p.problems.length ? '<div class="cn-err mt12">' + p.problems.map(esc).join("<br>") + "</div>" : "") +
      '<div class="list mt12">' + p.moves.map((m) => '<div class="li"><span class="tag ' + (m.type === "project" ? "acc" : "") + '">' + esc(kindLabel(m.type)) + '</span><div class="l"><b style="font-weight:500">' + esc(m.folder) + "</b><span>" + esc(short(m.to)) + (m.exclude ? " · kept out of the project's git" : "") + "</span></div></div>").join("") + "</div>" +
      '<p class="faint mt12" style="font-size:12px">' + p.skipped.length + " skipped · " + p.undecided.length + " not sorted yet (they stay put)</p>" +
      '<div class="row mt12" style="gap:8px"><button class="btn pri" data-ro="apply"' + (R.busy || !p.moves.length ? " disabled" : "") + ">" + (R.busy ? "Moving…" : "Apply " + p.moves.length + " moves") + "</button></div>";
  }

  VIEWS.reorganize = function () {
    const v = R.v;
    if (!v) { load(); return '<div class="view"><div class="wrap"><h1 class="big">Reorganize</h1><div class="empty-big"><span class="spin-s" style="display:inline-block"></span></div></div></div>'; }
    const head = '<div class="crumbs"><button data-go="projects">Projects</button>›<b>Reorganize</b></div>' +
      '<div class="row" style="align-items:flex-end;gap:12px;flex-wrap:wrap"><div style="flex:1;min-width:240px"><h1 class="big">Reorganize</h1>' +
      (v.error ? "" : '<p class="sub mt8">Sort <code>' + esc(short(v.root)) + "</code> into projects under <code>" + esc(short(v.target)) + "</code>. " + v.done + " of " + v.total + " sorted. Nothing moves until you apply.</p>") + "</div>" +
      (cloudInfo().configured ? '<div class="seg" style="width:220px;margin:0"><button class="' + (comp() === "mac" ? "on" : "") + '" data-ro="comp" data-v="mac">This Mac</button><button class="' + (comp() === "cloud" ? "on" : "") + '" data-ro="comp" data-v="cloud">Cloud computer</button></div>' : "") + "</div>";
    if (v.error) return '<div class="view" id="roView"><div class="wrap wide">' + head + '<div class="cn-err mt12">' + esc(v.error) + "</div></div></div>";
    let main = "";
    if (R.result) main = '<div class="card mt12" style="cursor:default"><p><b style="color:var(--fg)">' + esc(R.result) + "</b></p></div>";
    if (R.plan) main += planView();
    else if (!v.rootExists) main += empty("No folder at " + short(v.root), "Set BRIDGE_REORG_ROOT on this computer's Bridge.");
    else if (!v.current) main += empty("Every folder is sorted.", "Review the moves, then apply them.");
    else main += factsCard(v.current) + (R.step === "project" ? stepProject(v.current) : stepKind(v.current));
    const filed = v.decisions.slice(0, 60).map((d) => '<div class="li"><div class="l"><b style="font-weight:500">' + esc(d.folder) + "</b><span>" + esc(kindLabel(d.type) + (d.project ? " · " + d.project : "")) + '</span></div><button class="icon-btn" title="Sort again" data-ro="undo-one" data-v="' + esc(d.folder) + '">' + ic("x") + "</button></div>").join("");
    const side = sec("check", "Sorted", '<span class="tag">' + v.decisions.length + "</span>") +
      '<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn pri" data-ro="plan"' + (v.decisions.length ? "" : " disabled") + ">Review moves</button>" +
      (v.last ? '<button class="btn" data-ro="undo-apply" title="Applied ' + esc(new Date(v.last.at).toLocaleString()) + '">Undo last apply (' + v.last.moved + ")</button>" : "") + "</div>" +
      '<div class="list mt12">' + (filed || '<div class="empty-c">Nothing sorted yet</div>') + "</div>";
    return '<div class="view" id="roView"><div class="wrap wide">' + head +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;margin-top:16px;align-items:start"><div>' + main + "</div><div>" + side + "</div></div></div></div>";
  };

  async function decide(project) {
    const f = R.v && R.v.current;
    if (!f || R.busy) return;
    R.busy = true;
    const r = await call("decide", { folder: f.name, type: R.kind, project }).catch((e) => ({ error: String(e) }));
    R.busy = false;
    if (!ok(r)) return;
    R.v = r; R.step = "kind"; R.kind = ""; R.result = null; paint();
  }
  function pickKind(k) {
    if (k === "skip") { R.kind = "skip"; decide(""); return; }
    R.kind = k; R.step = "project"; paint();
  }

  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-ro]");
    if (!t || t.disabled) return;
    const a = t.dataset.ro, v = t.dataset.v;
    if (a === "comp") { R.comp = v; R.v = null; R.plan = null; R.result = null; paint(); load(); }
    else if (a === "kind") pickKind(v);
    else if (a === "pick") decide(v);
    else if (a === "new") { const n = (($("#roNew") || {}).value || "").trim(); if (!n) return toast("Name the project"); decide(n); }
    else if (a === "back") { R.step = "kind"; R.kind = ""; paint(); }
    else if (a === "undo-one") { const r = await call("undecide", { folder: v }); if (ok(r)) { R.v = r; R.plan = null; paint(); } }
    else if (a === "plan") { const r = await getJ(q("/plan")).catch((e) => ({ error: String(e) })); if (ok(r)) { R.plan = r; R.result = null; paint(); } }
    else if (a === "close-plan") { R.plan = null; paint(); }
    else if (a === "apply") {
      if (!confirm("Move " + R.plan.moves.length + " folders into " + short(R.plan.target) + "? Each leaves a link at its old path, and Undo reverses it.")) return;
      R.busy = true; paint();
      const r = await call("apply").catch((e) => ({ error: String(e) }));
      R.busy = false;
      if (!ok(r)) { paint(); return; }
      R.plan = null; R.v = r.view;
      R.result = "Moved " + r.moved + " folders and " + r.chats + " chat histories." + (r.errors.length ? " Problems: " + r.errors.join("; ") : "") + (r.blocked.length ? " Not moved (target exists): " + r.blocked.join(", ") : "");
      paint();
    }
    else if (a === "undo-apply") {
      if (!confirm("Put every folder from the last apply back where it was?")) return;
      const r = await call("undo").catch((e) => ({ error: String(e) }));
      if (!ok(r)) return;
      R.v = r.view; R.plan = null; R.result = "Restored " + r.restored + " folders." + (r.errors.length ? " Problems: " + r.errors.join("; ") : ""); paint();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (S.view !== "reorganize" || !R.v || !R.v.current || R.plan || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (typing) { if (e.key === "Enter" && e.target.id === "roNew") { e.preventDefault(); const n = e.target.value.trim(); if (n) decide(n); } else if (e.key === "Escape") e.target.blur(); return; }
    const n = Number(e.key);
    if (R.step === "kind" && n >= 1 && n <= 4) { e.preventDefault(); pickKind(KINDS[n - 1][0]); }
    else if (R.step === "project" && n >= 1 && n <= 9) { const p = R.v.projects[n - 1]; if (p && !(R.kind === "project" && p.root)) { e.preventDefault(); decide(p.name); } }
    else if (R.step === "project" && (e.key === "Backspace" || e.key === "Escape")) { e.preventDefault(); R.step = "kind"; R.kind = ""; paint(); }
  });
})();
