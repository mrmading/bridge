/* ══════════════════════ Bridge connectors ══════════════════════
 * The Connectors screen (catalog, any MCP URL, self-made connectors), the sign-in / token / build
 * sheets, and the per-chat switches. Talks to /api/connectors* (connectors/routes.ts). Tokens go in
 * and never come back: the server answers with a masked hint. Uses app.js's helpers and #modal. */
(function () {
  const C = { list: null, catalog: [], device: {}, comp: "mac", busy: {}, open: null, poll: 0, sheet: null };
  const q = () => (C.comp === "cloud" ? "?computer=cloud" : "");
  const call = (path, body) => post("/api/connectors" + path, Object.assign({}, body || {}, C.comp === "cloud" ? { computer: "cloud" } : {}));
  const ok = (r) => { if (r && r.error) { toast(r.error); return false; } return true; };
  I.plug = '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>';
  I.wand = '<path d="M4 20L16 8M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3L21 13l-1.3.7L19 15l-.7-1.3L17 13l1.3-.7z"/>';

  async function load() {
    const r = await getJ("/api/connectors" + q()).catch((e) => ({ error: String(e) }));
    if (r.error) { C.list = []; C.err = r.error; } else { C.list = r.connectors; C.catalog = r.catalog; C.device = r.device || {}; C.err = ""; }
    if (S.view === "connectors") paint();
    if (C.sheet) C.sheet();
    const busy = (C.list || []).some((c) => c.status === "generating" || C.busy[c.id] === "oauth" || C.busy[c.id] === "device");
    clearTimeout(C.poll);
    if (busy && (S.view === "connectors" || $("#modal").classList.contains("on"))) C.poll = setTimeout(load, 2000);
  }
  const byId = (id) => (C.list || []).find((c) => c.id === id);
  const entry = (id) => C.catalog.find((e) => e.id === id);

  /* ── pieces ───────────────────────────────────────────────────── */
  const glyph = (g, color, size) => '<span class="cn-g" style="--c:' + esc(color || "var(--accent)") + (size ? ";width:" + size + "px;height:" + size + "px" : "") + '">' + esc(g || "?") + "</span>";
  function status(c) {
    if (c.status === "generating" || c.generating) return '<span class="tag acc"><span class="spin-s"></span> Building</span>';
    if (c.status === "connected") return '<span class="tag ok">Connected · ' + (c.tools || []).length + " tools</span>";
    if (c.status === "needs-auth") return '<span class="tag warn">' + (c.secret ? "Sign-in refused" : "Needs sign-in") + "</span>";
    if (c.status === "error") return '<span class="tag err">Error</span>';
    return '<span class="tag">Not tested</span>';
  }
  const authChips = (e) => e.auth.map((a) => '<span class="tag">' + ({ oauth: "OAuth", token: "Token", none: "No sign-in", device: "Device code" }[a] || a) + "</span>").join("") +
    (e.availability === "limited" ? '<span class="tag warn">Limited</span>' : "") + (e.verified ? "" : '<span class="tag warn">Unverified</span>');
  const lc = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
  const tog = (on, attr) => '<button class="toggle ' + (on ? "on" : "") + '" ' + attr + "></button>";

  function mine(c) {
    const open = C.open === c.id;
    const acts = [];
    if (c.status === "generating") acts.push('<button class="btn" data-cn="view" data-id="' + esc(c.id) + '">' + ic("eye") + "Watch it build</button>");
    else {
      acts.push('<button class="btn" data-cn="test" data-id="' + esc(c.id) + '">' + (C.busy[c.id] === "test" ? '<span class="spin-s"></span>' : ic("bolt")) + "Test</button>");
      if (c.kind === "remote" && c.auth !== "none" || c.kind === "local" && c.local && c.local.authKind !== "none") acts.push('<button class="btn' + (c.status === "needs-auth" ? " pri" : "") + '" data-cn="auth" data-id="' + esc(c.id) + '">' + ic("shield") + (c.secret ? "Change sign-in" : "Sign in") + "</button>");
      if (c.kind === "local") acts.push('<button class="btn" data-cn="code" data-id="' + esc(c.id) + '">' + ic("code") + "Code</button>");
      if (c.secret) acts.push('<button class="btn" data-cn="disconnect" data-id="' + esc(c.id) + '">Disconnect</button>');
    }
    acts.push('<button class="icon-btn" data-cn="remove" data-id="' + esc(c.id) + '" title="Remove">' + ic("trash") + "</button>");
    const sub = c.kind === "local" ? "Made by Bridge · " + (c.local.baseUrl || "from your description") : String(c.url || "").replace(/^https?:\/\//, "");
    return '<div class="cn-row' + (open ? " open" : "") + '"><div class="cn-top" data-cn="toggle-open" data-id="' + esc(c.id) + '">' + glyph(c.glyph, c.color) +
      '<div class="l"><b>' + esc(c.name) + "</b><span>" + esc(sub) + (c.secret ? " · " + esc(c.secret.kind === "oauth" ? "signed in" : "token " + c.secret.hint) : "") + "</span></div>" + status(c) +
      '<label class="cn-def" title="On for every thread unless a folder or thread turns it off">' + tog(c.enabled, 'data-cn="enabled" data-id="' + esc(c.id) + '"') + "</label></div>" +
      (open ? '<div class="cn-more">' + (c.error ? '<div class="cn-err">' + esc(c.error) + "</div>" : "") +
        ((c.tools || []).length ? '<div class="cn-tools">' + c.tools.map((t) => '<div class="cn-tool"><code>' + esc(t.name) + "</code><span>" + esc(String(t.description || "").split("\n")[0].slice(0, 140)) + "</span></div>").join("") + "</div>" : "") +
        '<div class="row mt8" style="flex-wrap:wrap;gap:6px">' + acts.join("") + "</div></div>" : "") + "</div>";
  }
  function catCard(e) {
    const have = (C.list || []).some((c) => c.catalogId === e.id);
    return '<button class="card cn-cat" data-cn="connect" data-cat="' + esc(e.id) + '"><div class="ch">' + glyph(e.glyph, e.color, 30) + '<span class="ct">' + esc(e.name) + "</span>" + (have ? '<span class="tag ok">Added</span>' : "") + "</div>" +
      "<p>" + esc(e.blurb) + '</p><div class="cn-chips">' + authChips(e) + "</div></button>";
  }

  VIEWS.connectors = function () {
    if (!C.list) { load(); return '<div class="view"><div class="wrap"><h1 class="big">Connectors</h1><div class="empty-big"><span class="spin-s" style="display:inline-block"></span></div></div></div>'; }
    const cloud = cloudInfo().configured;
    const list = C.list;
    return '<div class="view" id="cnView"><div class="wrap wide"><div class="row" style="align-items:flex-end;gap:12px;flex-wrap:wrap"><div style="flex:1;min-width:240px"><h1 class="big">Connectors</h1>' +
      '<p class="sub mt8">Give every thread real tools: GitHub, Linear, Notion, any MCP server, or one Bridge writes for your API.</p></div>' +
      (cloud ? '<div class="seg" style="width:220px;margin:0"><button class="' + (C.comp === "mac" ? "on" : "") + '" data-cn="comp" data-v="mac">This Mac</button><button class="' + (C.comp === "cloud" ? "on" : "") + '" data-cn="comp" data-v="cloud">Cloud computer</button></div>' : "") + "</div>" +
      (C.err ? '<div class="cn-err mt12">' + esc(C.err) + "</div>" : "") +
      sec("plug", "Your connectors", '<span class="tag">' + list.length + "</span>") +
      (list.length ? '<div class="cn-list">' + list.map(mine).join("") + "</div>" : empty("Nothing connected yet.", "Pick one below. A connector is an MCP server; every thread you start gets its tools.")) +
      sec("wand", "Make your own") +
      '<div class="grid two"><button class="card cn-cat" data-cn="url"><div class="ch">' + glyph("//", "#8b93a7", 30) + '<span class="ct">Any MCP server</span></div><p>Paste the URL of a remote MCP server, with a token or OAuth if it needs one.</p></button>' +
      '<button class="card cn-cat cn-new" data-cn="new"><div class="ch">' + glyph("+", "var(--accent)", 30) + '<span class="ct">New connector</span></div><p>Give an API URL (and an OpenAPI spec if there is one), or describe it in words. Bridge writes a small MCP server and tests it.</p></button></div>' +
      sec("globe", "Catalog", '<span class="tag">' + C.catalog.length + "</span>") +
      '<div class="grid">' + C.catalog.filter((e) => e.availability === "available").map(catCard).join("") + "</div>" +
      '<h2 class="sec" style="margin-top:22px">' + ic("hand") + 'Limited by the vendor</h2><div class="grid">' + C.catalog.filter((e) => e.availability !== "available").map(catCard).join("") + "</div>" +
      '<p class="faint mt12" style="font-size:12px">Tokens stay on the computer that runs the threads, in a file only Bridge can read. Turn a connector off for one folder or one thread from the thread’s ⋯ menu or the composer’s + menu.</p></div></div>';
  };
  function paint() { if (S.view !== "connectors") return; const v = $("#cnView"), y = v ? v.scrollTop : 0; $("#viewHost").innerHTML = VIEWS.connectors(); const n = $("#cnView"); if (n) n.scrollTop = y; }

  /* ── sheets (in #modal) ───────────────────────────────────────── */
  function sheet(title, html, render) {
    C.sheet = render || null;
    $("#modal").innerHTML = '<div class="modal-h">' + ic("plug") + esc(title) + '<span style="flex:1"></span><button class="icon-btn" data-act="close">' + ic("x") + '</button></div><div class="cn-sheet">' + html + "</div>";
    $("#scrim").classList.add("on"); $("#modal").classList.add("on");
  }
  const field = (label, input, help) => '<label class="cn-f"><span>' + label + "</span>" + input + (help ? "<small>" + help + "</small>" : "") + "</label>";
  const inp = (id, ph, type, val) => '<input class="sheet-in" id="' + id + '" type="' + (type || "text") + '" placeholder="' + esc(ph || "") + '" value="' + esc(val || "") + '" spellcheck="false" autocomplete="off">';
  const val = (id) => (($("#" + id) || {}).value || "").trim();

  const redirectUri = () => location.origin + "/connectors-callback.html";
  const ownAppFields = (o) => '<div class="cn-opt"><b>Your ' + esc(o.label || "OAuth app") + "</b><span>" + esc(o.steps || "") + "</span>" +
    field("Redirect URL", '<input class="sheet-in" readonly value="' + esc(redirectUri()) + '" onclick="this.select()">') +
    (o.help ? '<span><a href="' + esc(o.help) + '" target="_blank" rel="noopener">Open ' + esc(new URL(o.help).host) + " " + ic("ext") + "</a></span>" : "") +
    field("Client ID", inp("cnCid", "")) + (o.secret !== false ? field("Client Secret", inp("cnCsec", "", "password")) : "") + "</div>";
  const ownApp = () => (val("cnCid") ? { clientId: val("cnCid"), clientSecret: val("cnCsec") } : {});
  function ownAppSheet(c) {
    const o = (entry(c.catalogId) || {}).ownApp || { label: "OAuth app", secret: true, steps: "This server does not let apps register themselves. Create an OAuth app at the vendor with the redirect URL below, then paste its Client ID and Secret." };
    sheet(c.name + " needs your own app", ownAppFields(o) + '<div class="row mt12"><button class="btn pri" data-cn="own-app" data-id="' + esc(c.id) + '">Continue to sign in</button></div>');
  }

  function connectSheet(e) {
    const tok = e.token, multi = e.auth.length > 1;
    const params = (e.params || []).map((p) => field(esc(p.label), inp("cnp_" + p.key, p.placeholder), esc(p.help || ""))).join("");
    let h = '<div class="cn-head">' + glyph(e.glyph, e.color, 40) + '<div><b>' + esc(e.name) + "</b><span>" + esc(e.blurb) + "</span></div></div>" +
      (e.note ? '<div class="cn-note">' + esc(e.note) + "</div>" : "") +
      '<div class="cn-meta"><code>' + esc(e.url) + '</code> · <a href="' + esc(e.docs) + '" target="_blank" rel="noopener">docs</a>' + (e.verified ? ' · <span class="ok">checked against the vendor docs</span>' : ' · <span class="warn">not verified</span>') + "</div>" + params;
    if (e.auth.includes("oauth") && e.ownApp) h += ownAppFields(e.ownApp);
    if (e.auth.includes("oauth")) h += '<div class="cn-opt"><b>Sign in with ' + esc(e.name) + "</b><span>Opens " + esc(e.name) + "’s sign-in page." + (e.ownApp ? "" : " Nothing to copy.") + "</span>" + '<button class="btn pri" data-cn="add-oauth" data-cat="' + esc(e.id) + '">Sign in</button></div>';
    if (e.auth.includes("device")) h += '<div class="cn-opt"><b>Sign in with a device code</b><span>' + (C.device.github ? "GitHub shows a code; you type it at github.com/login/device." : "Needs a GitHub OAuth App on this Bridge (BRIDGE_GITHUB_CLIENT_ID). Use a token for now.") + "</span>" + '<button class="btn' + (C.device.github ? " pri" : "") + '" data-cn="add-device" data-cat="' + esc(e.id) + '"' + (C.device.github ? "" : " disabled") + ">Get a code</button></div>";
    if (e.auth.includes("token")) h += '<div class="cn-opt"><b>' + (multi ? "Or paste " : "Paste ") + esc(lc(tok.label)) + '</b><span><a href="' + esc(tok.help) + '" target="_blank" rel="noopener">Where do I get this? ' + ic("ext") + "</a></span>" +
      '<div class="row mt8">' + inp("cnTok", tok.placeholder || "paste here", "password") + '<button class="btn pri" data-cn="add-token" data-cat="' + esc(e.id) + '">Connect</button></div></div>';
    if (e.auth.includes("none")) h += '<div class="cn-opt"><b>' + (e.auth[0] === "none" ? "No sign-in needed" : "Without a key") + "</b><span>Public server.</span>" + '<button class="btn pri" data-cn="add-none" data-cat="' + esc(e.id) + '">Connect</button></div>';
    sheet("Connect " + e.name, h);
  }
  function oauthWait(c, url) {
    C.busy[c.id] = "oauth";
    const render = () => {
      const cur = byId(c.id) || c;
      if (cur.status === "connected") { delete C.busy[c.id]; sheet("Connected", '<div class="cn-head">' + glyph(cur.glyph, cur.color, 40) + "<div><b>" + esc(cur.name) + "</b><span>" + (cur.tools || []).length + ' tools ready for your threads.</span></div></div><div class="row mt12"><button class="btn pri" data-act="close">Done</button></div>'); C.sheet = null; return; }
      sheet("Sign in to " + c.name, '<p class="sub">Finish signing in on the ' + esc(c.name) + ' page that just opened. ' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">Open it again</a>.' : "") + "</p>" +
        '<div class="cn-wait"><span class="spin-s"></span> Waiting for ' + esc(c.name) + "…</div>" +
        field("Ended up on a page that said “Almost there”? Paste its address", '<div class="row">' + inp("cnBack", "http…/connectors-callback.html?code=…") + '<button class="btn" data-cn="oauth-paste" data-id="' + esc(c.id) + '">Finish</button></div>') +
        (cur.error && cur.status !== "needs-auth" ? '<div class="cn-err">' + esc(cur.error) + "</div>" : ""), render);
    };
    render(); load();
  }
  async function startOAuthFor(c, app) {
    const w = window.open("about:blank", "_blank");
    const r = await call("/oauth/start", Object.assign({ id: c.id, redirectUri: redirectUri() }, app || {}));
    if (!ok(r)) { if (w) w.close(); return; }
    if (r.needsClient) { if (w) w.close(); return ownAppSheet(c); }
    if (w) w.location = r.authorizeUrl; else location.href = r.authorizeUrl;
    oauthWait(c, r.authorizeUrl);
  }
  // the callback tab hands its address to this tab, which has the Bridge session
  addEventListener("message", async (ev) => {
    if (ev.origin !== location.origin || !ev.data || !ev.data.bridgeOAuth) return;
    const r = await call("/oauth/finish", { url: ev.data.bridgeOAuth });
    try { ev.source.postMessage({ bridgeOAuthDone: true, error: r.error || "", name: r.connector && r.connector.name }, location.origin); } catch (x) {}
    if (r.error) toast(r.error); else toast("Connected " + (r.connector ? r.connector.name : ""));
    load();
  });
  async function deviceFor(c) {
    const r = await call("/device/start", { id: c.id });
    if (!ok(r)) return;
    C.busy[c.id] = "device";
    window.open(r.verification_uri, "_blank", "noopener");
    const render = () => {
      const cur = byId(c.id) || c;
      if (cur.status === "connected") { delete C.busy[c.id]; sheet("Connected", "<p>" + esc(cur.name) + " is connected with " + (cur.tools || []).length + ' tools.</p><div class="row mt12"><button class="btn pri" data-act="close">Done</button></div>'); C.sheet = null; return; }
      sheet("Sign in to GitHub", '<p class="sub">Type this code at <a href="' + esc(r.verification_uri) + '" target="_blank" rel="noopener">' + esc(r.verification_uri.replace(/^https:\/\//, "")) + '</a></p><div class="cn-code">' + esc(r.user_code) + '</div><div class="cn-wait"><span class="spin-s"></span> Waiting for GitHub…</div>', render);
    };
    render(); load();
  }
  function authSheet(c) {
    if (c.catalogId && entry(c.catalogId)) {
      const e = entry(c.catalogId);
      let h = '<div class="cn-head">' + glyph(c.glyph, c.color, 40) + "<div><b>" + esc(c.name) + "</b><span>" + esc(c.secret ? "Signed in · " + c.secret.hint : "Not signed in") + "</span></div></div>";
      if (e.auth.includes("oauth")) h += '<div class="cn-opt"><b>Sign in with ' + esc(e.name) + '</b><span>OAuth, renewed by Bridge before it expires.</span><button class="btn pri" data-cn="oauth" data-id="' + esc(c.id) + '">Sign in</button></div>';
      if (e.auth.includes("device") && C.device.github) h += '<div class="cn-opt"><b>Device code</b><span>Type a code at github.com.</span><button class="btn" data-cn="device" data-id="' + esc(c.id) + '">Get a code</button></div>';
      if (e.token) h += '<div class="cn-opt"><b>Paste ' + esc(lc(e.token.label)) + '</b><span><a href="' + esc(e.token.help) + '" target="_blank" rel="noopener">Where do I get this? ' + ic("ext") + '</a></span><div class="row mt8">' + inp("cnTok", e.token.placeholder || "paste here", "password") + '<button class="btn pri" data-cn="token" data-id="' + esc(c.id) + '">Save</button></div></div>';
      return sheet("Sign in · " + c.name, h);
    }
    const h = '<div class="cn-head">' + glyph(c.glyph, c.color, 40) + "<div><b>" + esc(c.name) + "</b><span>" + esc(c.secret ? "Token " + c.secret.hint : "No token yet") + "</span></div></div>" +
      (c.kind === "remote" ? '<div class="cn-opt"><b>Sign in with OAuth</b><span>If the server supports MCP sign-in.</span><button class="btn" data-cn="oauth" data-id="' + esc(c.id) + '">Sign in</button></div>' : "") +
      '<div class="cn-opt"><b>Paste a token</b><span>Stored on the server only; Bridge never shows it again.</span><div class="row mt8">' + inp("cnTok", "token", "password") + '<button class="btn pri" data-cn="token" data-id="' + esc(c.id) + '">Save</button></div></div>';
    sheet("Sign in · " + c.name, h);
  }
  function urlSheet() {
    sheet("Any MCP server",
      field("Name", inp("cnName", "My server")) + field("Server URL", inp("cnUrl", "https://example.com/mcp"), "Streamable HTTP. Claude Code connects to it on every thread turn.") +
      field("Sign-in", '<div class="seg" id="cnAuth" style="margin:0"><button class="on" data-v="none">None</button><button data-v="token">Token</button><button data-v="oauth">OAuth</button></div>') +
      '<div id="cnTokBox" style="display:none">' + field("Header", '<div class="row">' + inp("cnHdr", "Authorization", "text", "Authorization") + inp("cnPre", "Bearer ", "text", "Bearer ") + "</div>") + field("Token", inp("cnTok", "paste here", "password")) + "</div>" +
      '<div class="row mt12"><button class="btn pri" data-cn="add-url">Connect</button></div>');
  }
  function newSheet(mode) {
    mode = mode || "api";
    const auth = '<select class="sheet-in" id="cnAk"><option value="none">No auth</option><option value="bearer">Bearer token</option><option value="header">API key in a header</option><option value="query">API key in the query string</option><option value="basic">Basic (user:password)</option></select>';
    sheet("New connector",
      '<div class="seg" style="margin:0 0 12px"><button class="' + (mode === "api" ? "on" : "") + '" data-cn="newmode" data-v="api">From an API</button><button class="' + (mode === "words" ? "on" : "") + '" data-cn="newmode" data-v="words">Describe it</button></div>' +
      field("Name", inp("cnName", mode === "api" ? "Placeholder API" : "Padel court prices")) +
      (mode === "words" ? field("What should it do?", '<textarea class="sheet-in cn-ta" id="cnDesc" placeholder="Tools to list, search and read issues from our internal tracker at https://…, or: run ~/scripts/report.sh with a date and return the CSV"></textarea>', "Bridge turns this into tools that call an API or run a script.") : "") +
      field("API base URL" + (mode === "words" ? " (optional)" : ""), inp("cnBase", "https://api.example.com/v1")) +
      (mode === "api" ? field("OpenAPI spec URL (optional)", inp("cnSpec", "https://api.example.com/openapi.json"), "With a spec Bridge picks the most useful operations. Without one it reads the API's docs.") : "") +
      '<div class="row" style="gap:10px;align-items:flex-start">' + field("Auth", auth) + '<div id="cnAkName" style="display:none;flex:1">' + field("Header / parameter name", inp("cnAkN", "x-api-key")) + "</div></div>" +
      '<div id="cnTokBox" style="display:none">' + field("Token", inp("cnTok", "paste here", "password"), "Kept on the server; the generated code reads it from the environment, never from the file.") + "</div>" +
      (mode === "api" ? field("Anything else? (optional)", '<textarea class="sheet-in cn-ta" id="cnDesc" style="height:64px" placeholder="Only read endpoints; focus on orders and customers"></textarea>') : "") +
      '<div class="row mt12"><button class="btn pri" data-cn="add-new" data-v="' + mode + '">' + ic("wand") + "Build it</button><span class=\"faint\" style=\"font-size:12px\">A Claude turn writes it (about a minute), then Bridge tests it.</span></div>");
  }
  function buildSheet(id) {
    const render = () => {
      const c = byId(id); if (!c) return;
      const g = c.gen || { log: "" };
      const done = c.status !== "generating";
      sheet((done ? "Built · " : "Building · ") + c.name,
        '<div class="cn-head">' + glyph(c.glyph, c.color, 40) + "<div><b>" + esc(c.name) + "</b><span>" + (done ? (c.status === "connected" ? (c.tools || []).length + " tools ready" : esc(c.error || "Not working yet")) : "Claude is writing the server…") + "</span></div>" + status(c) + "</div>" +
        '<pre class="cn-log" id="cnLog">' + esc(g.log || "") + "</pre>" +
        (done ? '<div class="row mt8" style="gap:6px"><button class="btn pri" data-cn="code" data-id="' + esc(id) + '">' + ic("code") + 'See the code</button><button class="btn" data-act="close">Close</button></div>' : ""), render);
      const l = $("#cnLog"); if (l) l.scrollTop = l.scrollHeight;
    };
    render(); load();
  }
  async function codeSheet(id) {
    const c = byId(id);
    const r = await getJ("/api/connectors/code?id=" + encodeURIComponent(id) + (C.comp === "cloud" ? "&computer=cloud" : ""));
    if (!ok(r)) return;
    sheet("Code · " + c.name, '<p class="faint" style="font-size:12px;margin-bottom:8px">' + esc(r.path) + " · Bun + TypeScript, run as a stdio MCP server. Edit and save to test it again.</p>" +
      '<textarea class="editor cn-code-ed" id="cnCode" spellcheck="false">' + esc(r.code) + "</textarea>" +
      '<div class="row mt8" style="gap:6px;flex-wrap:wrap"><button class="btn pri" data-cn="save-code" data-id="' + esc(id) + '">Save &amp; test</button>' +
      '<input class="sheet-in" id="cnRe" style="flex:1;min-width:200px;height:32px" placeholder="Or tell Claude what to change…"><button class="btn" data-cn="regen" data-id="' + esc(id) + '">' + ic("wand") + "Rebuild</button></div>");
  }

  /* ── per chat / folder ────────────────────────────────────────── */
  async function scopeSheet() {
    const c = S.view === "chat" && S.chat ? S.chat : null;
    const sid = c ? c.live || c.id || "" : "";
    const cwd = (c && c.path) || S.newPath || homeDir();
    const comp = (c && c.computer) || S.computer || "mac";
    const r = await getJ("/api/connectors/scopes?session=" + encodeURIComponent(sid) + "&cwd=" + encodeURIComponent(cwd) + (comp === "cloud" ? "&computer=cloud" : ""));
    if (!ok(r)) return;
    const meta = Object.fromEntries((r.connectors || []).map((x) => [x.id, x]));
    const row = (s) => {
      const m = meta[s.id] || {};
      return '<div class="cn-scope"><span class="cn-sn">' + glyph(m.glyph, m.color, 26) + "<b>" + esc(m.name || s.id) + "</b>" + (m.ready ? "" : '<span class="tag warn">not ready</span>') + "</span>" +
        (sid ? '<span class="cn-sc">' + tog(s.chat !== undefined ? s.chat : s.on, 'data-cn="scope" data-kind="chat" data-key="' + esc(sid) + '" data-id="' + esc(s.id) + '" data-on="' + (s.chat !== undefined ? s.chat : s.on) + '" data-comp="' + comp + '"') + "</span>" : "") +
        '<span class="cn-sc">' + tog(s.folder !== undefined ? s.folder : s.default, 'data-cn="scope" data-kind="folder" data-key="' + esc(cwd) + '" data-id="' + esc(s.id) + '" data-on="' + (s.folder !== undefined ? s.folder : s.default) + '" data-comp="' + comp + '"') + "</span></div>";
    };
    sheet("Connectors for this " + (sid ? "thread" : "folder"),
      (r.scopes.length ? '<div class="cn-scope cn-sh"><span class="cn-sn"></span>' + (sid ? '<span class="cn-sc">This thread</span>' : "") + '<span class="cn-sc">' + esc(projectName(cwd)) + "</span></div>" + r.scopes.map(row).join("") : empty("No connectors yet.", "Add one in Connectors.")) +
      '<div class="row mt12" style="gap:6px"><button class="btn" data-go="connectors">' + ic("plug") + 'Manage connectors</button><span class="faint" style="font-size:12px">Switches apply from the next message.</span></div>');
  }

  /* ── actions ──────────────────────────────────────────────────── */
  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-cn],[data-act=conn-scope]");
    if (!t) return;
    if (t.dataset.act === "conn-scope") { if (typeof closeMenu === "function") closeMenu(); scopeSheet(); return; }
    const a = t.dataset.cn, id = t.dataset.id, cat = t.dataset.cat;
    const c = id && byId(id);
    if (a === "toggle-open") { if (ev.target.closest(".toggle")) return; C.open = C.open === id ? null : id; paint(); }
    else if (a === "comp") { C.comp = t.dataset.v; C.list = null; paint(); load(); }
    else if (a === "enabled") { ev.stopPropagation(); if (ok(await call("/update", { id, enabled: !c.enabled }))) load(); }
    else if (a === "connect") connectSheet(entry(cat));
    else if (a === "url") urlSheet();
    else if (a === "new") newSheet("api");
    else if (a === "newmode") newSheet(t.dataset.v);
    else if (a === "test") { C.busy[id] = "test"; paint(); const r = await call("/test", { id }); delete C.busy[id]; C.open = id; if (r.test && !r.test.ok) toast(r.test.error); await load(); }
    else if (a === "auth") authSheet(c);
    else if (a === "view") buildSheet(id);
    else if (a === "code") codeSheet(id);
    else if (a === "disconnect") { if (confirm("Forget the sign-in for " + c.name + "?")) { await call("/disconnect", { id }); load(); } }
    else if (a === "remove") { if (confirm("Remove " + c.name + (c.kind === "local" ? " and its code" : "") + "?")) { await call("/remove", { id }); load(); } }
    else if (a === "oauth") startOAuthFor(c);
    else if (a === "device") deviceFor(c);
    else if (a === "token") { const tok = val("cnTok"); if (!tok) return toast("Paste the token first"); t.disabled = true; const r = await call("/token", { id, token: tok }); t.disabled = false; if (!ok(r)) return; closeOverlays(); C.sheet = null; toast(r.test && r.test.ok ? "Connected · " + r.test.tools.length + " tools" : "Saved, but the test failed: " + ((r.test && r.test.error) || "")); C.open = id; load(); }
    else if (a === "oauth-paste") { const r = await call("/oauth/finish", { url: val("cnBack") }); if (ok(r)) { toast("Connected " + r.connector.name); load(); } }
    else if (a && a.indexOf("add-") === 0) {
      const params = {};
      $$("[id^=cnp_]").forEach((n) => { if (n.value.trim()) params[n.id.slice(4)] = n.value.trim(); });
      let body;
      if (a === "add-url") {
        const auth = ($("#cnAuth .on") || {}).dataset.v || "none";
        body = { name: val("cnName"), url: val("cnUrl"), auth, tokenHeader: val("cnHdr") || "Authorization", tokenPrefix: ($("#cnPre") || {}).value ?? "Bearer ", token: auth === "token" ? val("cnTok") : "" };
      } else if (a === "add-new") {
        const mode = t.dataset.v, ak = val("cnAk");
        body = { name: val("cnName"), token: ak !== "none" ? val("cnTok") : "", instructions: mode === "api" ? val("cnDesc") : "",
          local: { mode, baseUrl: val("cnBase"), spec: val("cnSpec"), authKind: ak, authName: val("cnAkN"), description: mode === "words" ? val("cnDesc") : val("cnDesc") } };
      } else {
        const auth = a.slice(4) === "device" ? "device" : a.slice(4);
        if (auth === "token" && !val("cnTok")) return toast("Paste the token first");
        if (auth === "oauth" && (entry(cat) || {}).ownApp && !val("cnCid")) return toast("Paste the Client ID first");
        body = { catalogId: cat, auth, params, token: auth === "token" ? val("cnTok") : "" };
      }
      const app = a === "add-oauth" ? ownApp() : {};
      const w = a === "add-oauth" ? window.open("about:blank", "_blank") : null;
      t.disabled = true;
      const r = await call("/add", body);
      t.disabled = false;
      if (!ok(r)) { if (w) w.close(); return; }
      const nc = r.connector;
      C.open = nc.id;
      await load();
      if (a === "add-oauth") {
        const s = await call("/oauth/start", Object.assign({ id: nc.id, redirectUri: redirectUri() }, app));
        if (!ok(s)) { if (w) w.close(); return authSheet(byId(nc.id) || nc); }
        if (s.needsClient) { if (w) w.close(); return ownAppSheet(byId(nc.id) || nc); }
        if (w) w.location = s.authorizeUrl; else window.open(s.authorizeUrl, "_blank");
        oauthWait(nc, s.authorizeUrl);
      } else if (a === "add-device") deviceFor(nc);
      else if (a === "add-new") buildSheet(nc.id);
      else if (body.auth === "oauth") startOAuthFor(nc);
      else { closeOverlays(); C.sheet = null; toast(nc.status === "connected" ? nc.name + " connected · " + (nc.tools || []).length + " tools" : nc.name + ": " + (nc.error || "added")); if (S.view !== "connectors") go("connectors"); }
    }
    else if (a === "own-app") { if (!val("cnCid")) return toast("Paste the Client ID first"); startOAuthFor(byId(id) || { id, name: id }, ownApp()); }
    else if (a === "save-code") { t.disabled = true; const r = await call("/code", { id, code: $("#cnCode").value }); t.disabled = false; if (!ok(r)) return; toast(r.test.ok ? "Saved · " + r.test.tools.length + " tools" : "Saved, but it does not start: " + r.test.error); load(); }
    else if (a === "regen") { const r = await call("/generate", { id, instructions: val("cnRe") }); if (ok(r)) buildSheet(id); }
    else if (a === "scope") {
      const on = t.dataset.on !== "true";
      const r = await post("/api/connectors/scope", { id, kind: t.dataset.kind, key: t.dataset.key, on, computer: t.dataset.comp === "cloud" ? "cloud" : undefined });
      if (ok(r)) scopeSheet();
    }
  });
  document.addEventListener("click", (ev) => {
    const s = ev.target.closest("#cnAuth button"); if (s) { $$("#cnAuth button").forEach((b) => b.classList.toggle("on", b === s)); $("#cnTokBox").style.display = s.dataset.v === "token" ? "" : "none"; }
  });
  document.addEventListener("change", (ev) => {
    if (ev.target.id !== "cnAk") return;
    const v = ev.target.value;
    $("#cnTokBox").style.display = v === "none" ? "none" : "";
    $("#cnAkName").style.display = v === "header" || v === "query" ? "" : "none";
  });
  // the modal closing ends any live sheet
  new MutationObserver(() => { if (!$("#modal").classList.contains("on")) C.sheet = null; }).observe($("#modal"), { attributes: true, attributeFilter: ["class"] });

  window.Connectors = { load, scopeSheet, open: () => go("connectors") };
})();
