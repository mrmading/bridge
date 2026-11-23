#!/usr/bin/env bun
/** Re-applies tasks.ts checks to saved results (the scratch work dirs must still exist): bun rescore.ts <label>... */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS, junkIn } from "./tasks";
import { writeReport } from "./report";

for (const label of process.argv.slice(2)) {
  const file = join(import.meta.dir, "results", label + ".json");
  const r = JSON.parse(readFileSync(file, "utf8"));
  for (const x of r.results) {
    const task = TASKS.find((t) => t.id === x.id)!;
    const ctx = { dir: join(tmpdir(), "qwen-eval", label, x.id), turns: x.turns, final: x.turns.at(-1).text, tools: x.turns.flatMap((t: any) => t.tools) };
    x.check = task.check?.(ctx as any) ?? null;
    x.junk = x.turns.map((t: any) => junkIn(t.text)).find(Boolean) || null;
    x.pass = !x.infra && !x.check && !x.junk && x.verdict.correct && x.verdict.sensible && !x.verdict.junk;
  }
  const n = (g: string) => `${r.results.filter((x: any) => x.group === g && x.pass).length}/${r.results.filter((x: any) => x.group === g).length}`;
  Object.assign(r, { passed: r.results.filter((x: any) => x.pass).length, core: n("core"), context: n("context"), parity: n("parity") });
  writeFileSync(file, JSON.stringify(r, null, 2));
  console.log(label, "core", r.core, "context", r.context, "parity", r.parity);
}
console.log(writeReport());
