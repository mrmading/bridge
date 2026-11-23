#!/usr/bin/env bun
/**
 * Connection stability for one long Qwen turn: POSTs /api/chat to a Bridge (directly or through the
 * Worker) and records when every SSE event arrives, so drops and silent gaps show up as numbers.
 *
 *   bun providers/qwen-eval/stream-test.ts http://127.0.0.1:8811 <cwd> ["prompt"]
 */
const [base, cwd, prompt = "Read README.md, src/cart.ts, src/format.ts and src/greet.ts one at a time, then give a one-line summary of each file."] = process.argv.slice(2);
const t0 = Date.now();
const res = await fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt, cwd, provider: "qwen", permissionMode: "bypassPermissions" }),
});
let last = t0, maxGap = 0, events = 0, pings = 0, ttft = 0, tools = 0, ended = false, result = "", buf = "";
const dec = new TextDecoder();
for await (const chunk of res.body as any) {
  const now = Date.now();
  maxGap = Math.max(maxGap, now - last);
  last = now;
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) !== -1) {
    const line = buf.slice(0, i).replace(/^data: /, "");
    buf = buf.slice(i + 2);
    events++;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.t === "ping") pings++;
    if (ev.t === "end") ended = true;
    const m = ev.d;
    if (ev.t === "msg" && !ttft && (m?.type === "assistant" || (m?.type === "stream_event" && m.event?.type === "content_block_delta"))) ttft = now - t0;
    if (ev.t === "msg" && m?.type === "assistant") tools += (m.message?.content || []).filter((b: any) => b.type === "tool_use").length;
    if (ev.t === "msg" && m?.type === "result") result = String(m.result || "");
  }
}
console.log(JSON.stringify({
  status: res.status, total_s: (Date.now() - t0) / 1000, ttft_s: ttft / 1000, max_gap_s: maxGap / 1000,
  events, pings, tools, clean_end: ended, result: result.slice(0, 300),
}, null, 1));
