/* Tokens & keys: a masked field instead of pasting a token into the chat or editing an env file.
 *
 * The agent ends a reply with
 *   ```secret
 *   CLOUDFLARE_API_TOKEN global Cloudflare → My Profile → API Tokens
 *   ```
 * and Bridge shows a card per line: name, where to get it, Everywhere / This project, a password field.
 * Save posts the value straight to /api/secrets (secrets.ts), clears the field, and sends the thread a
 * one-line "saved" message. The value never enters the transcript, the composer, a toast or the log.
 * Settings › Tokens & keys lists them (masked), adds and removes. */
"use strict";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/** pull ```secret blocks out of a reply: { body without them, secrets: [{ name, scope, hint }] } */
function extractSecrets(text) {
  const out = [];
  const body = String(text || "").replace(/```secret\s*\n([\s\S]*?)```/g, (_, block) => {
    for (const line of block.split("\n")) {
      const parts = line.trim().replace(/^[-*•]\s*/, "").split(/\s+/);
      const name = (parts[0] || "").replace(/^\$/, "");
      if (!SECRET_NAME.test(name) || out.some((s) => s.name === name)) continue;
      const scope = /^(project|global)$/i.test(parts[1] || "") ? parts[1].toLowerCase() : "global";
      const hint = parts.slice(/^(project|global)$/i.test(parts[1] || "") ? 2 : 1).join(" ");
      out.push({ name, scope, hint });
    }
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { body, secrets: out.slice(0, 4) };
}

const scopeWord = (s) => (s === "project" ? "this project" : "everywhere");

/** one card per requested secret, under the last reply of a finished turn */
function secretCards(c, list) {
  c.secretScope = c.secretScope || {};
  c.secretSaved = c.secretSaved || {};
  return list.map((s) => {
    const scope = c.secretScope[s.name] || s.scope, saved = c.secretSaved[s.name];
    return '<div class="sec-card" data-sec="' + esc(s.name) + '">' +
      '<div class="sec-h">' + ic("shield") + '<code>' + esc(s.name) + "</code>" + (saved ? '<span class="tag ok">Saved · ' + esc(saved) + "</span>" : '<span class="faint">never shown in the chat</span>') + "</div>" +
      (s.hint ? '<div class="sec-hint">' + esc(s.hint) + "</div>" : "") +
      (saved ? "" :
        '<div class="sec-row"><div class="seg sec-scope"><button class="' + (scope === "global" ? "on" : "") + '" data-sec-scope="global" title="~/.claude/.env, for every project">Everywhere</button>' +
        '<button class="' + (scope === "project" ? "on" : "") + '" data-sec-scope="project" title="Only threads in ' + esc(projectName(c.path || "")) + ', kept outside the repo">This project</button></div></div>' +
        '<div class="sec-row"><input class="sec-in" type="password" autocomplete="new-password" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore placeholder="Paste the value">' +
        '<button class="icon-btn" data-sec-eye title="Show / hide">' + ic("eye") + '</button><button class="btn pri" data-sec-save>Save</button></div>' +
        '<div class="sec-err"></div>') +
      "</div>";
  }).join("");
}

async function saveSecretFrom(card) {
  const c = S.chat;
  if (!c) return;
  const name = card.dataset.sec, input = card.querySelector(".sec-in"), err = card.querySelector(".sec-err");
  const value = input.value;
  if (!value.trim()) { err.textContent = "Paste the value first."; input.focus(); return; }
  const scope = (c.secretScope && c.secretScope[name]) || (card.querySelector("[data-sec-scope].on") || {}).dataset?.secScope || "global";
  const btn = card.querySelector("[data-sec-save]");
  btn.disabled = true; err.textContent = "";
  let r;
  try { r = await post("/api/secrets", Object.assign({ name, value, scope, cwd: c.path || "" }, c.computer === "cloud" ? { computer: "cloud" } : {})); }
  catch (e) { r = { error: String(e && e.message || e) }; }
  input.value = "";                                           // the value leaves the page either way
  btn.disabled = false;
  if (!r || r.error) { err.textContent = (r && r.error) || "Could not save."; return; }
  c.secretSaved[name] = r.hint;
  flush(c, 0);
  sendText(c, "🔒 Saved " + name + " (" + scopeWord(scope) + "). Continue.");
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-sec-scope],[data-sec-eye],[data-sec-save]");
  if (!t) return;
  const card = t.closest(".sec-card");
  if (!card) return;
  e.preventDefault(); e.stopPropagation();
  if (t.dataset.secScope) {
    if (S.chat) { S.chat.secretScope = S.chat.secretScope || {}; S.chat.secretScope[card.dataset.sec] = t.dataset.secScope; }
    card.querySelectorAll("[data-sec-scope]").forEach((b) => b.classList.toggle("on", b === t));
  } else if (t.hasAttribute("data-sec-eye")) {
    const i = card.querySelector(".sec-in"); i.type = i.type === "password" ? "text" : "password"; i.focus();
  } else saveSecretFrom(card);
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList && e.target.classList.contains("sec-in")) { e.preventDefault(); saveSecretFrom(e.target.closest(".sec-card")); }
}, true);

/* ── Settings › Tokens & keys ───────────────────────────────────── */
const SEC = { list: null, adding: false, err: "" };
async function loadSecrets() {
  const r = await getJ("/api/secrets").catch(() => ({ secrets: [] }));
  SEC.list = r.secrets || [];
  if (S.setTab === "tokens" && $("#modal").classList.contains("on")) openSettings();
}
function secretsSettings() {
  if (!SEC.list) { loadSecrets(); return '<p class="faint">Loading…</p>'; }
  const row = (s) => '<div class="setting"><div class="l"><b><code>' + esc(s.name) + "</code></b><span>" + esc(s.hint) +
    (s.updatedAt ? " · set " + fmtAgo(s.updatedAt) : "") + "</span></div>" +
    '<button class="icon-btn" data-sec-rm="' + esc(s.name) + '" data-sec-rmscope="' + s.scope + '" data-sec-rmproj="' + esc(s.project || "") + '" title="Remove">' + ic("x") + "</button></div>";
  const g = SEC.list.filter((s) => s.scope === "global"), p = SEC.list.filter((s) => s.scope === "project");
  const byProj = {};
  for (const s of p) (byProj[s.project] = byProj[s.project] || []).push(s);
  return '<p class="sub">Tokens you type here, or in a card a thread asks with, go straight to this computer and into every thread\'s environment as <code>$NAME</code>. They never appear in a chat.</p>' +
    '<div class="side-h" style="padding-left:0">Everywhere · ~/.claude/.env</div>' + (g.map(row).join("") || '<p class="faint">None yet.</p>') +
    Object.keys(byProj).sort().map((k) => '<div class="side-h" style="padding-left:0">' + esc(projectName(k)) + " · " + esc(k.replace(homeDir(), "~")) + "</div>" + byProj[k].map(row).join("")).join("") +
    (SEC.adding
      ? '<div class="sec-card mt12"><div class="sec-row"><input id="secName" class="sec-name" placeholder="NAME_LIKE_THIS" autocomplete="off" spellcheck="false"></div>' +
        '<div class="sec-row"><div class="seg sec-scope"><button class="on" data-sec-addscope="global">Everywhere</button><button data-sec-addscope="project">A project…</button></div>' +
        '<select id="secProj" class="sec-proj" style="display:none">' + S.home.projects.filter((x) => x.path !== homeDir() && (x.computer || "mac") === "mac").map((x) => '<option value="' + esc(x.path) + '">' + esc(x.name) + "</option>").join("") + "</select></div>" +
        '<div class="sec-row"><input id="secVal" class="sec-in" type="password" autocomplete="new-password" spellcheck="false" data-lpignore="true" data-1p-ignore placeholder="Paste the value">' +
        '<button class="btn pri" data-sec-add>Save</button><button class="btn" data-sec-cancel>Cancel</button></div><div class="sec-err">' + esc(SEC.err) + "</div></div>"
      : '<button class="btn mt12" data-sec-new>' + ic("plus") + "Add a token</button>");
}
$("#modal").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-sec-new],[data-sec-cancel],[data-sec-add],[data-sec-rm],[data-sec-addscope]");
  if (!t) return;
  e.stopPropagation();
  const d = t.dataset;
  if (d.secNew !== undefined) { SEC.adding = true; SEC.err = ""; openSettings(); setTimeout(() => { const n = $("#secName"); if (n) n.focus(); }, 0); }
  else if (d.secCancel !== undefined) { SEC.adding = false; openSettings(); }
  else if (d.secAddscope) {
    t.parentNode.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === t));
    $("#secProj").style.display = d.secAddscope === "project" ? "" : "none";
  } else if (d.secAdd !== undefined) {
    const name = $("#secName").value.trim().toUpperCase(), val = $("#secVal"), proj = $("[data-sec-addscope].on").dataset.secAddscope === "project";
    const r = await post("/api/secrets", { name, value: val.value, scope: proj ? "project" : "global", cwd: proj ? $("#secProj").value : "" }).catch((x) => ({ error: String(x) }));
    val.value = "";
    if (r.error) { SEC.err = r.error; openSettings(); return; }
    SEC.adding = false; SEC.list = null; toast("Saved " + name); openSettings();
  } else if (d.secRm) {
    if (!confirm("Remove " + d.secRm + "? Threads stop seeing it from their next turn.")) return;
    await post("/api/secrets/remove", { name: d.secRm, scope: d.secRmscope, project: d.secRmproj || undefined, cwd: d.secRmproj || "" });
    SEC.list = null; openSettings();
  }
}, true);
document.addEventListener("input", (e) => { if (e.target.id === "secName") e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"); });
