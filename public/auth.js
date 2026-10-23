/* ═══════════════════════════ sign in to Bridge ═══════════════════════════
 * When the server says a session is required (/api/authconfig), Bridge signs in with a Supabase magic
 * link and sends the access token with every /api call: as a Bearer header on fetch, as ?access_token=
 * where a header cannot be set (EventSource, <img>, <iframe>). supabase-js keeps the session fresh; a
 * 401 from the server brings the sign-in screen back. With no gate configured, none of this runs. */
window.Auth = (function () {
  const A = { required: false, client: null, session: null, token: "", email: "", shown: false };
  const nativeFetch = window.fetch.bind(window);
  const isApi = (u) => { try { const x = new URL(u, location.href); return x.origin === location.origin && x.pathname.indexOf("/api/") === 0 && x.pathname !== "/api/authconfig"; } catch (e) { return false; } };
  A.withToken = (u) => (A.token && isApi(u) ? u + (u.indexOf("?") >= 0 ? "&" : "?") + "access_token=" + encodeURIComponent(A.token) : u);

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (A.token && isApi(url)) {
      init = Object.assign({}, init);
      const h = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
      h.set("authorization", "Bearer " + A.token);
      init.headers = h;
    }
    const r = await nativeFetch(input, init);
    if (r.status === 401 && A.required && isApi(url)) expired();
    return r;
  };
  const NativeES = window.EventSource;
  function AuthedES(u, o) { return new NativeES(A.withToken(String(u)), o); }
  AuthedES.prototype = NativeES.prototype;
  ["CONNECTING", "OPEN", "CLOSED"].forEach((k) => (AuthedES[k] = NativeES[k]));
  window.EventSource = AuthedES;

  function setSession(s) { A.session = s || null; A.token = (s && s.access_token) || ""; A.email = (s && s.user && s.user.email) || ""; }
  /** resolves true when Bridge may boot: no gate, or a live session */
  A.start = async function () {
    let c = { required: false };
    try { c = await (await nativeFetch("/api/authconfig")).json(); } catch (e) {}
    A.required = !!c.required;
    if (!A.required) return true;
    if (!window.supabase || !window.supabase.createClient) { showLogin("Could not load the sign-in library. Check the connection and reload."); return false; }
    A.client = window.supabase.createClient(c.supabaseUrl, c.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" } });
    const { data } = await A.client.auth.getSession();
    setSession(data && data.session);
    A.client.auth.onAuthStateChange((ev, s) => {
      const had = !!A.token;
      setSession(s);
      if (ev === "SIGNED_IN" && !had && A.shown) location.replace(location.origin + location.pathname);
      if (ev === "SIGNED_OUT") showLogin();
    });
    // the magic link lands with the session in the URL hash; once read, the address goes back to plain
    if (/access_token=|error_description=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    if (A.token) return true;
    showLogin();
    return false;
  };
  let expiring = false;
  async function expired() {
    if (expiring || A.shown) return;
    expiring = true;
    // one refresh attempt before giving up: the access token may simply have aged out
    try { const { data } = await A.client.auth.refreshSession(); if (data && data.session) { setSession(data.session); expiring = false; return; } } catch (e) {}
    setSession(null);
    showLogin("Your session ended. Sign in again.");
    expiring = false;
  }
  A.signOut = async function () { try { await A.client.auth.signOut({ scope: "local" }); } catch (e) {} setSession(null); location.replace(location.origin + location.pathname); };

  /* ── the sign-in screen ─────────────────────────────────────────── */
  function showLogin(err) {
    A.shown = true;
    let box = document.getElementById("login");
    if (!box) { box = document.createElement("div"); box.id = "login"; document.body.appendChild(box); }
    const hashErr = /error_description=([^&]+)/.exec(location.hash);
    render(box, { state: "ask", err: err || (hashErr ? decodeURIComponent(hashErr[1].replace(/\+/g, " ")) : "") });
  }
  function render(box, st) {
    const e = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    box.innerHTML = '<div class="login-card"><canvas id="loginOrb" width="264" height="264"></canvas>' +
      '<div class="login-brand"><div class="logo"><span>B</span></div><span class="name">BRIDGE</span></div>' +
      (st.state === "sent"
        ? '<h1>Check your email</h1><p class="sub">We sent a link and a 6-digit code to <b>' + e(st.email) + '</b>. Type the code here, or open the link on this device.</p>' +
          (st.err ? '<div class="sheet-err">' + e(st.err) + "</div>" : "") +
          '<form id="codeForm"><input class="sheet-in login-code" id="loginCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="123456">' +
          '<button class="btn pri" type="submit"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Checking…" : "Sign in with the code") + "</button></form>" +
          '<button class="btn login-alt" id="loginBack">Use a different email</button>'
        : '<h1>Sign in to Bridge</h1><p class="sub">Your team, your chats, from anywhere. We email you a link; no password.</p>' +
          (st.err ? '<div class="sheet-err">' + e(st.err) + "</div>" : "") +
          '<form id="loginForm"><input class="sheet-in" id="loginEmail" type="email" placeholder="you@example.com" autocomplete="email" required value="' + e(st.email || localStorage.bridgeLoginEmail || "") + '">' +
          '<button class="btn pri" id="loginGo" type="submit"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Sending…" : "Email me a sign-in link") + "</button></form>") +
      "</div>";
    const orb = document.getElementById("loginOrb");
    if (orb && typeof startOrb === "function") startOrb(orb, 0.5);
    const form = document.getElementById("loginForm");
    if (form) {
      const inp = document.getElementById("loginEmail");
      setTimeout(() => inp.focus(), 30);
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const email = inp.value.trim();
        if (!email) return;
        try { localStorage.bridgeLoginEmail = email; } catch (x) {}
        render(box, { state: "ask", email, busy: true });
        const { error } = await A.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) render(box, { state: "ask", email, err: /rate limit|security purposes/i.test(error.message) ? "A link was just sent. Wait a minute before asking for another." : error.message });
        else render(box, { state: "sent", email });
      };
    }
    // the code path matters on iPhone: a home-screen app's links open in Safari, not in the app
    const codeForm = document.getElementById("codeForm");
    if (codeForm) {
      const ci = document.getElementById("loginCode");
      setTimeout(() => ci.focus(), 30);
      const go = async () => {
        const token = ci.value.replace(/\D/g, "");
        if (token.length !== 6) return;
        render(box, { state: "sent", email: st.email, busy: true });
        const { data, error } = await A.client.auth.verifyOtp({ email: st.email, token, type: "email" });
        if (error || !data || !data.session) render(box, { state: "sent", email: st.email, err: error && /expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Check the latest email, or ask for a new one." : (error ? error.message : "That did not sign you in") });
        else { setSession(data.session); location.replace(location.origin + location.pathname); }
      };
      codeForm.onsubmit = (ev) => { ev.preventDefault(); go(); };
      ci.oninput = () => { ci.value = ci.value.replace(/\D/g, "").slice(0, 6); if (ci.value.length === 6) go(); };
    }
    const back = document.getElementById("loginBack");
    if (back) back.onclick = () => render(box, { state: "ask" });
  }
  return A;
})();
