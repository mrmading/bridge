#!/usr/bin/env bun
/** Renders every results/*.json into report.html: scoreboard, task × run matrix, then each answer. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS } from "./tasks";

const HERE = import.meta.dir;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

export function writeReport(): string {
  const dir = join(HERE, "results");
  const runs = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))).sort((a, b) => a.started.localeCompare(b.started))
    : [];

  const board = runs
    .map((r) => `<tr><td><b>${esc(r.label)}</b><div class="dim">${esc(r.notes)}</div></td><td>${esc(r.provider)}/${esc(r.model)}</td>
      <td class="score ${r.passed >= 10 ? "ok" : "bad"}">${r.passed}/${r.total}</td><td>${secs(r.medianMs)}</td>
      <td>${r.provider === "qwen" ? `${r.jobs} jobs · ${secs(r.gpuMs)} GPU` : "—"}</td></tr>`)
    .join("");

  const matrix = TASKS.map((t) => `<tr><td>${esc(t.title)}</td>${runs
    .map((r) => {
      const x = r.results.find((y: any) => y.id === t.id);
      if (!x) return "<td class=dim>·</td>";
      const why = x.check || x.junk || (!x.verdict.correct || !x.verdict.sensible ? x.verdict.note : "");
      return `<td class="${x.pass ? "ok" : "bad"}" title="${esc(why)}">${x.pass ? "✓" : "✗"} <span class=dim>${secs(x.ms)}</span></td>`;
    })
    .join("")}</tr>`).join("");

  const details = runs
    .slice()
    .reverse()
    .map((r) => `<details><summary><b>${esc(r.label)}</b> — ${r.passed}/${r.total} · ${esc(r.notes)}</summary>${r.results
      .map((x: any) => `<div class="task"><div class="head ${x.pass ? "ok" : "bad"}">${x.pass ? "PASS" : "FAIL"} · ${esc(x.title)} · ${secs(x.ms)}</div>
        ${x.turns.map((t: any) => `<div class="q">› ${esc(t.prompt)}</div>${t.tools.map((c: any) => `<div class="tool">${esc(c.name)} ${esc(JSON.stringify(c.input).slice(0, 160))}</div>`).join("")}<pre>${esc(t.text || t.error || "(empty)")}</pre>`).join("")}
        <div class="dim">check: ${esc(x.check || "ok")} · junk: ${esc(x.junk || "none")} · judge: ${esc(JSON.stringify({ c: x.verdict.correct, s: x.verdict.sensible, j: x.verdict.junk, t: x.verdict.tools_ok }))} — ${esc(x.verdict.note)}</div></div>`)
      .join("")}</details>`)
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qwen Eval</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--dim:#78716c;--line:#e7e5e4;--ok:#15803d;--bad:#b91c1c;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--dim:#a8a29e;--line:#292524;--ok:#4ade80;--bad:#f87171;--card:#1c1917}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}.dim{color:var(--dim);font-size:12px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card)}td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:12px;color:var(--dim);font-weight:600}.ok{color:var(--ok)}.bad{color:var(--bad)}.score{font-weight:700;font-size:16px}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:8px 12px}summary{cursor:pointer}
.task{border-top:1px solid var(--line);padding:8px 0}.head{font-weight:600}.q{margin-top:4px}.tool{font:12px ui-monospace,monospace;color:var(--dim)}
pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;margin:4px 0;font:12px/1.45 ui-monospace,monospace}
</style></head><body><h1>Qwen vs Claude in Bridge</h1><div class="dim">12 Bridge tasks via /api/chat · deterministic checks + haiku judge · pass = check ok, no junk, judged correct and sensible · generated ${new Date().toISOString()}</div>
<h2>Scoreboard</h2><div class="wrap"><table><tr><th>Run</th><th>Provider</th><th>Pass</th><th>Median turn</th><th>RunPod</th></tr>${board}</table></div>
<h2>Task × run</h2><div class="wrap"><table><tr><th>Task</th>${runs.map((r) => `<th>${esc(r.label)}</th>`).join("")}</tr>${matrix}</table></div>
<h2>Answers</h2>${details}</body></html>`;
  const out = join(HERE, "report.html");
  writeFileSync(out, html);
  return out;
}

if (import.meta.main) console.log(writeReport());
