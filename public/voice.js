/* ═══════════════════════════ Talk ═══════════════════════════
 * The principal's own assistant: one persistent Claude Code process on the server (the desk),
 * one event stream here. Talk opens a full-screen orb that listens, thinks and speaks, with the
 * conversation one tap away. The same stream carries chat events (finished, needs you), which
 * app.js turns into cards. Also: dictation into any composer. */
(function () {
  const V = {
    msgs: [], phase: "idle", label: "", level: 0, smooth: 0, seq: 0, es: null, blocks: {}, da: null, health: null,
    muted: ls("bridgeMuted") === "1", hands: ls("bridgeHands") !== "0", session: false, open: false, feed: false,
    listening: null, playing: null, first: true, lastSent: null, catchUp: false, dict: null,
  };
  const color = () => (S.boot && S.boot.color) || "#3B82F6";

  /* ── phase, label, state line ─────────────────────────────────── */
  function setPhase(p, label) {
    V.phase = p;
    V.label = label !== undefined ? label : defaultLabel(p);
    const el = $("#vlabel"); if (el) el.textContent = V.label;
    $("#vMic").classList.toggle("on", p === "listening");
  }
  function defaultLabel(p) {
    if (p === "listening") return "Listening… pause when you are done";
    if (p === "thinking") return "Thinking · Esc interrupts";
    if (p === "working") return "Working · Esc interrupts";
    if (p === "speaking") return "Speaking · tap the orb to jump in";
    if (V.health && V.health.stt === "none") return "No transcriber on this machine. Type in the conversation instead";
    return matchMedia("(hover:none)").matches ? "Tap the orb to talk" : "Tap the orb or hold Space to talk";
  }
  function paintState() {
    const st = V.da || {};
    const el = $("#vstate"); if (!el) return;
    const t = !st.alive ? (st.error ? "offline · " + st.error : "starting") : st.busy ? "working" : "ready";
    el.querySelector(".t").textContent = daName() + " · " + t + (st.queued ? " · " + st.queued + " queued" : "");
    el.querySelector(".dot").className = "dot " + (!st.alive ? "" : st.busy ? "run" : "ok");
    $("#vMute").textContent = V.muted ? "Voice off" : "Voice on";
    $("#vMute").classList.toggle("on", !V.muted);
    $("#vHands").textContent = V.hands ? "Hands-free on" : "Hands-free off";
    $("#vHands").classList.toggle("on", V.hands);
    $("#vFeedBtn").classList.toggle("on", V.feed);
  }

  /* ── captions: what was just said, held while it matters ─────────── */
  function caption(you, said, ev) {
    const box = $("#vcap"); if (!box) return;
    box.innerHTML = (you ? '<span class="you">You: ' + esc(you) + "</span>" : "") + (said ? '<span class="said">' + esc(said) + "</span>" : "") + (ev ? '<span class="ev">' + esc(ev) + "</span>" : "");
  }

  /* ── the conversation feed ───────────────────────────────────────── */
  let feedRaf = 0;
  function paintFeed() {
    if (feedRaf) return;
    feedRaf = requestAnimationFrame(() => {
      feedRaf = 0;
      const box = $("#vfeedBody"); if (!box || !V.feed) return;
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
      box.innerHTML = V.msgs.slice(-80).map((m) => {
        if (m.kind === "user") return '<div class="u-msg"><div class="b prose">' + md(m.text) + "</div></div>";
        if (m.kind === "assistant") return '<div class="a-msg"><span class="ava" style="background:linear-gradient(135deg,var(--accent),var(--think))">' + esc(daName()[0]) + '</span><div class="a-body"><div class="prose' + (m.live ? " cursor" : "") + '">' + md(m.text) + "</div></div></div>";
        if (m.kind === "tool") return '<div class="step ' + (m.result ? "ok" : "") + '">' + (m.result ? ic(TOOL_ICON[m.name] || "zap") : '<span class="spin"></span>') + '<span class="st">' + esc(stepText(m.name, m.input, !!m.result)) + "</span></div>";
        if (m.kind === "event") { const e = m.ev; return '<div class="evrow" data-open="' + esc(e.key + "|" + e.id) + '"><b>' + esc(e.title) + "</b> · " + esc({ done: "finished", waiting: "needs you", error: "stopped with an error" }[e.kind] || e.kind) + (e.text ? " · " + esc(e.text.slice(0, 200)) : "") + "</div>"; }
        return "";
      }).join("") || '<div class="empty-c">Ask anything about what is going on. Answers and chat events land here.</div>';
      if (stick) box.scrollTop = box.scrollHeight;
    });
  }
  const push = (m) => { V.msgs.push(m); paintFeed(); return V.msgs.length - 1; };
  const stripBlock = (t) => String(t || "").replace(/<bridge>[\s\S]*?<\/bridge>\s*/g, "").trim();

  /* ── the stream from the server ──────────────────────────────────── */
  function connect() {
    if (V.es) { try { V.es.close(); } catch (e) {} }
    const es = new EventSource("/api/da/stream?since=" + V.seq + (V.first ? "&replay=0" : ""));
    V.es = es;
    es.onmessage = (e) => {
      let p; try { p = JSON.parse(e.data); } catch (err) { return; }
      if (p.seq) V.seq = Math.max(V.seq, p.seq);
      if (p.t === "hello") {
        V.da = p.d; paintState();
        if (V.first) { V.first = false; V.seq = p.seq || 0; loadHistory(); if (p.d.busy) { V.catchUp = true; setPhase("thinking"); } }
        return;
      }
      if (p.t === "state") { V.da = p.d; paintState(); return; }
      if (p.t === "event") { onEvent(p.d); return; }
      if (p.t === "user") { const l = V.lastSent; if (!(l && l.text === p.d.text && Date.now() - l.at < 8000)) push({ kind: "user", text: p.d.text, ts: Date.now() }); return; }
      if (p.t === "stderr") { if (/error|failed/i.test(p.d)) push({ kind: "assistant", text: "```\n" + p.d + "\n```", ts: Date.now() }); return; }
      if (p.t === "da") onDa(p.d);
    };
    es.onerror = () => { setTimeout(() => { if (V.es === es) connect(); }, 1500); };
  }
  async function loadHistory() {
    const st = V.da || {};
    if (!st.historyId) return;
    let r;
    try { r = await getJ("/api/session?key=" + encodeURIComponent(projKey(homeDir())) + "&id=" + st.historyId); } catch (e) { return; }
    if (!r || r.error) return;
    const evs = (r.events || []).filter((m) => m.kind === "user" || m.kind === "assistant" || m.kind === "tool").map((m) => (m.kind === "user" ? Object.assign(m, { text: stripBlock(m.text) }) : m)).filter((m) => !(m.kind === "user" && !m.text));
    const fresh = V.msgs.filter((m) => m.live || m.kind === "event");
    V.msgs = evs.slice(-80).concat(fresh);
    paintFeed();
  }
  function onDa(d) {
    if (!d || !d.type) return;
    if (d.type === "system" && d.subtype === "hook_started") { if (V.phase !== "idle" && V.phase !== "speaking") setPhase("working", "Running " + (d.hook_name || "a hook")); return; }
    if (d.type === "stream_event") {
      const ev = d.event; if (!ev || d.parent_tool_use_id) return;
      if (ev.type === "message_start") { V.blocks = {}; if (V.phase !== "speaking") setPhase("thinking"); return; }
      if (ev.type === "content_block_start" && (ev.content_block || {}).type === "text") V.blocks[ev.index] = push({ kind: "assistant", text: "", ts: Date.now(), live: true });
      else if (ev.type === "content_block_delta") { const i = V.blocks[ev.index]; if (i === undefined || ev.delta.type !== "text_delta") return; V.msgs[i].text += ev.delta.text; paintFeed(); }
      else if (ev.type === "content_block_stop") { const i = V.blocks[ev.index]; if (i !== undefined) { V.msgs[i].live = false; paintFeed(); } }
      return;
    }
    if (d.type === "assistant" && !d.parent_tool_use_id) {
      const streamed = Object.keys(V.blocks).length > 0;
      ((d.message && d.message.content) || []).forEach((c) => {
        if (c.type === "tool_use") { push({ kind: "tool", name: c.name, input: c.input, id: c.id, result: null }); if (V.phase !== "speaking") setPhase("working", stepText(c.name, c.input, false)); }
        else if (c.type === "text" && !streamed && c.text && c.text.trim()) push({ kind: "assistant", text: c.text, ts: Date.now() });
      });
      return;
    }
    if (d.type === "user") {
      ((d.message && d.message.content) || []).forEach((c) => { if (c.type === "tool_result") { const m = V.msgs.find((x) => x.kind === "tool" && x.id === c.tool_use_id); if (m) m.result = { isError: !!c.is_error }; } });
      paintFeed();
      if (V.phase === "working") setPhase("thinking");
      return;
    }
    if (d.type === "result") {
      V.msgs.forEach((m) => (m.live = false));
      V.blocks = {};
      if (V.catchUp) { V.catchUp = false; loadHistory(); }
      const last = V.msgs.filter((m) => m.kind === "assistant").pop();
      const spoken = last ? spokenLine(last.text) : "";
      if (d.is_error && !last) push({ kind: "assistant", text: "**" + daName() + " hit an error:** " + (d.subtype || "unknown"), ts: Date.now() });
      paintFeed();
      if (spoken) caption(V.lastSent && Date.now() - V.lastSent.at < 600000 ? V.lastSent.shown : "", spoken);
      if (spoken && !V.muted && V.open) speak(spoken, afterSpeech);
      else { setPhase("idle"); afterSpeech(); }
    }
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
  function afterSpeech() { if (V.session && V.hands && V.open && !V.muted) setTimeout(() => { if (V.phase === "idle" && V.session && V.open) listen(); }, 380); }
  function onEvent(e) {
    if (!e || !e.kind) return;
    if (typeof onServerEvent === "function") onServerEvent(e);
    if (e.kind === "started") return;
    push({ kind: "event", ev: e, ts: e.at });
    if (V.open && (e.kind === "waiting" || e.kind === "done")) caption("", "", e.title + (e.kind === "waiting" ? " needs you: " : " finished. ") + (e.text || "").slice(0, 140));
    if (e.kind === "waiting" && !S.announced.has(e.id) && ls("bridgeNotify") !== "0") say("Your " + e.folder + " chat is asking: " + (e.text || "").slice(0, 300));
  }

  /* ── sending ─────────────────────────────────────────────────────── */
  async function send(text) {
    text = String(text || "").trim();
    if (!text) return;
    if (!authed()) { openSignin("Sign in first. " + daName() + " runs on the claude CLI."); return; }
    V.lastSent = { text, shown: text.length > 140 ? text.slice(0, 137) + "…" : text, at: Date.now() };
    push({ kind: "user", text, ts: Date.now() });
    caption(V.lastSent.shown, "");
    setPhase("thinking");
    const r = await post("/api/da/send", { text });
    if (r.error) { push({ kind: "assistant", text: "**Could not reach " + daName() + ":** " + r.error, ts: Date.now() }); setPhase("idle"); return; }
    if (r.queued) toast("Queued. " + daName() + " is mid-answer");
  }

  /* ── listening ───────────────────────────────────────────────────── */
  const pickMime = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  /** record until the speaker pauses; resolves with the audio blob, or null */
  async function record(onLevel, shouldStop) {
    if (!navigator.mediaDevices || !window.MediaRecorder) return { error: "This browser cannot record. Type instead" };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { return { error: "Microphone blocked. Allow it for Bridge and try again" }; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const mime = pickMime();
    let rec; try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch (e) { rec = new MediaRecorder(stream); }
    const L = { chunks: [], spoke: false, lastVoice: 0, start: Date.now(), floor: 0.004, buf: new Float32Array(an.fftSize), mime: rec.mimeType || mime || "audio/webm" };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) L.chunks.push(e.data); };
    rec.start(250);
    post("/api/voice/warm");
    return new Promise((res) => {
      const finish = (keep, why) => {
        const done = () => { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {} try { ctx.close(); } catch (e) {} onLevel(0); const blob = new Blob(L.chunks, { type: L.mime }); res(keep && blob.size > 1200 ? { blob, mime: L.mime } : { error: why || "" }); };
        if (rec.state !== "inactive") { rec.onstop = done; rec.stop(); } else done();
      };
      const vad = () => {
        const stop = shouldStop();
        if (stop) return finish(stop === "send" && L.spoke, stop === "cancel" ? "" : "");
        an.getFloatTimeDomainData(L.buf);
        let s = 0; for (let i = 0; i < L.buf.length; i++) s += L.buf[i] * L.buf[i];
        const rms = Math.sqrt(s / L.buf.length), now = Date.now();
        if (!L.spoke) L.floor = Math.min(0.02, L.floor * 0.97 + rms * 0.03);   // the room's own noise, learned while nobody speaks
        if (rms > Math.max(0.012, L.floor * 3.2)) { L.spoke = true; L.lastVoice = now; }
        onLevel(Math.min(1, rms * 9));
        if (L.spoke && now - L.lastVoice > 1100) return finish(true);
        if (!L.spoke && now - L.start > 8000) return finish(false, "Didn't hear anything");
        if (now - L.start > 40000) return finish(true);
        requestAnimationFrame(vad);
      };
      vad();
    });
  }
  async function transcribe(r) {
    let j; try { j = await (await fetch("/api/stt", { method: "POST", headers: { "content-type": r.mime }, body: r.blob })).json(); } catch (e) { j = { error: String(e) }; }
    return j;
  }
  async function listen() {
    if (V.listening) return;
    if (V.playing) stopSpeaking();
    if (V.health && V.health.stt === "none") { setPhase("idle", "No transcriber on this machine. Type instead"); return; }
    const L = { stop: null };
    V.listening = L; V.session = true;
    setPhase("listening");
    const r = await record((lv) => (V.level = lv), () => L.stop);
    V.listening = null;
    if (r.error !== undefined || !r.blob) { setPhase("idle", r.error || undefined); if (L.stop === "cancel" || r.error) V.session = false; return; }
    setPhase("thinking", "Transcribing");
    const j = await transcribe(r);
    if (j.error && !j.text) { setPhase("idle", "Couldn't transcribe: " + j.error); return; }
    const text = String(j.text || "").trim();
    if (!text) { setPhase("idle", "Didn't catch that"); afterSpeech(); return; }
    send(text);
  }
  function stopListening(sendIt) { if (V.listening) V.listening.stop = sendIt ? "send" : "cancel"; }

  /** dictation into a composer: talk, and the words land in the text box */
  async function dictate(ta, btn) {
    if (!ta) return;
    if (V.dict) { V.dict.stop = "send"; return; }
    const D = { stop: null };
    V.dict = D;
    if (btn) btn.classList.add("on");
    toast("Listening… pause when you are done");
    const r = await record(() => {}, () => D.stop);
    V.dict = null;
    if (btn) btn.classList.remove("on");
    if (!r.blob) { if (r.error) toast(r.error); return; }
    const j = await transcribe(r);
    const text = String(j.text || "").trim();
    if (!text) { toast(j.error ? "Couldn't transcribe: " + j.error : "Didn't catch that"); return; }
    const cur = $("#ta") || ta;
    cur.value = (cur.value ? cur.value.replace(/\s*$/, " ") : "") + text;
    cur.dispatchEvent(new Event("input")); cur.focus();
  }

  /* ── speaking ────────────────────────────────────────────────────── */
  async function speak(text, done) {
    stopSpeaking();
    setPhase("speaking");
    const P = { done: false };
    V.playing = P;
    const end = () => { if (P.done) return; P.done = true; if (V.playing === P) V.playing = null; V.level = 0; if (P.ctx) try { P.ctx.close(); } catch (e) {} setPhase("idle"); if (done) done(); };
    P.end = end;
    let r;
    try { r = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); } catch (e) { return browserSpeak(text, P, end); }
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
        Object.assign(P, { ctx, src, an, buf: new Float32Array(an.fftSize) });
        src.onended = end; src.start();
        const meter = () => { if (P.done) return; an.getFloatTimeDomainData(P.buf); let s = 0; for (let i = 0; i < P.buf.length; i++) s += P.buf[i] * P.buf[i]; V.level = Math.min(1, Math.sqrt(s / P.buf.length) * 4); requestAnimationFrame(meter); };
        meter();
        return;
      } catch (e) { /* fall through */ }
    }
    let j = {}; try { j = ct.indexOf("json") >= 0 ? await r.json() : {}; } catch (e) {}
    if (j.played === "pulse") return swell(P, Math.max(1200, (j.words || text.split(/\s+/).length) / 2.7 * 1000 / 1.1 + 700), end);
    browserSpeak(text, P, end);
  }
  function browserSpeak(text, P, end) {
    if (!window.speechSynthesis) return end();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.lang = "en-US";
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => /Samantha|Daniel|Karen|Moira|Alex/.test(x.name)) || voices.find((x) => x.lang.indexOf("en") === 0);
    if (v) u.voice = v;
    u.onend = end; u.onerror = end;
    P.utter = u;
    speechSynthesis.speak(u);
    swell(P, 1e9, null);
  }
  function swell(P, ms, end) {
    const t0 = Date.now();
    const step = () => { if (P.done) return; const t = (Date.now() - t0) / 1000; V.level = 0.42 + Math.sin(t * 13.2) * 0.22 + Math.sin(t * 4.4) * 0.12; if (Date.now() - t0 > ms) { if (end) end(); return; } requestAnimationFrame(step); };
    step();
  }
  function stopSpeaking() {
    const P = V.playing; if (!P) return;
    try { if (P.src) P.src.stop(); } catch (e) {}
    try { if (P.utter) speechSynthesis.cancel(); } catch (e) {}
    if (P.end) P.end();
  }
  /** a notification's voice line: it never cuts across you, it waits its turn (up to a minute) */
  function say(text, tries) {
    if (V.muted || !text) return;
    if (V.listening || V.playing || V.dict || (V.phase !== "idle" && V.open)) { if ((tries || 0) < 60) setTimeout(() => say(text, (tries || 0) + 1), 1000); return; }
    speak(text, afterSpeech);
  }

  /* ── the orb ─────────────────────────────────────────────────────── */
  const PAL = { idle: ["#3B82F6", "#7fd0ff", "#6d5cff"], listening: ["#22d3ee", "#3B82F6", "#a5f3fc"], thinking: ["#b79cf5", "#3B82F6", "#7a4fd0"], working: ["#b79cf5", "#4aa8ff", "#7a4fd0"], speaking: ["#4aa8ff", "#7fd0ff", "#3B82F6"] };
  const hex2 = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  let cur = null;
  function draw(now) {
    if (!V.open) return;
    const c = $("#vorb");
    const dpr = Math.min(2, window.devicePixelRatio || 1), size = c.clientWidth || 280;
    if (c.width !== size * dpr) { c.width = size * dpr; c.height = size * dpr; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size, size);
    const t = now / 1000;
    V.smooth += (V.level - V.smooth) * (V.level > V.smooth ? 0.35 : 0.08);
    const lv = V.smooth, ph = V.phase;
    const pal = (PAL[ph] || PAL.idle).slice();
    if (ph === "idle" || ph === "speaking") pal[0] = /^#[0-9a-f]{6}$/i.test(color()) ? color() : pal[0];
    if (!cur) cur = pal.map(hex2);
    const target = pal.map(hex2);
    cur = cur.map((rgb, i) => rgb.map((v, k) => v + (target[i][k] - v) * 0.06));
    const col = (i, a) => "rgba(" + cur[i].map((v) => Math.round(v)).join(",") + "," + a + ")";
    const cx = size / 2, cy = size / 2;
    const breath = ph === "idle" ? Math.sin(t * 1.1) * 0.02 : ph === "thinking" || ph === "working" ? Math.sin(t * 3.4) * 0.03 : 0;
    const R = size * 0.27 * (1 + breath + lv * 0.16);
    const halo = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * (1.9 + lv * 0.5));
    halo.addColorStop(0, col(0, 0.28 + lv * 0.25)); halo.addColorStop(0.55, col(2, 0.08)); halo.addColorStop(1, col(0, 0));
    g.fillStyle = halo; g.fillRect(0, 0, size, size);
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    const body = g.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R * 1.05);
    body.addColorStop(0, col(1, 0.95)); body.addColorStop(0.55, col(0, 0.9)); body.addColorStop(1, col(2, 1));
    g.fillStyle = body; g.fillRect(cx - R, cy - R, R * 2, R * 2);
    g.globalCompositeOperation = "lighter";
    const speed = ph === "listening" ? 1.6 : ph === "thinking" || ph === "working" ? 2.6 : ph === "speaking" ? 1.9 : 0.55;
    for (let i = 0; i < 4; i++) {
      const a = t * speed * (0.6 + i * 0.23) + i * 2.1;
      const bx = cx + Math.cos(a) * R * (0.42 + lv * 0.25), by = cy + Math.sin(a * 1.3) * R * 0.42, br = R * (0.62 + (i % 2) * 0.18 + lv * 0.2);
      const pg = g.createRadialGradient(bx, by, 0, bx, by, br);
      pg.addColorStop(0, col(i % 3, 0.55 + lv * 0.25)); pg.addColorStop(1, col(i % 3, 0));
      g.fillStyle = pg; g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
    }
    const sp = g.createRadialGradient(cx - R * 0.42, cy - R * 0.48, 0, cx - R * 0.42, cy - R * 0.48, R * 0.7);
    sp.addColorStop(0, "rgba(255,255,255,.42)"); sp.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = sp; g.fillRect(cx - R, cy - R, R * 2, R * 2);
    g.restore();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 1; g.stroke();
    if (ph === "listening") { g.beginPath(); g.arc(cx, cy, R * (1.22 + lv * 0.5), 0, Math.PI * 2); g.strokeStyle = col(1, 0.35 + lv * 0.4); g.lineWidth = 1.5 + lv * 3; g.stroke(); }
    if (ph === "thinking" || ph === "working") for (let i = 0; i < 3; i++) { const a = t * 2.2 + i * (Math.PI * 2 / 3), r = R * 1.28; g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.55, 3, 0, Math.PI * 2); g.fillStyle = col(1, 0.9); g.fill(); }
    requestAnimationFrame(draw);
  }

  /* ── open, close, wiring ─────────────────────────────────────────── */
  function open(feed) {
    V.open = true;
    $("#voice").classList.add("on");
    if (feed !== undefined) V.feed = feed;
    $("#vfeed").classList.toggle("on", V.feed);
    paintState(); paintFeed(); setPhase(V.phase === "speaking" || V.phase === "thinking" || V.phase === "working" ? V.phase : "idle");
    if (!V.msgs.length || !$("#vcap").textContent) caption("", "Hi " + userName() + ". " + (S.home.needs.length ? S.home.needs.length + (S.home.needs.length === 1 ? " thing needs" : " things need") + " you. " : "") + (S.home.running.length ? S.home.running.length + (S.home.running.length === 1 ? " chat is" : " chats are") + " working." : "Nothing is running right now."));
    requestAnimationFrame(draw);
  }
  function close() {
    stopListening(false); stopSpeaking();
    V.session = false; V.open = false;
    $("#voice").classList.remove("on");
    setPhase("idle");
  }
  function orbClick() {
    if (V.phase === "listening") return stopListening(true);
    if (V.phase === "speaking") { stopSpeaking(); return listen(); }
    if (V.phase === "idle") return listen();
    post("/api/da/interrupt"); toast("Interrupted");
  }
  function escape() {
    if (V.listening) { stopListening(false); V.session = false; return; }
    if (V.playing) { stopSpeaking(); V.session = false; return; }
    if (V.phase === "thinking" || V.phase === "working") { post("/api/da/interrupt"); return; }
    close();
  }
  $("#vorb").onclick = orbClick;
  $("#vMic").onclick = orbClick;
  $("#vEnd").onclick = close;
  $("#vKeys").onclick = () => { V.feed = true; $("#vfeed").classList.add("on"); paintState(); paintFeed(); setTimeout(() => $("#vInput").focus(), 30); };
  $("#vFeedBtn").onclick = () => { V.feed = !V.feed; $("#vfeed").classList.toggle("on", V.feed); paintState(); paintFeed(); };
  $("#vHands").onclick = () => setHands(!V.hands);
  $("#vMute").onclick = () => setMuted(!V.muted);
  $("#vSend").onclick = () => { const i = $("#vInput"); if (i.value.trim()) { send(i.value); i.value = ""; } };
  $("#vInput").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); $("#vSend").onclick(); } else if (e.key === "Escape") escape(); });
  $("#vfeed").addEventListener("click", (e) => { if (e.target.closest("[data-open]")) close(); });
  function setHands(on) { V.hands = on; ls("bridgeHands", on ? "1" : "0"); paintState(); }
  function setMuted(on) { V.muted = on; ls("bridgeMuted", on ? "1" : "0"); if (on) stopSpeaking(); paintState(); }
  // hold Space to talk while Talk is open and nothing is being typed
  let spaceHeld = false;
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || !V.open || e.repeat) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault(); spaceHeld = true;
    if (!V.listening) { stopSpeaking(); listen(); }
  });
  document.addEventListener("keyup", (e) => { if (e.code === "Space" && spaceHeld) { spaceHeld = false; stopListening(true); } });
  async function refresh() { try { V.da = await getJ("/api/da/state"); } catch (e) {} V.first = true; V.msgs = []; connect(); paintState(); }

  window.BridgeReady.then(() => {
    getJ("/api/voice/health").then((h) => { V.health = h; if (V.phase === "idle") setPhase("idle"); }).catch(() => {});
    connect();
    paintState(); setPhase("idle");
  });
  window.Voice = {
    open: () => open(), close, escape, isOpen: () => V.open, dictate, say, refresh, setHands, setMuted,
    ask: (text) => { open(true); send(text); },
    state: () => ({ muted: V.muted, hands: V.hands, health: V.health, da: V.da }),
  };
})();
