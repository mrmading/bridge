/**
 * Anthropic Messages API → RunPod Qwen adapter, so the real `claude` CLI can run on Nestor's
 * RunPod Qwen endpoint. Bridge routes `/qwen/*` here and spawns claude with
 * ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/qwen.
 *
 * The endpoint is not vLLM: it is an Ollama-style custom handler that only answers on
 * /v2/<id>/run (+ /status/<job>), takes {"input":{"messages","tools","options"}} and replies
 * in one shot after a minute or two. Port of ~/.hermes/runpod_openai_shim.py, with two
 * lessons kept from it:
 *  - tool_calls.arguments must be an OBJECT going in, every turn. A JSON string replayed in
 *    history makes Ollama reject the whole request ("Value looks like object…"), and only
 *    from the second turn on, so single-turn tests never catch it.
 *  - options.num_ctx must be raised (Ollama defaults to 4096) or agent prompts fail outright.
 *
 * Env: RUNPOD_QWEN_API_KEY (falls back to that one variable in ~/.claude/.env),
 *      RUNPOD_QWEN_ENDPOINT (6fs36o7hccccvo), RUNPOD_NUM_CTX (65536),
 *      RUNPOD_MAX_OUTPUT (8192, also the room kept free in the window for the answer),
 *      RUNPOD_JOB_TIMEOUT_MS (900000), RUNPOD_POLL_MS (2000), RUNPOD_PING_MS (5000).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API_ROOT = "https://api.runpod.ai/v2";
const MODEL_ID = "qwen";
/** Chars per token for budgeting. Qwen averages ~4 on prose, less on JSON and code. */
const CHARS_PER_TOKEN = 3.5;
/** A cut message keeps at least this many chars (head + tail). */
const MIN_KEEP = 2000;

/* ────────────────────────────── types ────────────────────────────── */

type Json = Record<string, any>;
export type OllamaMessage = {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
  tool_call_id?: string;
};
export type OllamaPayload = {
  messages: OllamaMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  options: Record<string, unknown>;
};
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type AnthropicMessage = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Block[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
};

/* ────────────────────────────── config ────────────────────────────── */

let dotenvKey: string | undefined;
/** Reads only RUNPOD_QWEN_API_KEY from the canonical secrets file, once. */
function apiKey(): string {
  if (process.env.RUNPOD_QWEN_API_KEY) return process.env.RUNPOD_QWEN_API_KEY;
  if (dotenvKey === undefined) {
    dotenvKey = "";
    try {
      const line = readFileSync(join(homedir(), ".claude", ".env"), "utf8").match(/^\s*(?:export\s+)?RUNPOD_QWEN_API_KEY\s*=\s*(.*)$/m);
      if (line) dotenvKey = line[1].trim().replace(/^(['"])(.*)\1$/, "$2");
    } catch {}
  }
  return dotenvKey;
}

const num = (name: string, fallback: number) => Number(process.env[name]) || fallback;
const config = () => ({
  key: apiKey(),
  endpoint: process.env.RUNPOD_QWEN_ENDPOINT || "6fs36o7hccccvo",
  numCtx: num("RUNPOD_NUM_CTX", 65536),
  maxOutput: num("RUNPOD_MAX_OUTPUT", 8192),
  timeoutMs: num("RUNPOD_JOB_TIMEOUT_MS", 900_000),
  pollMs: num("RUNPOD_POLL_MS", 2000),
  pingMs: num("RUNPOD_PING_MS", 5000),
});

export const estimateTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
const hexId = () => randomUUID().replace(/-/g, "");

/* ─────────────────────── Anthropic request → Ollama ─────────────────────── */

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: Json) => {
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      if (b?.type === "image") return "[image omitted: this model cannot see images]";
      if (b?.type === "document") return "[document omitted: this model cannot read attachments]";
      return typeof b?.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Clients replay tool input verbatim; Ollama needs an object even if it was stored as a string. */
function asObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string" && args.trim()) {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function convertMessages(body: Json): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const system = Array.isArray(body.system)
    ? body.system
        .map((b: Json) => b?.text ?? "")
        .filter((t: string) => t && !t.startsWith("x-anthropic-billing-header"))
        .join("\n\n")
    : body.system || "";
  // Qwen's chat template renders a system message only in first position, so Claude Code's
  // mid-conversation system turns (the environment block) are folded into the leading one.
  const systemParts: string[] = system ? [system] : [];

  const toolNames = new Map<string, string>();
  for (const m of body.messages || []) {
    const content = m.content;
    if (m.role === "assistant") {
      const blocks: Json[] = typeof content === "string" ? [{ type: "text", text: content }] : content || [];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          toolNames.set(b.id, b.name);
          return { function: { name: b.name, arguments: asObject(b.input) } };
        });
      const msg: OllamaMessage = { role: "assistant", content: text };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else if (m.role === "system") {
      const text = blockText(content);
      if (text) systemParts.push(text);
    } else {
      const blocks: Json[] = typeof content === "string" ? [{ type: "text", text: content }] : content || [];
      for (const r of blocks.filter((b) => b.type === "tool_result")) {
        const text = blockText(r.content);
        out.push({
          role: "tool",
          content: r.is_error ? `Error: ${text}` : text,
          tool_name: toolNames.get(r.tool_use_id) || "",
          tool_call_id: r.tool_use_id,
        });
      }
      const text = blockText(blocks.filter((b) => b.type !== "tool_result"));
      if (text) out.push({ role: "user", content: text });
    }
  }
  if (systemParts.length) out.unshift({ role: "system", content: systemParts.join("\n\n") });
  return out;
}

function convertTools(body: Json): NonNullable<OllamaPayload["tools"]> {
  if (body.tool_choice?.type === "none") return [];
  return (body.tools || [])
    .filter((t: Json) => t?.input_schema && !t.defer_loading)
    .map((t: Json) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description || "", parameters: t.input_schema },
    }));
}

const firstSentence = (s: string) => {
  const m = s.trim().match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : s.trim()).slice(0, 300);
};

const sizeOf = (messages: OllamaMessage[], tools: OllamaPayload["tools"]) =>
  messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 16, 0) +
  (tools?.length ? JSON.stringify(tools).length : 0);

/** Keeps the head and tail of a long text; the tail usually holds the actual question. */
function cutMiddle(text: string, keep: number): string {
  const head = Math.ceil((keep * 2) / 3);
  const tail = keep - head;
  return `${text.slice(0, head)}\n[... ${text.length - keep} chars cut by the Qwen adapter to fit the context window ...]\n${text.slice(text.length - tail)}`;
}

/**
 * Translates an Anthropic Messages request into the handler's input and fits it into
 * num_ctx minus the room kept for the answer. Trims in order, stopping once it fits:
 *  1. tool descriptions → first sentence (schemas untouched),
 *  2. the longest older texts → cut in the middle (system reminders, huge tool results),
 *  3. the oldest turns after the first user message → dropped (system turns kept, no orphan
 *     tool results), and finally the newest message itself is cut.
 */
export function anthropicToOllama(
  body: Json,
  opts: { numCtx?: number; maxOutput?: number } = {},
): { payload: OllamaPayload; trimmed: string[] } {
  const numCtx = opts.numCtx ?? 65536;
  const maxOutput = opts.maxOutput ?? 8192;
  const budget = Math.max(1000, (numCtx - maxOutput) * CHARS_PER_TOKEN);
  let messages = convertMessages(body);
  const tools = convertTools(body);
  const trimmed: string[] = [];

  if (sizeOf(messages, tools) > budget && tools.length) {
    const before = tools.reduce((n, t) => n + t.function.description.length, 0);
    for (const t of tools) t.function.description = firstSentence(t.function.description);
    const after = tools.reduce((n, t) => n + t.function.description.length, 0);
    trimmed.push(`tool descriptions cut to their first sentence (${before} → ${after} chars)`);
  }

  const cutOne = (candidates: OllamaMessage[]) => {
    const over = sizeOf(messages, tools) - budget;
    if (over <= 0) return false;
    const longest = candidates.reduce<OllamaMessage | null>((a, m) => (!a || m.content.length > a.content.length ? m : a), null);
    if (!longest || longest.content.length <= MIN_KEEP + 200) return false;
    const keep = Math.max(MIN_KEEP, longest.content.length - over - 200);
    const cutChars = longest.content.length - keep;
    longest.content = cutMiddle(longest.content, keep);
    return cutChars;
  };
  let cutTotal = 0;
  let cutCount = 0;
  for (let c; (c = cutOne(messages.slice(0, -1))); ) {
    cutTotal += c;
    cutCount++;
  }
  if (cutCount) trimmed.push(`cut ${cutTotal} chars from the middle of ${cutCount} long message(s)`);

  if (sizeOf(messages, tools) > budget) {
    const firstUser = messages.findIndex((m) => m.role === "user");
    let dropped = 0;
    for (let i = firstUser + 1; i < messages.length - 1 && sizeOf(messages, tools) > budget; ) {
      if (messages[i].role === "system") {
        i++;
        continue;
      }
      messages.splice(i, 1);
      dropped++;
      // A tool result without the assistant turn that called it is invalid; drop those with it.
      while (i < messages.length - 1 && messages[i].role === "tool") {
        messages.splice(i, 1);
        dropped++;
      }
    }
    if (dropped) trimmed.push(`dropped ${dropped} oldest message(s)`);
    if (sizeOf(messages, tools) > budget) {
      const c = cutOne(messages);
      if (c) trimmed.push(`cut ${c} chars from the newest message`);
    }
  }

  const options: Record<string, unknown> = { num_ctx: numCtx, num_predict: Math.min(body.max_tokens || maxOutput, maxOutput) };
  if (typeof body.temperature === "number") options.temperature = body.temperature;
  if (typeof body.top_p === "number") options.top_p = body.top_p;
  if (typeof body.top_k === "number") options.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) options.stop = body.stop_sequences;

  const payload: OllamaPayload = { messages, options };
  if (tools.length) payload.tools = tools;
  return { payload, trimmed };
}

/* ─────────────────────── Ollama response → Anthropic ─────────────────────── */

function extractMessage(res: Json): { msg: Json; meta: Json } {
  let out = res?.output;
  if (Array.isArray(out)) out = out[0] ?? {};
  if (typeof out === "string") return { msg: { content: out }, meta: {} };
  if (!out || typeof out !== "object") return { msg: { content: String(out ?? "") }, meta: {} };
  if (out.message && typeof out.message === "object") return { msg: out.message, meta: out };
  if (Array.isArray(out.choices) && out.choices.length) return { msg: out.choices[0].message || {}, meta: out };
  for (const k of ["text", "content", "response", "output"]) if (typeof out[k] === "string") return { msg: { content: out[k] }, meta: out };
  return { msg: { content: JSON.stringify(out).slice(0, 2000) }, meta: out };
}

/** A whole reply that is just `{"name": …, "arguments"|"parameters": …}`, optionally fenced. */
function bareCall(text: string): { name: string; args: unknown } | null {
  const body = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  if (!body.startsWith("{")) return null;
  try {
    const o = JSON.parse(body);
    if (typeof o?.name === "string" && ("arguments" in o || "parameters" in o)) return { name: o.name, args: o.arguments ?? o.parameters };
  } catch {}
  return null;
}

/**
 * True when the model answered with a pseudo tool call to a tool that does not exist, which
 * it does now and then under Claude Code's huge prompt. Worth one retry rather than showing it.
 */
export function isMalformedToolCall(msg: AnthropicMessage, toolNames: Set<string>): boolean {
  if (msg.content.length !== 1 || msg.content[0].type !== "text") return false;
  const call = bareCall(msg.content[0].text);
  return !!call && !toolNames.has(call.name);
}

/**
 * Builds the Anthropic message from a finished RunPod job. Strips Qwen's <think> output and
 * recovers tool calls the model wrote as text when the handler did not parse them: <tool_call>
 * tags, or a bare JSON reply naming one of `toolNames`.
 */
export function ollamaToAnthropic(res: Json, inputEstimate: number, toolNames?: Set<string>): AnthropicMessage {
  const { msg, meta } = extractMessage(res);
  let text = String(msg.content ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*?<\/think>/, "");
  const raw: Json[] = Array.isArray(msg.tool_calls) ? [...msg.tool_calls] : [];
  if (!raw.length) {
    text = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (whole, inner) => {
      try {
        const call = JSON.parse(inner);
        if (call?.name) {
          raw.push({ function: { name: call.name, arguments: call.arguments ?? call.parameters ?? {} } });
          return "";
        }
      } catch {}
      return whole;
    });
  }
  text = text.trim();
  const bare = !raw.length && toolNames ? bareCall(text) : null;
  if (bare && toolNames!.has(bare.name)) {
    raw.push({ function: { name: bare.name, arguments: bare.args } });
    text = "";
  }

  const content: Block[] = [];
  if (text) content.push({ type: "text", text });
  for (const c of raw) {
    const fn = c?.function ?? c ?? {};
    content.push({ type: "tool_use", id: `toolu_${hexId()}`, name: String(fn.name || ""), input: asObject(fn.arguments) });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  const hasTools = raw.length > 0;
  return {
    id: `msg_${hexId()}`,
    type: "message",
    role: "assistant",
    model: MODEL_ID,
    content,
    stop_reason: hasTools ? "tool_use" : meta.done_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: meta.prompt_eval_count || inputEstimate,
      output_tokens: meta.eval_count || estimateTokens(text.length + JSON.stringify(raw).length),
    },
  };
}

/* ────────────────────────────── SSE ────────────────────────────── */

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Everything after message_start: one start/delta/stop per block, then message_delta + message_stop. */
export function sseEvents(msg: AnthropicMessage): string[] {
  const events: string[] = [];
  msg.content.forEach((b, index) => {
    if (b.type === "text") {
      events.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      events.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }));
    } else {
      events.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }));
      events.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
    }
    events.push(sse("content_block_stop", { type: "content_block_stop", index }));
  });
  events.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: msg.usage }));
  events.push(sse("message_stop", { type: "message_stop" }));
  return events;
}

/* ────────────────────────────── RunPod ────────────────────────────── */

type Cfg = ReturnType<typeof config>;

/** RUNPOD_QWEN_DEBUG_DIR=<dir> keeps the last wire payload and job result for inspection. */
function debugDump(name: string, data: unknown) {
  const dir = process.env.RUNPOD_QWEN_DEBUG_DIR;
  if (dir) Bun.write(join(dir, name), JSON.stringify(data, null, 2)).catch(() => {});
}

async function runpod(cfg: Cfg, path: string, body?: unknown, signal?: AbortSignal): Promise<Json> {
  const res = await fetch(`${API_ROOT}/${cfg.endpoint}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RunPod ${path.split("/")[0]} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Submits with /run and polls /status: one-shot answers take 60–130s, past any runsync wait. */
async function runJob(cfg: Cfg, input: OllamaPayload, signal: AbortSignal): Promise<Json> {
  debugDump("last-payload.json", input);
  let res = await runpod(cfg, "run", { input }, signal);
  const id = res.id;
  const deadline = Date.now() + cfg.timeoutMs;
  const cancel = () => runpod(cfg, `cancel/${id}`, {}).catch(() => {});
  let misses = 0;
  while (["IN_QUEUE", "IN_PROGRESS"].includes(res.status)) {
    if (signal.aborted) {
      cancel();
      throw new Error("request aborted by the client");
    }
    if (Date.now() > deadline) {
      cancel();
      throw new Error(`RunPod job ${id} still ${res.status} after ${cfg.timeoutMs / 1000}s (cold workers or no GPU capacity)`);
    }
    await Bun.sleep(cfg.pollMs);
    try {
      res = await runpod(cfg, `status/${id}`, undefined, signal);
      misses = 0;
    } catch (e) {
      if (signal.aborted || ++misses > 5) throw e;
    }
  }
  debugDump("last-result.json", res);
  if (res.status !== "COMPLETED") throw new Error(`RunPod job ${id} ${res.status}: ${JSON.stringify(res.error ?? res).slice(0, 400)}`);
  return res;
}

/* ────────────────────────────── HTTP ────────────────────────────── */

const apiError = (status: number, type: string, message: string) =>
  Response.json({ type: "error", error: { type, message } }, { status });

async function messages(req: Request, cfg: Cfg): Promise<Response> {
  let body: Json;
  try {
    body = await req.json();
  } catch (e) {
    return apiError(400, "invalid_request_error", `bad JSON: ${e}`);
  }
  if (!cfg.key) return apiError(401, "authentication_error", "RUNPOD_QWEN_API_KEY is not set (env or ~/.claude/.env)");

  const { payload, trimmed } = anthropicToOllama(body, cfg);
  if (trimmed.length) console.error(`[qwen] trimmed to fit num_ctx ${cfg.numCtx}: ${trimmed.join("; ")}`);
  const inputEstimate = estimateTokens(sizeOf(payload.messages, payload.tools));
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());
  const toolNames = new Set((payload.tools || []).map((t) => t.function.name));
  const complete = async () => {
    let msg = ollamaToAnthropic(await runJob(cfg, payload, abort.signal), inputEstimate, toolNames);
    if (isMalformedToolCall(msg, toolNames)) {
      console.error("[qwen] reply was a pseudo tool call to an unknown tool; retrying once");
      msg = ollamaToAnthropic(await runJob(cfg, payload, abort.signal), inputEstimate, toolNames);
    }
    return msg;
  };

  if (!body.stream) {
    try {
      const msg = await complete();
      return Response.json(msg, { headers: trimmed.length ? { "x-qwen-trimmed": trimmed.join("; ") } : {} });
    } catch (e) {
      return apiError(500, "api_error", String((e as Error).message || e));
    }
  }

  // The job answers in one shot after a minute or more; the CLI drops a silent stream, so open
  // it now, ping every few seconds while RunPod works, then replay the answer as blocks.
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {}
      };
      send(sse("message_start", {
        type: "message_start",
        message: { id: `msg_${hexId()}`, type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputEstimate, output_tokens: 0 } },
      }));
      send(sse("ping", { type: "ping" }));
      const timer = setInterval(() => send(sse("ping", { type: "ping" })), cfg.pingMs);
      try {
        const msg = await complete();
        for (const e of sseEvents(msg)) send(e);
      } catch (e) {
        send(sse("error", { type: "error", error: { type: "api_error", message: String((e as Error).message || e) } }));
      } finally {
        clearInterval(timer);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

export async function handleQwen(req: Request, subpath: string): Promise<Response> {
  const path = subpath.split("?")[0].replace(/^\/+|\/+$/g, "");
  const cfg = config();

  if (path === "api/hello") return new Response(null, { status: 200 }); // claude's startup reachability probe
  if (path === "v1/models" || path === `v1/models/${MODEL_ID}`) {
    const model = { type: "model", id: MODEL_ID, display_name: "Qwen (RunPod)", created_at: "2026-01-01T00:00:00Z" };
    return Response.json(path === "v1/models" ? { data: [model], has_more: false, first_id: MODEL_ID, last_id: MODEL_ID } : model);
  }
  if (path === "v1/messages/count_tokens" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { payload } = anthropicToOllama(body, { numCtx: 1 << 30 });
    return Response.json({ input_tokens: estimateTokens(sizeOf(payload.messages, payload.tools)) });
  }
  if (path === "v1/messages" && req.method === "POST") return messages(req, cfg);
  return apiError(404, "not_found_error", `qwen adapter: no route for ${req.method} /${path}`);
}
