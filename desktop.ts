/* The cloud computer's screen. On a Linux host (the sprite) Bridge owns a virtual desktop: Xvfb, openbox,
 * x11vnc on loopback and a Google Chrome with a loopback DevTools port. Nothing runs until it is needed:
 *
 *   a viewer opens /api/desktop/ws          → the whole desktop starts, Chrome included
 *   the agent's browser tool first connects → Bridge's loopback CDP endpoint starts it, then hands over Chrome
 *   the agent's computer tools (desktop-mcp) → the same, through /desktop/<key>/ensure
 *
 * and it stops after BRIDGE_DESKTOP_IDLE_MIN (default 10) with no viewer, no desktop turn running and no tool call.
 *
 * The VNC stream reaches the browser through Bridge's own WebSocket (no websockify): the auth gate is the
 * same as every /api route, and input is filtered here. A viewer watches; keys, pointer and clipboard from the
 * browser are dropped until the user takes control (POST /api/desktop/control), which lasts until they give it
 * back or the last viewer leaves. While the user holds control the computer tools refuse to act. */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Server, ServerWebSocket, Socket, Subprocess } from "bun";

export type DesktopConfig = {
  display: string; width: number; height: number; vncPort: number; cdpPort: number; idleMs: number;
  home: string; dir: string; mcpCli: string; enabled: boolean;
};
export function desktopConfig(env: Record<string, string | undefined> = process.env): DesktopConfig {
  const home = env.HOME || "/home/sprite";
  const dir = env.BRIDGE_DESKTOP_HOME || join(home, ".bridge-desktop");
  return {
    display: env.BRIDGE_DESKTOP_DISPLAY || ":99",
    width: Number(env.BRIDGE_DESKTOP_WIDTH || 1280), height: Number(env.BRIDGE_DESKTOP_HEIGHT || 800),
    vncPort: Number(env.BRIDGE_DESKTOP_VNC_PORT || 5999), cdpPort: Number(env.BRIDGE_DESKTOP_CDP_PORT || 9229),
    idleMs: Number(env.BRIDGE_DESKTOP_IDLE_MIN || 10) * 60_000,
    home, dir, mcpCli: join(dir, "mcp", "node_modules", "@playwright", "mcp", "cli.js"),
    enabled: env.BRIDGE_DESKTOP !== "0",
  };
}

/** the turn's tools that put something on the screen */
export const isDesktopTool = (name: string) => /^mcp__(browser|computer)__/.test(String(name || ""));

/** what a claude turn on this computer gets: Playwright MCP attached to the visible Chrome (through Bridge's
 *  lazy CDP endpoint, so Chrome starts only when the browser is first used) and the screen tools */
export function mcpConfig(cfg: DesktopConfig, o: { base: string; node: string; bun: string; repo: string }) {
  const env = { DISPLAY: cfg.display };
  return {
    mcpServers: {
      browser: { type: "stdio", command: o.node, args: [cfg.mcpCli, "--cdp-endpoint", o.base + "/cdp", "--cdp-timeout", "60000"], env },
      computer: { type: "stdio", command: o.bun, args: [join(o.repo, "desktop-mcp.ts")], env: { ...env, BRIDGE_DESKTOP_URL: o.base } },
    },
  };
}

export const DESKTOP_PROTOCOL = [
  "",
  "This computer has a screen the user can watch live in Bridge's Computer panel.",
  "- For anything on the web, use the browser tools (mcp__browser__*): they drive the visible Chrome, so the user sees each step.",
  "- For anything else on the screen, use mcp__computer__screenshot to look, then click/type/key/scroll (coordinates in screen pixels).",
  "- Bash runs with DISPLAY set, so a headed program you start appears on the same screen.",
  "- If a tool says the user has taken control, stop acting on the screen: say what you were about to do and wait for them.",
].join("\n");

/* ───────────────────────── RFB client→server filter ─────────────────────────
 * Parses the client side of the RFB protocol just enough to know message boundaries, so input messages can be
 * dropped while the user is only watching. Anything it does not understand ends the stream (error is set). */
export class RfbInputFilter {
  private buf = new Uint8Array(0);
  private stage: "version" | "security" | "auth" | "init" | "msgs" = "version";
  private v38 = true;
  error = "";
  dropped = 0;
  constructor(private allowInput: () => boolean) {}

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.error) return [];
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf); b.set(chunk, this.buf.length);
    const out: Uint8Array[] = [];
    let o = 0;
    for (;;) {
      const n = this.need(b, o);
      if (n === -1) { this.error = this.error || "unknown RFB message"; this.buf = new Uint8Array(0); return out; }
      if (n === 0 || o + n > b.length) break;
      const msg = b.subarray(o, o + n);
      if (this.stage === "msgs" && this.isInput(msg[0]) && !this.allowInput()) this.dropped++;
      else out.push(msg.slice());
      this.advance(msg);
      o += n;
    }
    this.buf = b.slice(o);
    return out;
  }
  private isInput(t: number) { return t === 4 || t === 5 || t === 6 || t === 250 || t === 251 || t === 255; }
  /** bytes the next message needs; 0 = not enough to tell yet; -1 = unknown */
  private need(b: Uint8Array, o: number): number {
    const left = b.length - o;
    switch (this.stage) {
      case "version": return 12;
      case "security": return 1;
      case "auth": return 16;
      case "init": return 1;
    }
    if (left < 1) return 0;
    const dv = new DataView(b.buffer, b.byteOffset + o, left);
    switch (b[o]) {
      case 0: return 20;                                       // SetPixelFormat
      case 2: return left < 4 ? 0 : 4 + 4 * dv.getUint16(2);   // SetEncodings
      case 3: return 10;                                       // FramebufferUpdateRequest
      case 4: return 8;                                        // KeyEvent
      case 5: return 6;                                        // PointerEvent
      case 6: return left < 8 ? 0 : 8 + Math.abs(dv.getInt32(4)); // ClientCutText (negative = extended clipboard)
      case 150: return 10;                                     // EnableContinuousUpdates
      case 248: return left < 9 ? 0 : 9 + dv.getUint8(8);      // ClientFence
      case 250: return 4;                                      // xvp
      case 251: return left < 8 ? 0 : 8 + 16 * dv.getUint8(6); // SetDesktopSize
      case 255: return 12;                                     // QEMU extended key event (noVNC sends only subtype 0)
      default: return -1;
    }
  }
  private advance(msg: Uint8Array) {
    if (this.stage === "version") {
      const v = new TextDecoder().decode(msg);
      this.v38 = !/003\.00[0-6]/.test(v);       // 3.3 has no client security byte
      this.stage = this.v38 ? "security" : "init";
    } else if (this.stage === "security") this.stage = msg[0] === 2 ? "auth" : "init";
    else if (this.stage === "auth") this.stage = "init";
    else if (this.stage === "init") this.stage = "msgs";
  }
}

/* ───────────────────────────── the desktop itself ───────────────────────────── */
type Proc = Subprocess | null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function tcpOpen(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, error() {} } });
    s.end(); return true;
  } catch { return false; }
}
async function until(test: () => Promise<boolean> | boolean, ms: number, step = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return true; await sleep(step); }
  return false;
}
const alive = (p: Proc) => !!p && p.exitCode === null && !p.killed;

/** runs in each Chrome tab: null unless it is the visible one. Fields are [x, y, w, h] in screen pixels: the viewport
 *  sits at the window's origin plus its frame (the tab strip and toolbar above, any border at the sides). */
const FOCUS_PROBE = `(() => {
  if (document.visibilityState !== "visible") return null;
  const NOTEXT = /^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i;
  const ed = (e) => !!e && !e.disabled && !e.readOnly && (e.isContentEditable || e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && !NOTEXT.test(e.type)) || /^(textbox|searchbox|combobox)$/.test(e.getAttribute && e.getAttribute("role") || ""));
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  const dpr = devicePixelRatio || 1, side = Math.max(0, (outerWidth - innerWidth) / 2), top = Math.max(0, outerHeight - innerHeight - side);
  const ox = screenX + side, oy = screenY + top, fields = [];
  for (const e of document.querySelectorAll("input,textarea,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=searchbox],[role=combobox]")) {
    if (!ed(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    fields.push([ox + r.left, oy + r.top, r.width, r.height].map((v) => Math.round(v * dpr)));
    if (fields.length >= 150) break;
  }
  return { editable: ed(a), fields };
})()`;
/** one Runtime.evaluate over a tab's DevTools socket, then closed */
function cdpEval(url: string, expression: string, ms = 1200): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const done = (f: () => void) => { clearTimeout(t); try { ws.close(); } catch {} f(); };
    const t = setTimeout(() => done(() => reject(new Error("cdp timeout"))), ms);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    ws.onmessage = (m) => {
      const j = JSON.parse(String(m.data));
      if (j.id === 1) done(() => j.error ? reject(new Error(j.error.message)) : resolve(j.result?.result?.value ?? null));
    };
    ws.onerror = () => done(() => reject(new Error("cdp socket")));
  });
}

export class Desktop {
  private xvfb: Proc = null; private wm: Proc = null; private vnc: Proc = null; private chrome: Proc = null;
  private starting: Promise<void> | null = null;
  private chromeStarting: Promise<void> | null = null;
  private lastTouch = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  viewers = 0;
  control = false;
  startedAt = 0;
  lastError = "";
  constructor(readonly cfg: DesktopConfig, private busy: () => boolean = () => false, private log: (m: string) => void = () => {}) {}

  /** a Linux host with everything deploy/desktop-install.sh puts there */
  get supported(): boolean {
    return this.cfg.enabled && process.platform === "linux" && ["Xvfb", "openbox", "x11vnc", "google-chrome"].every((b) => !!Bun.which(b));
  }
  get socketPath() { return "/tmp/.X11-unix/X" + this.cfg.display.replace(/^:/, "").split(".")[0]; }
  get running() { return existsSync(this.socketPath) && (alive(this.xvfb) || this.adoptedX); }
  private adoptedX = false;
  touch() { this.lastTouch = Date.now(); }

  status() {
    return {
      available: this.supported, running: this.running, chrome: alive(this.chrome), viewers: this.viewers, control: this.control,
      width: this.cfg.width, height: this.cfg.height, since: this.startedAt || null, idleMin: this.cfg.idleMs / 60_000, error: this.lastError || null,
    };
  }
  setControl(on: boolean) { this.control = !!on && this.viewers > 0; this.touch(); return this.status(); }

  /** start whatever is not running; with `chrome`, the browser too. Safe to call concurrently. */
  async ensure(chrome = true): Promise<void> {
    if (!this.supported) throw new Error("this computer has no desktop (Linux + deploy/desktop-install.sh)");
    this.touch();
    if (!this.starting) this.starting = this.startBase().finally(() => { this.starting = null; });
    await this.starting;
    if (chrome && !alive(this.chrome) && !(await this.cdpUp())) {
      if (!this.chromeStarting) this.chromeStarting = this.startChrome().finally(() => { this.chromeStarting = null; });
      await this.chromeStarting;
    }
    this.watchIdle();
  }
  private env() { return { ...process.env, DISPLAY: this.cfg.display, HOME: this.cfg.home } as Record<string, string>; }
  private async startBase() {
    const { display, width, height, vncPort } = this.cfg;
    if (!alive(this.xvfb)) {
      // an X server left by an earlier Bridge (or anything else) on our display is adopted, not fought
      if (existsSync(this.socketPath) && Bun.spawnSync(["xdpyinfo", "-display", display], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) this.adoptedX = true;
      else {
        Bun.spawnSync(["rm", "-f", this.socketPath, "/tmp/.X" + display.replace(/^:/, "") + "-lock"]);
        this.xvfb = Bun.spawn(["Xvfb", display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-nocursor"], { stdout: "ignore", stderr: "ignore" });
        if (!(await until(() => existsSync(this.socketPath), 5000))) { this.lastError = "Xvfb did not start"; throw new Error(this.lastError); }
        this.adoptedX = false;
        this.startedAt = Date.now();
        this.log("desktop: Xvfb " + display);
      }
      Bun.spawn(["xsetroot", "-solid", "#0b0d12"], { env: this.env(), stdout: "ignore", stderr: "ignore" });
    }
    if (!alive(this.wm) && !this.adoptedX) this.wm = Bun.spawn(["openbox"], { env: this.env(), stdout: "ignore", stderr: "ignore" });
    if (!alive(this.vnc) && !(await tcpOpen(vncPort))) {
      this.vnc = Bun.spawn(["x11vnc", "-display", display, "-rfbport", String(vncPort), "-localhost", "-shared", "-forever", "-nopw", "-quiet", "-noxdamage", "-cursor", "arrow"],
        { env: this.env(), stdout: "ignore", stderr: "ignore" });
      if (!(await until(() => tcpOpen(vncPort), 8000, 150))) { this.lastError = "x11vnc did not start"; throw new Error(this.lastError); }
    }
    this.lastError = "";
  }
  private async cdpUp(): Promise<boolean> {
    try { return (await fetch(`http://127.0.0.1:${this.cfg.cdpPort}/json/version`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
  }
  private async startChrome() {
    const profile = join(this.cfg.dir, "chrome");
    await mkdir(profile, { recursive: true });
    this.chrome = Bun.spawn(["google-chrome", "--remote-debugging-port=" + this.cfg.cdpPort, "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + profile,
      "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--disable-dev-shm-usage", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--disable-features=Translate,MediaRouter,OptimizationHints", "--start-maximized",
      "--window-position=0,0", `--window-size=${this.cfg.width},${this.cfg.height}`, "about:blank"],
      { env: this.env(), stdout: "ignore", stderr: "ignore" });
    if (!(await until(() => this.cdpUp(), 15000, 200))) { this.lastError = "Chrome did not start"; throw new Error(this.lastError); }
    this.log("desktop: Chrome on " + this.cfg.display);
  }
  /** the DevTools /json/version of the visible Chrome, started if need be (Playwright reads the WebSocket URL from it) */
  async cdpVersion(): Promise<Response> {
    await this.ensure(true);
    return fetch(`http://127.0.0.1:${this.cfg.cdpPort}/json/version`);
  }

  /** what has keyboard focus in the visible Chrome tab, plus where its text fields sit on the screen (screen px), so a
   *  phone can open its keyboard when a tap lands on one. `editable: null` = no Chrome page to ask (another app, or asleep). */
  async focus(): Promise<{ editable: boolean | null; fields: number[][] }> {
    if (!this.running || !(await this.cdpUp())) return { editable: null, fields: [] };
    let pages: any[] = [];
    try { pages = ((await (await fetch(`http://127.0.0.1:${this.cfg.cdpPort}/json/list`, { signal: AbortSignal.timeout(800) })).json()) as any[]).filter((t) => t.type === "page" && t.webSocketDebuggerUrl); } catch {}
    const found = (await Promise.all(pages.slice(0, 8).map((t) => cdpEval(t.webSocketDebuggerUrl, FOCUS_PROBE).catch(() => null)))).find((r) => r && typeof r === "object");
    return found ? { editable: !!found.editable, fields: Array.isArray(found.fields) ? found.fields : [] } : { editable: null, fields: [] };
  }

  stop(why = "stopped") {
    for (const p of [this.chrome, this.vnc, this.wm, this.xvfb]) try { p?.kill("SIGTERM"); } catch {}
    this.chrome = this.vnc = this.wm = this.xvfb = null;
    // an adopted desktop (left by an earlier Bridge) has no handles: end it by command lines anchored on the binary,
    // so a shell or a grep that merely mentions them is never hit
    const d = this.cfg.display.replace(/[.]/g, "\\.");
    for (const pat of [`^[^ ]*/chrome .*--remote-debugging-port=${this.cfg.cdpPort}( |$)`, `^x11vnc -display ${d} `, `^Xvfb ${d} `]) Bun.spawnSync(["pkill", "-f", pat], { stdout: "ignore", stderr: "ignore" });
    this.adoptedX = false; this.control = false; this.startedAt = 0;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.log("desktop: " + why);
  }
  private watchIdle() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.viewers > 0 || this.busy()) { this.touch(); return; }
      if (Date.now() - this.lastTouch > this.cfg.idleMs && this.running) this.stop("idle " + Math.round(this.cfg.idleMs / 60_000) + " min, stopped");
    }, 30_000);
  }

  /* ── /api/desktop/ws: the browser's VNC client ↔ x11vnc, input filtered ── */
  upgrade(req: Request, srv: Server): boolean {
    return srv.upgrade(req, { data: { kind: "desktop" } as any });
  }
  readonly ws = {
    open: (ws: ServerWebSocket<any>) => {
      const st: any = ws.data;
      this.viewers++; this.touch();
      st.pending = [] as Uint8Array[]; st.out = [] as Uint8Array[]; st.closed = false;
      st.filter = new RfbInputFilter(() => this.control);
      this.ensure(true).then(() => Bun.connect({
        hostname: "127.0.0.1", port: this.cfg.vncPort,
        socket: {
          data: (_s, chunk) => { if (!st.closed) ws.sendBinary(chunk); },
          drain: (s) => this.flush(st, s),
          close: () => { if (!st.closed) ws.close(1011, "screen closed"); },
          error: () => { if (!st.closed) ws.close(1011, "screen error"); },
        },
      })).then((sock: Socket) => {
        if (st.closed) { sock.end(); return; }
        st.sock = sock;
        for (const c of st.pending.splice(0)) this.write(st, c);
      }).catch((e) => { this.lastError = String(e?.message || e); if (!st.closed) ws.close(1011, this.lastError.slice(0, 100)); });
    },
    message: (ws: ServerWebSocket<any>, msg: string | Buffer) => {
      const st: any = ws.data;
      if (typeof msg === "string") return;            // noVNC speaks binary only
      this.touch();
      for (const c of st.filter.push(new Uint8Array(msg))) st.sock ? this.write(st, c) : st.pending.push(c);
      if (st.filter.error) ws.close(1003, st.filter.error);
    },
    close: (ws: ServerWebSocket<any>) => {
      const st: any = ws.data;
      st.closed = true;
      try { st.sock?.end(); } catch {}
      this.viewers = Math.max(0, this.viewers - 1);
      if (!this.viewers) this.control = false;          // nobody left watching: the screen goes back to the agent
      this.touch();
    },
  };
  private write(st: any, c: Uint8Array) {
    if (st.out.length) { st.out.push(c); return; }
    const n = st.sock.write(c);
    if (n < c.length) st.out.push(c.subarray(Math.max(0, n)));
  }
  private flush(st: any, s: Socket) {
    while (st.out.length) {
      const c = st.out[0], n = s.write(c);
      if (n < c.length) { st.out[0] = c.subarray(Math.max(0, n)); return; }
      st.out.shift();
    }
  }
}
