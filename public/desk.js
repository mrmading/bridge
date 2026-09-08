/* ═══════════════════════════ the desk ═══════════════════════════
 * The assistant's own tab. One persistent Claude Code process on the server, one event
 * stream here. An orb that listens, thinks and speaks; the conversation beneath it; and the
 * events from every terminal session on the machine landing in the same place.
 * Loads after app.js and uses its helpers ($, esc, md, renderMsg, patchRow, toast, note…). */
(function () {
  const DESK = {
    msgs: [], phase: "idle", label: "", level: 0, smooth: 0, seq: 0, es: null, blocks: {}, state: null, health: null,
    muted: false, hands: true, session: false,   // session: a voice conversation is running (hands-free loop)
    listening: null, playing: null, catchUp: false, first: true, lastSent: null, shown: false, relayTo: null,
    tickT: null, statusIdx: -1, since: 0, lastFlush: 0, dirty: new Set(),
  };
  const name = () => (S.boot && S.boot.assistant) || "Desk";
  const color = () => (S.boot && S.boot.color) || "#3B82F6";
  const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then((r) => r.json());

  /* ───────────────────────── phase & label ───────────────────────── */
  function setPhase(p, label) {
    if (DESK.phase !== p) { DESK.phase = p; renderRail(); }
    DESK.label = label !== undefined ? label : defaultLabel(p);
    paintLabel();
    $("#desk").dataset.phase = p;
    $("#deskMic").classList.toggle("on", p === "listening");
  }
  function defaultLabel(p) {
    if (p === "listening") return "Listening…";
    if (p === "thinking") return "Thinking";
    if (p === "working") return "Working";
    if (p === "speaking") return "Speaking";
    if (DESK.health && DESK.health.stt === "none") return "Type below — no transcriber on this machine";
    return DESK.session ? "Click the orb to talk" : "Click the orb to talk, or just type";
  }
  function paintLabel() {
    const el = $("#deskLabel");
    if (el) el.textContent = DESK.label;
  }
  function paintState() {
    const st = DESK.state || {};
    const el = $("#deskState");
    if (!el) return;
    const t = !st.alive ? (st.error ? "offline · " + st.error : "starting") : st.busy ? "working" : "ready";
    el.querySelector(".t").textContent = name() + " · " + t + (st.queued ? " · " + st.queued + " queued" : "");
    el.className = "desk-state " + (!st.alive ? "off" : st.busy ? "busy" : "ok");
    const h = DESK.health;
    const vi = $("#deskVoiceInfo");
    if (vi && h) vi.textContent = "voice: " + (h.tts === "elevenlabs" ? "ElevenLabs" : h.tts === "pulse" ? "Pulse" : "browser") + " · ears: " + (h.stt === "mlx" ? "whisper (GPU)" : h.stt === "none" ? "none" : "whisper");
    $("#deskHands").classList.toggle("acc", DESK.hands);
    $("#deskMute").classList.toggle("acc", !DESK.muted);
    $("#deskMute").textContent = DESK.muted ? "🔇 muted" : "🔊 voice";
  }

  /* ───────────────────────── the feed ───────────────────────── */
  function renderRow(m) {
    if (m.kind === "event") {
      const e = m.ev;
      const lab = { done: "finished", waiting: "needs you", started: "opened", ended: "closed" }[e.kind] || e.kind;
      return '<div class="dev ' + e.kind + '"><span class="dev-dot"></span><div class="dev-b">' +
        '<div class="dev-h"><b>' + esc(e.folder) + "</b> · " + esc(e.name) + ' <span class="dev-k">' + lab + '</span><span class="ts">' + fmtTime(e.at) + "</span></div>" +
        (e.text ? '<div class="dev-t">' + esc(e.text.slice(0, 260)) + "</div>" : "") +
        '<div class="dev-a"><button class="chip" data-open="' + esc(e.key + "|" + e.id + "|" + e.cwd + "|" + e.title) + '">Open session</button>' +
        (e.kind === "waiting" ? '<button class="chip acc" data-answer="' + esc(e.name) + '|' + esc(e.folder) + '">Answer by voice</button>' : "") +
        "</div></div></div>";
    }
    if (m.kind === "status") return "";
    if ((m.kind === "assistant" || m.kind === "agent_text") && !m.live) return renderMsg(Object.assign({}, m, { text: linkSessions(m.text) }));
    return renderMsg(m);
  }
  /** a session named in an answer becomes a link that opens it in Work sessions */
  function linkSessions(text) {
    const live = S.live || [];
    if (!live.length || !text) return text;
    const parts = String(text).split(/(```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\([^)]*\))/);
    const names = [];
    for (const s of live) {
      names.push({ w: s.name, s });
      if (s.folder !== "home" && live.filter((x) => x.folder === s.folder).length === 1) names.push({ w: s.folder, s });
    }
    names.sort((a, b) => b.w.length - a.w.length);
    return parts.map((seg, i) => {
      if (i % 2) return seg;
      for (const { w, s } of names) {
        const re = new RegExp("(^|[^\\w/.-])(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?![\\w/-]|\\.\\w)", "g");
        seg = seg.replace(re, (all, pre, hit) => pre + "[" + hit + "](#session/" + encodeURIComponent(s.key + "|" + s.id + "|" + s.cwd + "|" + s.title) + ")");
      }
      return seg;
    }).join("");
  }
  let boardKey = "";
  function board() {
    const box = $("#deskBoard");
    if (!box) return;
    const live = S.live || [];
    const key = live.map((s) => s.id + s.status + (s.waiting ? "!" : "")).join(",");
    if (key !== boardKey) { const linksChanged = key.replace(/(busy|idle|!)/g, "") !== boardKey.replace(/(busy|idle|!)/g, ""); boardKey = key; if (linksChanged && DESK.msgs.length) rebuild(); }
    box.innerHTML = live.length ? live.map((s, i) => {
      const w = s.waiting;
      return '<div class="sb ' + (s.status === "busy" ? "busy" : w ? "wait" : "") + '" data-sb="' + i + '" title="Open this session">' +
        '<div class="sb-h"><span class="sb-dot"></span><b>' + esc(s.folder) + "</b><span class=\"sb-n\">" + esc(s.name) + "</span>" +
        '<span class="sb-s">' + (s.status === "busy" ? "working" : w ? "needs you" : "idle") + "</span></div>" +
        '<div class="sb-t">' + esc(s.title) + "</div>" +
        (w ? '<div class="sb-q">' + esc(w.text.slice(0, 120)) + "</div>" : s.last ? '<div class="sb-l">' + esc(s.last.slice(0, 140)) + "</div>" : "") +
        "</div>";
    }).join("") : '<div class="sb-empty">No terminal session is open right now.</div>';
    box.querySelectorAll("[data-sb]").forEach((n) => (n.onclick = () => { const s = live[+n.dataset.sb]; openSessionIn(s.key, s.id, s.cwd, s.title); }));
  }
  function wireRow(el) {
    wireMsgHandlers(el);
    el.querySelectorAll('a[href^="#session/"]').forEach((a) => { a.removeAttribute("target"); a.onclick = (e) => { e.preventDefault(); const [key, id, path, title] = decodeURIComponent(a.getAttribute("href").slice(9)).split("|"); openSessionIn(key, id, path, title); }; });
    el.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => { const [key, id, path, title] = b.dataset.open.split("|"); openSessionIn(key, id, path, title); }));
    el.querySelectorAll("[data-answer]").forEach((b) => (b.onclick = () => { const [nm, folder] = b.dataset.answer.split("|"); DESK.relayTo = { name: nm, folder }; listen(); }));
  }
  function flush(i) {
    DESK.dirty.add(i);
    if (DESK.lastFlush) return;
    DESK.lastFlush = requestAnimationFrame(() => {
      DESK.lastFlush = 0;
      const box = $("#deskFeed");
      for (const idx of DESK.dirty) {
        const m = DESK.msgs[idx];
        if (!m) continue;
        let el = box.querySelector('[data-di="' + idx + '"]');
        if (!el) {
          if (box.querySelectorAll("[data-di]").length !== idx) { rebuild(); DESK.dirty.clear(); return; }
          el = document.createElement("div"); el.className = "mrow"; el.dataset.di = idx;
          el.innerHTML = renderRow(m); wireRow(el); box.appendChild(el);
          continue;
        }
        if (!patchRow(el, m)) { el.innerHTML = renderRow(m); wireRow(el); }
      }
      DESK.dirty.clear();
      dock(); scrollFeed();
    });
  }
  function rebuild() {
    const box = $("#deskFeed");
    box.innerHTML = DESK.msgs.map((m, i) => '<div class="mrow" data-di="' + i + '">' + renderRow(m) + "</div>").join("");
    wireRow(box);
    dock(); scrollFeed();
  }
  function scrollFeed() {
    const b = $("#deskFeed");
    if (b.scrollHeight - b.scrollTop - b.clientHeight < 260) b.scrollTop = b.scrollHeight;
  }
  /** the drawer's count, and an empty state before anything has happened */
  function dock() {
    const n = DESK.msgs.filter((m) => m.kind === "assistant" || m.kind === "event").length;
    $("#drawerCount").textContent = n ? String(n) : "";
    if (!DESK.msgs.length) $("#deskFeed").innerHTML = '<div class="desk-feed-empty">Answers and session events land here.</div>';
  }
  function drawer(on) {
    if (on === undefined) on = $("#desk").classList.contains("no-drawer");
    $("#desk").classList.toggle("no-drawer", !on);
    localStorage.bridgeDrawer = on ? "1" : "0";
    $("#deskDrawerBtn").classList.toggle("acc", on);
  }
  function push(m) { const i = DESK.msgs.push(m) - 1; flush(i); return i; }
  const lastAssistant = () => DESK.msgs.filter((m) => m.kind === "assistant").pop();

  /* ───────────────────────── the stream from the server ───────────────────────── */
  function connect() {
    if (DESK.es) { try { DESK.es.close(); } catch (e) {} }
    const es = new EventSource("/api/da/stream?since=" + DESK.seq + (DESK.first ? "&replay=0" : ""));
    DESK.es = es;
    es.onmessage = (e) => {
      let p; try { p = JSON.parse(e.data); } catch (err) { return; }
      if (p.seq) DESK.seq = Math.max(DESK.seq, p.seq);
      if (p.t === "hello") {
        DESK.state = p.d; paintState();
        if (DESK.first) { DESK.first = false; DESK.seq = p.seq || 0; loadHistory(); if (p.d.busy) { DESK.catchUp = true; setPhase("thinking"); } }
        return;
      }
      if (p.t === "state") { const was = DESK.state; DESK.state = p.d; paintState(); if (was && !was.alive && p.d.alive && DESK.phase === "idle") setPhase("idle"); return; }
      if (p.t === "event") { onLive(p.d); return; }
      if (p.t === "user") { onUserEcho(p.d); return; }
      if (p.t === "stderr") { if (/error|failed/i.test(p.d)) push({ kind: "assistant", text: "```\n" + p.d + "\n```", ts: Date.now() }); return; }
      if (p.t === "da") onDa(p.d);
    };
    es.onerror = () => { setTimeout(() => { if (DESK.es === es) connect(); }, 1500); };
  }
  async function loadHistory() {
    const st = DESK.state || {};
    if (!st.historyId) return;
    const key = String((S.boot && S.boot.home) || "").replace(/[^A-Za-z0-9]/g, "-");
    let r;
    try { r = await (await fetch("/api/session?key=" + encodeURIComponent(key) + "&id=" + st.historyId)).json(); } catch (e) { return; }
    if (!r || r.error) return;
    const evs = (r.events || []).map((m) => {
      if (m.kind === "user") m.text = stripBlock(m.text);
      if (m.kind === "thinking") m.open = false;
      return m;
    }).filter((m) => !(m.kind === "user" && !m.text.trim()));
    // keep anything that streamed in while the history was loading
    const fresh = DESK.msgs.filter((m) => m.kind !== "status" && m.ts > Date.now() - 60_000 && m.live);
    DESK.msgs = evs.slice(-120).concat(fresh);
    rebuild();
    $("#deskFeed").scrollTop = $("#deskFeed").scrollHeight;
  }
  const stripBlock = (t) => String(t || "").replace(/<bridge>[\s\S]*?<\/bridge>\s*/g, "").trim();
  function onUserEcho(d) {
    const last = DESK.lastSent;
    if (last && last.text === d.text && Date.now() - last.at < 8000) return;   // our own message, already shown
    push({ kind: "user", text: d.text, ts: Date.now() });
  }
  function onDa(d) {
    if (!d || !d.type) return;
    if (d.type === "system" && d.subtype === "init") { if (DESK.phase === "thinking") setPhase("thinking"); return; }
    if (d.type === "system" && d.subtype === "hook_started") { if (DESK.phase !== "idle" && DESK.phase !== "speaking") setPhase("working", "Running " + (d.hook_name || "hook")); return; }
    if (d.type === "system" && d.subtype === "hook_response") { if (DESK.phase === "working") setPhase("thinking"); return; }
    if (d.type === "stream_event") {
      const ev = d.event, side = !!d.parent_tool_use_id;
      if (!ev) return;
      if (ev.type === "message_start") { DESK.blocks = {}; if (DESK.phase !== "speaking") setPhase("thinking", "Composing"); return; }
      if (ev.type === "content_block_start") {
        const cb = ev.content_block || {};
        if (cb.type === "text") DESK.blocks[ev.index] = push({ kind: side ? "agent_text" : "assistant", text: "", ts: Date.now(), live: true });
        else if (cb.type === "thinking") DESK.blocks[ev.index] = push({ kind: "thinking", text: "", ts: Date.now(), live: true, open: false, side });
      } else if (ev.type === "content_block_delta") {
        const idx = DESK.blocks[ev.index]; if (idx === undefined) return;
        const m = DESK.msgs[idx];
        if (ev.delta.type === "text_delta") m.text += ev.delta.text;
        else if (ev.delta.type === "thinking_delta") m.text += ev.delta.thinking;
        else return;
        flush(idx);
      } else if (ev.type === "content_block_stop") {
        const idx = DESK.blocks[ev.index];
        if (idx !== undefined) { DESK.msgs[idx].live = false; flush(idx); }
      }
      return;
    }
    if (d.type === "assistant") {
      const side = !!d.parent_tool_use_id;
      const streamed = Object.keys(DESK.blocks).length > 0;
      ((d.message && d.message.content) || []).forEach((c) => {
        if (c.type === "tool_use") { push({ kind: "tool", name: c.name, input: c.input, id: c.id, ts: Date.now(), side, result: null }); if (DESK.phase !== "speaking") setPhase("working", toolLabel(c)); }
        else if (c.type === "text" && !streamed && c.text && c.text.trim()) push({ kind: side ? "agent_text" : "assistant", text: c.text, ts: Date.now() });
      });
      return;
    }
    if (d.type === "user") {
      ((d.message && d.message.content) || []).forEach((c) => {
        if (c.type !== "tool_result") return;
        for (let i = DESK.msgs.length - 1; i >= 0; i--) {
          const m = DESK.msgs[i];
          if (m.kind === "tool" && m.id === c.tool_use_id) {
            m.result = { content: typeof c.content === "string" ? c.content : (c.content || []).map((z) => z.text || "[" + z.type + "]").join("\n"), isError: !!c.is_error };
            flush(i); break;
          }
        }
      });
      if (DESK.phase === "working") setPhase("thinking");
      return;
    }
    if (d.type === "result") {
      DESK.msgs.forEach((m, i) => { if (m.live) { m.live = false; flush(i); } });
      DESK.blocks = {};
      if (DESK.catchUp) { DESK.catchUp = false; loadHistory(); }
      const last = lastAssistant();
      const spoken = last ? spokenLine(last.text) : "";
      if (d.is_error && !last) push({ kind: "assistant", text: "**" + name() + " hit an error** — " + esc(d.subtype || "unknown"), ts: Date.now() });
      if (spoken && !DESK.muted) speak(spoken, afterSpeech);
      else { setPhase("idle"); afterSpeech(); }
    }
  }
  function toolLabel(c) {
    const i = c.input || {};
    if (c.name === "Read") return "Reading " + String(i.file_path || "").split("/").pop();
    if (c.name === "Bash") return "Running a command";
    if (c.name === "SendMessage") return "Messaging " + (i.to || "a session");
    if (c.name === "ListAgents") return "Finding your sessions";
    if (c.name === "Agent" || c.name === "Task") return "Dispatching " + (i.subagent_type || "an agent");
    return "Using " + c.name;
  }
  /** what gets read aloud: the 🗣️ line if there is one, else the first couple of plain sentences */
  function spokenLine(text) {
    const t = String(text || "");
    const m = t.match(/🗣️\s*\**\s*(.+)/);
    if (m) return clean(m[1]).slice(0, 600);
    const body = clean(t.replace(/```[\s\S]*?```/g, " "));
    const sents = body.match(/[^.!?]+[.!?]+/g) || [body];
    let out = "";
    for (const s of sents) { if ((out + s).length > 420) break; out += s; }
    return (out || body).trim().slice(0, 480);
  }
  const clean = (t) => String(t).replace(/<[^>]+>/g, " ").replace(/[*_`#>|~]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
  function afterSpeech() {
    if (DESK.session && DESK.hands && DESK.shown && !DESK.muted) setTimeout(() => { if (DESK.phase === "idle" && DESK.session) listen(); }, 380);
  }

  /* ───────────────────────── sending ───────────────────────── */
  async function send(text, opts) {
    text = String(text || "").trim();
    if (!text) return;
    opts = opts || {};
    if (!authed()) { openSignin("Sign in first — the desk runs on the claude CLI."); return; }
    const shown = opts.shown || text;
    DESK.lastSent = { text, at: Date.now() };
    push({ kind: "user", text: shown, ts: Date.now() });
    setPhase("thinking");
    const r = await post("/api/da/send", { text });
    if (r.error) { push({ kind: "assistant", text: "**Could not reach the desk** — " + r.error, ts: Date.now() }); setPhase("idle"); return; }
    if (r.queued) toast("Queued — " + name() + " is mid-answer");
  }
  /** a message for a terminal session, carried by the desk with the SendMessage tool */
  function relay(m, text) {
    activateDesk();
    send('Relay this to the terminal session named "' + m.name + '" (folder ' + m.folder + ') with SendMessage, word for word, then confirm in one 🗣️ line that it went:\n\n' + text,
      { shown: "→ " + m.name + ": " + text });
  }
  function ask(text) { activateDesk(); send(text); }
  function activateDesk() { if (S.view !== "copilot") go("copilot"); }

  /* ───────────────────────── listening ───────────────────────── */
  const pickMime = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  async function listen() {
    if (DESK.listening) return;
    if (DESK.playing) stopSpeaking();
    if (!navigator.mediaDevices || !window.MediaRecorder) { setPhase("idle", "This browser cannot record — type instead"); return; }
    if (DESK.health && DESK.health.stt === "none") { setPhase("idle", "No transcriber on this machine — type instead"); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { setPhase("idle", "Microphone blocked — allow it for Bridge and try again"); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const mime = pickMime();
    let rec;
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch (e) { rec = new MediaRecorder(stream); }
    const L = { stream, ctx, an, rec, chunks: [], spoke: false, lastVoice: 0, start: Date.now(), mime: rec.mimeType || mime || "audio/webm", floor: 0.004, buf: new Float32Array(an.fftSize), stopped: false };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) L.chunks.push(e.data); };
    rec.start(250);
    DESK.listening = L;
    DESK.session = true;
    post("/api/voice/warm");
    setPhase("listening");
    vad();
  }
  function vad() {
    const L = DESK.listening;
    if (!L || L.stopped) return;
    L.an.getFloatTimeDomainData(L.buf);
    let s = 0; for (let i = 0; i < L.buf.length; i++) s += L.buf[i] * L.buf[i];
    const rms = Math.sqrt(s / L.buf.length);
    const now = Date.now();
    if (!L.spoke) L.floor = Math.min(0.02, L.floor * 0.97 + rms * 0.03);   // the room's own noise, learned while nobody speaks
    const thr = Math.max(0.012, L.floor * 3.2);
    const voice = rms > thr;
    DESK.level = Math.min(1, rms * 9);
    if (voice) { L.spoke = true; L.lastVoice = now; }
    $("#deskLive").textContent = L.spoke ? "" : "";
    if (L.spoke && now - L.lastVoice > 1100) return stopListening(true);
    if (!L.spoke && now - L.start > 8000) return stopListening(false, "Didn't hear anything");
    if (now - L.start > 40_000) return stopListening(true);
    requestAnimationFrame(vad);
  }
  function stopListening(sendIt, why) {
    const L = DESK.listening;
    if (!L || L.stopped) return;
    L.stopped = true;
    DESK.listening = null;
    DESK.level = 0;
    const finish = async () => {
      try { L.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      try { L.ctx.close(); } catch (e) {}
      const blob = new Blob(L.chunks, { type: L.mime });
      if (!sendIt || blob.size < 1200) { setPhase("idle", why || undefined); if (!sendIt) DESK.session = false; return; }
      setPhase("thinking", "Transcribing");
      let r;
      try { r = await (await fetch("/api/stt", { method: "POST", headers: { "content-type": L.mime }, body: blob })).json(); }
      catch (e) { r = { error: String(e) }; }
      if (r.error && !r.text) { setPhase("idle", "Couldn't transcribe — " + r.error); return; }
      const text = String(r.text || "").trim();
      if (!text) { setPhase("idle", "Didn't catch that"); afterSpeech(); return; }
      const to = DESK.relayTo; DESK.relayTo = null;
      if (to) relay(to, text); else send(text);
    };
    if (L.rec.state !== "inactive") { L.rec.onstop = finish; L.rec.stop(); } else finish();
  }

  /* ───────────────────────── speaking ───────────────────────── */
  async function speak(text, done) {
    stopSpeaking();
    setPhase("speaking");
    const P = { done: false, src: null, ctx: null, an: null, timer: null, utter: null, buf: null };
    DESK.playing = P;
    const end = () => { if (P.done) return; P.done = true; if (DESK.playing === P) DESK.playing = null; DESK.level = 0; if (P.ctx) try { P.ctx.close(); } catch (e) {} setPhase("idle"); if (done) done(); };
    P.end = end;
    let r;
    try { r = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); }
    catch (e) { return browserSpeak(text, P, end); }
    if (P.done) return;
    const ct = r.headers.get("content-type") || "";
    if (ct.indexOf("audio/") === 0) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await ctx.decodeAudioData(await r.arrayBuffer());
        if (P.done) { ctx.close(); return; }
        const src = ctx.createBufferSource(); src.buffer = buf;
        const an = ctx.createAnalyser(); an.fftSize = 512;
        src.connect(an); an.connect(ctx.destination);
        P.ctx = ctx; P.src = src; P.an = an; P.buf = new Float32Array(an.fftSize);
        src.onended = end;
        src.start();
        meter(P);
        return;
      } catch (e) { /* fall through to a synthetic swell */ }
    }
    let j = {}; try { j = ct.indexOf("json") >= 0 ? await r.json() : {}; } catch (e) {}
    if (j.played === "pulse") {
      // Pulse plays on the Mac itself; the orb swells for about as long as the words take
      const ms = Math.max(1200, (j.words || text.split(/\s+/).length) / 2.7 * 1000 / 1.1 + 700);
      swell(P, ms, end);
      return;
    }
    browserSpeak(text, P, end);
  }
  function browserSpeak(text, P, end) {
    if (!window.speechSynthesis) return end();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.lang = "en-US";
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => /Samantha|Daniel|Karen|Moira|Rishi|Alex/.test(x.name)) || voices.find((x) => x.lang.indexOf("en") === 0);
    if (v) u.voice = v;
    u.onend = end; u.onerror = end;
    P.utter = u;
    speechSynthesis.speak(u);
    swell(P, 1e9, null);
  }
  function swell(P, ms, end) {
    const t0 = Date.now();
    const step = () => {
      if (P.done) return;
      const t = (Date.now() - t0) / 1000;
      DESK.level = 0.42 + Math.sin(t * 2 * Math.PI * 2.1) * 0.22 + Math.sin(t * 2 * Math.PI * 0.7) * 0.12;
      if (Date.now() - t0 > ms) { if (end) end(); return; }
      requestAnimationFrame(step);
    };
    step();
  }
  function meter(P) {
    const step = () => {
      if (P.done || !P.an) return;
      P.an.getFloatTimeDomainData(P.buf);
      let s = 0; for (let i = 0; i < P.buf.length; i++) s += P.buf[i] * P.buf[i];
      DESK.level = Math.min(1, Math.sqrt(s / P.buf.length) * 4);
      requestAnimationFrame(step);
    };
    step();
  }
  function stopSpeaking() {
    const P = DESK.playing;
    if (!P) return;
    try { if (P.src) P.src.stop(); } catch (e) {}
    try { if (P.utter) speechSynthesis.cancel(); } catch (e) {}
    P.end && P.end();
  }

  /* ───────────────────────── events from the terminals ───────────────────────── */
  function onLive(e) {
    if (!e || !e.kind) return;
    push({ kind: "event", ev: e, ts: e.at });
    const where = e.folder;
    if (e.kind === "waiting") {
      noteRaw({ id: e.id, key: e.key, path: e.cwd, title: e.title, kind: "waiting", detail: e.text.slice(0, 120) });
      toast(where + " needs you: " + e.text.slice(0, 80));
      if (!DESK.muted) speak("Your " + where + " session is asking: " + e.text.slice(0, 300), afterSpeech);
    } else if (e.kind === "done") {
      noteRaw({ id: e.id, key: e.key, path: e.cwd, title: e.title, kind: "done", detail: e.text.slice(0, 120) });
      toast(where + " finished a turn");
      // the terminal's own voice hook already reads finished turns aloud through Pulse; Bridge
      // only speaks them when that channel is down
      if (!DESK.muted && DESK.health && !DESK.health.pulse) speak("The " + where + " session finished. " + firstSentence(e.text), afterSpeech);
    } else if (e.kind === "started") toast("Terminal opened in " + where);
    else if (e.kind === "ended") toast("Terminal closed in " + where);
    syncLive();
  }
  const firstSentence = (t) => { const m = clean(t).match(/[^.!?]+[.!?]/); return (m ? m[0] : clean(t).slice(0, 160)).trim(); };

  /* ───────────────────────── the orb ───────────────────────── */
  const PAL = {
    idle: ["#3B82F6", "#7fd0ff", "#6d5cff"], listening: ["#22d3ee", "#3B82F6", "#a5f3fc"],
    thinking: ["#b79cf5", "#3B82F6", "#7a4fd0"], working: ["#b79cf5", "#4aa8ff", "#7a4fd0"], speaking: ["#4aa8ff", "#7fd0ff", "#3B82F6"],
  };
  const hex2 = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgba = (h, a) => { const c = hex2(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; };
  let cur = null;   // colours ease between phases
  function draw(now) {
    const c = $("#orb");
    if (!c || !DESK.shown) { requestAnimationFrame(draw); return; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = c.clientWidth || 300;
    if (c.width !== size * dpr) { c.width = size * dpr; c.height = size * dpr; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const t = now / 1000;
    DESK.smooth += (DESK.level - DESK.smooth) * (DESK.level > DESK.smooth ? 0.35 : 0.08);
    const lv = DESK.smooth;
    const ph = DESK.phase;
    const pal = (PAL[ph] || PAL.idle).slice();
    pal[0] = ph === "idle" || ph === "speaking" ? color() : pal[0];
    if (!cur) cur = pal.map(hex2);
    const target = pal.map(hex2);
    cur = cur.map((rgb, i) => rgb.map((v, k) => v + (target[i][k] - v) * 0.06));
    const col = (i, a) => "rgba(" + cur[i].map((v) => Math.round(v)).join(",") + "," + a + ")";
    const cx = size / 2, cy = size / 2;
    const breath = ph === "idle" ? Math.sin(t * 1.1) * 0.02 : ph === "thinking" || ph === "working" ? Math.sin(t * 3.4) * 0.03 : 0;
    const R = size * 0.27 * (1 + breath + lv * 0.16);
    // halo
    const halo = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * (1.9 + lv * 0.5));
    halo.addColorStop(0, col(0, 0.28 + lv * 0.25)); halo.addColorStop(0.55, col(2, 0.08)); halo.addColorStop(1, col(0, 0));
    g.fillStyle = halo; g.fillRect(0, 0, size, size);
    // body: backlit sphere
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    const body = g.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R * 1.05);
    body.addColorStop(0, col(1, 0.95)); body.addColorStop(0.55, col(0, 0.9)); body.addColorStop(1, col(2, 1));
    g.fillStyle = body; g.fillRect(cx - R, cy - R, R * 2, R * 2);
    // drifting plasma
    g.globalCompositeOperation = "lighter";
    const speed = ph === "listening" ? 1.6 : ph === "thinking" || ph === "working" ? 2.6 : ph === "speaking" ? 1.9 : 0.55;
    for (let i = 0; i < 4; i++) {
      const a = t * speed * (0.6 + i * 0.23) + i * 2.1;
      const bx = cx + Math.cos(a) * R * (0.42 + lv * 0.25), by = cy + Math.sin(a * 1.3) * R * 0.42;
      const br = R * (0.62 + (i % 2) * 0.18 + lv * 0.2);
      const pg = g.createRadialGradient(bx, by, 0, bx, by, br);
      pg.addColorStop(0, col(i % 3, 0.55 + lv * 0.25)); pg.addColorStop(1, col(i % 3, 0));
      g.fillStyle = pg; g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
    }
    // specular
    const sp = g.createRadialGradient(cx - R * 0.42, cy - R * 0.48, 0, cx - R * 0.42, cy - R * 0.48, R * 0.7);
    sp.addColorStop(0, "rgba(255,255,255,.42)"); sp.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = sp; g.fillRect(cx - R, cy - R, R * 2, R * 2);
    g.restore();
    // rim
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 1; g.stroke();
    // listening: a ring that breathes with your voice
    if (ph === "listening") {
      g.beginPath(); g.arc(cx, cy, R * (1.22 + lv * 0.5), 0, Math.PI * 2);
      g.strokeStyle = col(1, 0.35 + lv * 0.4); g.lineWidth = 1.5 + lv * 3; g.stroke();
    }
    // thinking: satellites
    if (ph === "thinking" || ph === "working") {
      for (let i = 0; i < 3; i++) {
        const a = t * 2.2 + i * (Math.PI * 2 / 3), r = R * 1.28;
        g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.55, 3, 0, Math.PI * 2);
        g.fillStyle = col(1, 0.9); g.fill();
      }
    }
    requestAnimationFrame(draw);
  }

  /* ───────────────────────── wiring ───────────────────────── */
  function orbClick() {
    if (DESK.phase === "listening") return stopListening(true);
    if (DESK.phase === "speaking") { stopSpeaking(); return listen(); }
    if (DESK.phase === "idle") return listen();
    // thinking / working: interrupt the turn
    post("/api/da/interrupt"); toast("Interrupted");
  }
  function escape() {
    if (DESK.listening) { stopListening(false); DESK.session = false; return true; }
    if (DESK.playing) { stopSpeaking(); DESK.session = false; return true; }
    if (DESK.phase === "thinking" || DESK.phase === "working") { post("/api/da/interrupt"); return true; }
    return false;
  }
  let spaceHeld = false;
  function init() {
    $("#deskStage").onclick = orbClick;
    $("#deskMic").onclick = orbClick;
    $("#deskSend").onclick = () => { const i = $("#deskInput"); if (i.value.trim()) { send(i.value); i.value = ""; } };
    $("#deskInput").onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); $("#deskSend").onclick(); }
      else if (e.key === "Escape") { escape(); }
    };
    $("#deskHands").onclick = () => { DESK.hands = !DESK.hands; localStorage.bridgeHands = DESK.hands ? "1" : "0"; paintState(); toast(DESK.hands ? "Hands-free on — it listens again after each answer" : "Hands-free off"); };
    $("#deskMute").onclick = () => { DESK.muted = !DESK.muted; localStorage.bridgeMuted = DESK.muted ? "1" : "0"; if (DESK.muted) stopSpeaking(); paintState(); };
    $("#deskDrawerBtn").onclick = () => drawer();
    $("#drawerClose").onclick = () => drawer(false);
    drawer(localStorage.bridgeDrawer !== "0");
    document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "u" && DESK.shown) { e.preventDefault(); drawer(); } });
    DESK.hands = localStorage.bridgeHands !== "0";
    DESK.muted = localStorage.bridgeMuted === "1";
    // hold Space to talk while the desk is showing and nothing is being typed
    document.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || !DESK.shown || e.repeat) return;
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault(); spaceHeld = true;
      if (!DESK.listening) { stopSpeaking(); listen(); }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code !== "Space" || !spaceHeld) return;
      spaceHeld = false;
      if (DESK.listening && DESK.listening.spoke) stopListening(true);
    });
    fetch("/api/voice/health").then((r) => r.json()).then((h) => { DESK.health = h; paintState(); if (DESK.phase === "idle") setPhase("idle"); }).catch(() => {});
    connect();
    board();
    requestAnimationFrame(draw);
    paintState();
    setPhase("idle");
  }
  window.BridgeReady.then(init);

  window.Desk = {
    phase: () => DESK.phase,
    shown: (on) => { DESK.shown = on; if (on) { paintState(); setTimeout(() => $("#deskInput").focus(), 30); } },
    ask, relay, escape, send, listen, board,
  };
})();
