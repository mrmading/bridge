#!/usr/bin/env bun
/**
 * Qwen-vs-Claude eval: boots a private Bridge (own BRIDGE_PORT/BRIDGE_DATA/BRIDGE_SCOPE), sends each
 * task in tasks.ts through its /api/chat exactly as the app does, scores the transcript with the
 * task's deterministic check plus a haiku judge, and writes results/<label>.json + report.html.
 *
 *   bun providers/qwen-eval/run.ts --provider qwen --label qwen-v1 [--qwen-mode full|slim] [--only grep,edit] [--concurrency 3]
 *   bun providers/qwen-eval/run.ts --provider claude --model haiku --label haiku
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { junkIn, TASKS, type Ctx, type Task, type ToolCall, type Turn } from "./tasks";
import { writeReport } from "./report";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const provider = arg("provider", "qwen");
const model = arg("model", provider === "claude" ? "haiku" : "qwen");
const label = arg("label", `${provider}-${Date.now()}`);
const only = arg("only") ? arg("only").split(",") : null;
const concurrency = Number(arg("concurrency", "3"));
const notes = arg("notes");
const PORT = Number(arg("port", "4391"));
const HERE = import.meta.dir;
const BRIDGE = join(HERE, "..", "..");
const TURN_TIMEOUT = 15 * 60_000;

const work = join(tmpdir(), "qwen-eval", label);
rmSync(work, { recursive: true, force: true });
const data = join(work, ".bridge-data");
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "roots.json"), JSON.stringify([work]));
// a self-made connector every turn gets (enabled by default), as if added on the Connectors page
const connDir = join(data, "connectors");
mkdirSync(join(connDir, "shopdata"), { recursive: true });
cpSync(join(HERE, "connector", "shopdata", "server.ts"), join(connDir, "shopdata", "server.ts"));
writeFileSync(join(connDir, "connectors.json"), JSON.stringify({ connectors: [{ id: "shopdata", name: "shopdata", kind: "local", auth: "none",
  local: { mode: "words", baseUrl: "", authKind: "none", description: "tinyshop warehouse stock" }, enabled: true, status: "connected", createdAt: Date.now() }],
  scopes: { chats: {}, folders: {} } }));
const qwenMode = arg("qwen-mode", "full");

/* ───────────── private Bridge ───────────── */

const server = spawn("bun", ["server.ts"], {
  cwd: BRIDGE,
  env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_DATA: data, BRIDGE_SCOPE: work, BRIDGE_QWEN_MODE: qwenMode },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr!.on("data", (c) => (serverErr += c.toString()));
process.on("exit", () => server.kill());
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
  } catch {}
  if (i > 60) throw new Error("Bridge did not start:\n" + serverErr.slice(-2000));
  await Bun.sleep(500);
}

/* ───────────── one /api/chat turn ───────────── */

async function chat(dir: string, prompt: string, session: { sessionId?: string; resume?: string }): Promise<Turn> {
  const t0 = Date.now();
  const turn: Turn = { prompt, text: "", tools: [], ms: 0, ttftMs: 0 };
  const byId = new Map<string, ToolCall>();
  const body = { prompt, cwd: dir, provider, model: provider === "claude" ? model : undefined, permissionMode: "bypassPermissions", ...session };
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TURN_TIMEOUT),
    });
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of res.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, i).replace(/^data: /, "");
        buf = buf.slice(i + 2);
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.t === "error") turn.error = String(ev.d);
        if (ev.t !== "msg") continue;
        const m = ev.d;
        // time to first token: the first streamed content delta (or a whole assistant message)
        if (!turn.ttftMs && ((m.type === "stream_event" && m.event?.type === "content_block_delta") || m.type === "assistant")) turn.ttftMs = Date.now() - t0;
        if (m.type === "assistant") {
          for (const b of m.message?.content || []) {
            if (b.type === "tool_use") {
              const call: ToolCall = { name: b.name, input: b.input };
              byId.set(b.id, call);
              turn.tools.push(call);
            }
          }
        } else if (m.type === "user") {
          for (const b of m.message?.content || []) {
            if (b.type !== "tool_result") continue;
            const call = byId.get(b.tool_use_id);
            if (!call) continue;
            call.result = (typeof b.content === "string" ? b.content : (b.content || []).map((x: any) => x.text || "").join("\n")).slice(0, 1500);
            call.isError = !!b.is_error;
          }
        } else if (m.type === "result") {
          turn.text = String(m.result ?? "");
          turn.usage = m.qwen_usage;
          turn.cost = m.total_cost_usd;
          if (m.is_error) turn.error = turn.error || m.subtype || "error result";
          if (/hit your (session|usage) limit/i.test(turn.text)) turn.error = "infra: Claude usage limit";
        }
      }
    }
  } catch (e) {
    turn.error = String(e);
  }
  turn.ms = Date.now() - t0;
  return turn;
}

/* ───────────── judge ───────────── */

type Verdict = { correct: boolean; sensible: boolean; junk: boolean; tools_ok: boolean; note: string };

async function judge(task: Task, ctx: Ctx): Promise<Verdict> {
  const transcript = ctx.turns
    .map((t, n) => [
      `USER (turn ${n + 1}): ${t.prompt}`,
      ...t.tools.map((c) => `  TOOL CALL ${c.name} ${JSON.stringify(c.input).slice(0, 400)}\n  TOOL RESULT${c.isError ? " (error)" : ""}: ${(c.result || "").slice(0, 400)}`),
      `ASSISTANT FINAL ANSWER: ${t.text || "(empty)"}${t.error ? `\n  (turn error: ${t.error})` : ""}`,
    ].join("\n"))
    .join("\n\n");
  const prompt = [
    "You are grading one turn of an AI coding assistant working in a small TypeScript repo. Be strict but fair.",
    `THE ASSISTANT BEING GRADED: ${provider === "qwen" ? "Qwen, an open-weight 27B model running on the user's RunPod GPU (so it should say it is Qwen)" : `Claude (${model})`}.`,
    `THE REPO: the assistant works in ${ctx.dir}, a scratch copy of the repo; that folder IS the user's project, so files written there are in the right place.`,
    `TASK: ${task.title}`,
    `WHAT A GOOD ANSWER DOES: ${task.expect}`,
    "",
    "TRANSCRIPT:",
    transcript,
    "",
    "Grade with these booleans:",
    "- correct: the final answer and any file changes accomplish the task accurately.",
    "- sensible: a user would find the reply coherent, on-topic and appropriately brief (no rambling, no describing tools or parameters).",
    "House format: the user's own instructions ask every reply to open with a short bold header line and end with one line starting 🗣️ (spoken aloud). That format is NOT junk, chatter or a length violation; judge the substance around it.",
    "- junk: the user-facing answer contains junk such as raw JSON tool calls, XML/markup tags, echoed system text, or meta chatter.",
    "- tools_ok: tools were used when needed and not used needlessly (a couple of harmless extra reads is fine).",
    'Reply with ONLY a JSON object: {"correct":bool,"sensible":bool,"junk":bool,"tools_ok":bool,"note":"<one short sentence>"}',
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = Bun.spawn(["claude", "-p", prompt, "--model", "haiku", "--output-format", "json", "--tools", "", "--setting-sources", "project",
      "--system-prompt", "You grade AI assistant transcripts. Reply with the requested JSON only."], {
      cwd: tmpdir(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    try {
      const result = JSON.parse(out).result as string;
      const v = JSON.parse(result.slice(result.indexOf("{"), result.lastIndexOf("}") + 1));
      return { correct: !!v.correct, sensible: !!v.sensible, junk: !!v.junk, tools_ok: !!v.tools_ok, note: String(v.note || "") };
    } catch {}
  }
  return { correct: false, sensible: false, junk: false, tools_ok: false, note: "judge failed to answer" };
}

/* ───────────── run ───────────── */

function copyFixture(dir: string) {
  cpSync(join(HERE, "fixture"), dir, { recursive: true });
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".fixture")) renameSync(p, p.slice(0, -".fixture".length));
    }
  };
  walk(dir);
}

async function runTask(task: Task) {
  const dir = join(work, task.id);
  copyFixture(dir);
  const sessionId = randomUUID();
  const turns = [await chat(dir, task.prompt, { sessionId })];
  if (task.followup) turns.push(await chat(dir, task.followup, { resume: sessionId }));
  const ctx: Ctx = { dir, turns, final: turns.at(-1)!.text, tools: turns.flatMap((t) => t.tools) };
  const check = task.check?.(ctx) ?? null;
  const junk = turns.map((t) => junkIn(t.text)).find(Boolean) || null;
  const verdict = await judge(task, ctx);
  const infra = turns.map((t) => t.error).find((e) => e?.startsWith("infra:")) || null;
  const pass = !infra && !check && !junk && verdict.correct && verdict.sensible && !verdict.junk;
  const ms = turns.reduce((n, t) => n + t.ms, 0);
  const gpuMs = turns.reduce((n, t) => n + (t.usage?.gpuMs || 0), 0);
  const jobs = turns.reduce((n, t) => n + (t.usage?.jobs || 0), 0);
  const errors = turns.filter((t) => t.error).length;
  console.log(`${pass ? "PASS" : "FAIL"} ${task.id.padEnd(10)} ${(ms / 1000).toFixed(0).padStart(4)}s ttft ${(turns[0].ttftMs / 1000).toFixed(0)}s  ${infra || check || junk || (verdict.correct && verdict.sensible ? "" : verdict.note)}`);
  return { id: task.id, title: task.title, group: task.group || "core", pass, infra, check, junk, verdict, ms, ttftMs: turns[0].ttftMs, errors, jobs, gpuMs, turns };
}

const tasks = TASKS.filter((t) => !only || only.includes(t.id));
const started = new Date().toISOString();
console.log(`eval ${label}: ${provider}/${model}, ${tasks.length} tasks, concurrency ${concurrency}, work ${work}`);
const results: Awaited<ReturnType<typeof runTask>>[] = [];
const queue = [...tasks];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let t; (t = queue.shift()); ) results.push(await runTask(t));
  }),
);
results.sort((a, b) => tasks.findIndex((t) => t.id === a.id) - tasks.findIndex((t) => t.id === b.id));

const summary = {
  label, provider, model, notes, started, finished: new Date().toISOString(),
  passed: results.filter((r) => r.pass).length, total: results.length,
  core: `${results.filter((r) => r.group === "core" && r.pass).length}/${results.filter((r) => r.group === "core").length}`,
  context: `${results.filter((r) => r.group === "context" && r.pass).length}/${results.filter((r) => r.group === "context").length}`,
  parity: `${results.filter((r) => r.group === "parity" && r.pass).length}/${results.filter((r) => r.group === "parity").length}`,
  qwenMode: provider === "qwen" ? qwenMode : undefined,
  infra: results.filter((r) => r.infra).length, turnErrors: results.reduce((n, r) => n + r.errors, 0),
  medianTtftMs: results.map((r) => r.ttftMs).sort((a, b) => a - b)[Math.floor(results.length / 2)] || 0,
  medianMs: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] || 0,
  jobs: results.reduce((n, r) => n + r.jobs, 0), gpuMs: results.reduce((n, r) => n + r.gpuMs, 0),
  results,
};
mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", `${label}.json`), JSON.stringify(summary, null, 2));
console.log(`\n${label}: core ${summary.core}, context ${summary.context}, parity ${summary.parity}, infra ${summary.infra}, turn errors ${summary.turnErrors}, median ttft ${(summary.medianTtftMs / 1000).toFixed(0)}s;`, `${summary.passed}/${summary.total} passed, median ${(summary.medianMs / 1000).toFixed(0)}s, ${summary.jobs} RunPod jobs, ${(summary.gpuMs / 1000).toFixed(0)}s GPU`);
console.log("report:", writeReport());
server.kill();
process.exit(0);
