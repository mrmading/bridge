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
 *      RUNPOD_QWEN_ENDPOINT (6fs36o7hccccvo), RUNPOD_QWEN_MODEL (the Qwen GGUF), RUNPOD_NUM_CTX (65536),
 *      RUNPOD_MAX_OUTPUT (8192, also the room kept free in the window for the answer),
 *      RUNPOD_JOB_TIMEOUT_MS (900000), RUNPOD_POLL_MS (2000), RUNPOD_PING_MS (5000),
 *      RUNPOD_QWEN_STREAM ("1" streams tokens; off, see config), RUNPOD_QWEN_TOOL_PROFILE / _SAMPLING
 *      ("0" turns each off), RUNPOD_QWEN_USD_PER_SEC,
 *      RUNPOD_QWEN_DEBUG_DIR.
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
  model?: string;
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
  // The handler pulls whatever Ollama model is named and falls back to llama3.2:3b when none is,
  // which is what every turn ran on until this was set. Q4_K_M (16 GB) + a 64k KV cache fit 48 GB.
  model: process.env.RUNPOD_QWEN_MODEL || "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:Q4_K_M",
  numCtx: num("RUNPOD_NUM_CTX", 65536),
  toolProfile: process.env.RUNPOD_QWEN_TOOL_PROFILE !== "0",
  sampling: process.env.RUNPOD_QWEN_SAMPLING !== "0",
  // Off by default: measured 2026-10-23, this handler's stream mode spent 87–91s emitting 2,000 thinking
  // tokens and no answer for a prompt it answers one-shot in 27–33s. On for a worker that streams properly.
  stream: process.env.RUNPOD_QWEN_STREAM === "1",
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

/** Claude Code's own one-line identity, which a --system-prompt cannot remove; Qwen then believes it is Claude. */
const CLAUDE_IDENTITY = /^\s*You are (a Claude agent|Claude Code)\b[^\n]*$/;
/** Injected reminders that only matter to Claude's own git habits. */
const DROPPED_REMINDER = /^Attribution for git commits/;

function convertMessages(body: Json): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const system = Array.isArray(body.system)
    ? body.system
        .map((b: Json) => b?.text ?? "")
        .filter((t: string) => t && !t.startsWith("x-anthropic-billing-header") && !CLAUDE_IDENTITY.test(t))
        .join("\n\n")
    : body.system || "";
  // Qwen's chat template renders a system message only in first position, so Claude Code's
  // mid-conversation system turns (the environment block) are folded into the leading one.
  const systemParts: string[] = system ? [system] : [];
  // Claude Code injects <system-reminder> blocks into user turns and tool results; Qwen echoes
  // them back as its answer, so they move to the system message (once each) instead.
  const fold = (text: string) =>
    text
      .replace(/<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/g, (_, inner: string) => {
        if (inner && !DROPPED_REMINDER.test(inner) && !systemParts.includes(inner)) systemParts.push(inner);
        return "";
      })
      .trim();

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
        const text = fold(blockText(r.content));
        out.push({
          role: "tool",
          content: r.is_error ? `Error: ${text}` : text,
          tool_name: toolNames.get(r.tool_use_id) || "",
          tool_call_id: r.tool_use_id,
        });
      }
      const text = fold(blockText(blocks.filter((b) => b.type !== "tool_result")));
      if (text) out.push({ role: "user", content: text });
    }
  }
  if (systemParts.length) out.unshift({ role: "system", content: systemParts.join("\n\n") });
  return out;
}

/**
 * Qwen copies whatever a schema offers: given Claude Code's full Bash/Read/Edit schemas it fills in
 * timeout, run_in_background, allow_large, replace_all and empty old_strings on every call. The core
 * tools get a short description and only the parameters a turn needs, closed so stray keys are dropped
 * by cleanInput. Property schemas come from the request, so inputs stay valid for Claude Code.
 */
const TOOL_PROFILE: Record<string, { description: string; keep: string[] }> = {
  Bash: { description: "Run a shell command in the project folder and return its output. Use it for tests, scripts, git, ls and other CLI work.", keep: ["command", "timeout"] },
  Read: { description: "Read a file and return its contents with line numbers. Paths may be relative to the project folder.", keep: ["file_path", "offset", "limit"] },
  Edit: { description: "Replace one exact, unique piece of text in a file. Read the file first; old_string must match it exactly (indentation included) and is never empty.", keep: ["file_path", "old_string", "new_string"] },
  Write: { description: "Create a file, or overwrite one, with the given content.", keep: ["file_path", "content"] },
  Glob: { description: "Find files by name pattern such as \"**/*.ts\" or \"src/*\". Returns the matching paths.", keep: ["pattern", "path"] },
  Grep: { description: "Search file contents with a regular expression. output_mode \"content\" shows matching lines with line numbers; the default lists matching files.", keep: ["pattern", "path", "glob", "output_mode"] },
};

function profiled(name: string, description: string, schema: Json, on: boolean) {
  const p = on ? TOOL_PROFILE[name] : undefined;
  if (!p || schema?.type !== "object" || !schema.properties) return { name, description, parameters: schema };
  const properties: Json = {};
  for (const k of p.keep) if (schema.properties[k]) properties[k] = schema.properties[k];
  const required = (schema.required || []).filter((k: string) => k in properties);
  return { name, description: p.description, parameters: { type: "object", properties, required, additionalProperties: false } };
}

function convertTools(body: Json, toolProfile = false): NonNullable<OllamaPayload["tools"]> {
  if (body.tool_choice?.type === "none") return [];
  return (body.tools || [])
    .filter((t: Json) => t?.input_schema && !t.defer_loading)
    .map((t: Json) => ({ type: "function" as const, function: profiled(t.name, t.description || "", t.input_schema, toolProfile) }));
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
  opts: { numCtx?: number; maxOutput?: number; model?: string; toolProfile?: boolean; sampling?: boolean } = {},
): { payload: OllamaPayload; trimmed: string[] } {
  const numCtx = opts.numCtx ?? 65536;
  const maxOutput = opts.maxOutput ?? 8192;
  const budget = Math.max(1000, (numCtx - maxOutput) * CHARS_PER_TOKEN);
  let messages = convertMessages(body);
  const tools = convertTools(body, opts.toolProfile);
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
  // Qwen's recommended thinking-mode sampling; Ollama's GGUF default (0.8, no top_k) rambles.
  if (opts.sampling) Object.assign(options, { temperature: 0.6, top_p: 0.95, top_k: 20 });
  if (typeof body.temperature === "number") options.temperature = body.temperature;
  if (typeof body.top_p === "number") options.top_p = body.top_p;
  if (typeof body.top_k === "number") options.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) options.stop = body.stop_sequences;

  const payload: OllamaPayload = { messages, options };
  if (opts.model) payload.model = opts.model;
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

const typeIs = (schema: Json | undefined, t: string) =>
  Array.isArray(schema?.type) ? schema!.type.includes(t) : schema?.type === t;

/**
 * Qwen fills every optional parameter with an explicit null and sometimes quotes numbers and
 * booleans; Claude Code rejects both with InputValidationError. Drops nulls (recursively), drops
 * keys a closed schema (additionalProperties: false) does not declare, and coerces numeric and
 * "true"/"false" strings where the schema asks for a number or boolean.
 */
function cleanInput(value: unknown, schema?: Json): unknown {
  if (typeof value === "string") {
    if ((typeIs(schema, "number") || typeIs(schema, "integer")) && value.trim() !== "" && !isNaN(Number(value))) return Number(value);
    if (typeIs(schema, "boolean") && (value === "true" || value === "false")) return value === "true";
    return value;
  }
  if (Array.isArray(value)) return value.filter((v) => v !== null).map((v) => cleanInput(v, schema?.items));
  if (value && typeof value === "object") {
    const props: Json = schema?.properties || {};
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || (schema?.additionalProperties === false && !(k in props))) continue;
      out[k] = cleanInput(v, props[k]);
    }
    return out;
  }
  return value;
}

type PseudoCall = { name: string; args: unknown };

/**
 * A whole reply that is only tool-call JSON, optionally fenced: `{"name", "arguments"|"parameters"}`,
 * the OpenAI `{"type":"function","function":{…}}` wrapper, or an array of either.
 */
function pseudoCalls(text: string): PseudoCall[] | null {
  const body = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  if (!/^[[{]/.test(body)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls: PseudoCall[] = [];
  for (const item of items) {
    const o = (item as Json)?.type === "function" && (item as Json).function ? (item as Json).function : item;
    if (typeof o?.name !== "string" || !("arguments" in o || "parameters" in o)) return null;
    calls.push({ name: o.name, args: o.arguments ?? o.parameters });
  }
  return calls.length ? calls : null;
}

/** The answer a pseudo call to a non-tool sometimes carries in its arguments. */
function spokenText(args: unknown): string {
  const o = asObject(args);
  for (const k of ["content", "text", "answer", "response", "message", "reply", "output", "description"]) {
    if (typeof o[k] === "string" && o[k].trim()) return (o[k] as string).trim();
  }
  return "";
}

/**
 * True when the model answered with a pseudo tool call to a tool that does not exist and
 * nothing readable in it, which it does now and then. Worth one retry rather than showing it.
 */
export function isMalformedToolCall(msg: AnthropicMessage, toolNames: Set<string>): boolean {
  if (msg.content.length !== 1 || msg.content[0].type !== "text") return false;
  const calls = pseudoCalls(msg.content[0].text);
  return !!calls && calls.some((c) => !toolNames.has(c.name));
}

/**
 * Builds the Anthropic message from a finished RunPod job. Strips Qwen's <think> output and
 * recovers tool calls the model wrote as text when the handler did not parse them: <tool_call>
 * tags, or a reply that is only tool-call JSON (see pseudoCalls).
 */
export function ollamaToAnthropic(res: Json, inputEstimate: number, toolNames?: Set<string>, schemas?: Map<string, Json>): AnthropicMessage {
  const { msg, meta } = extractMessage(res);
  let text = String(msg.content ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*?<\/think>/, "")
    // Echoes of the context it was given: reminders are dropped, a <system-output> wrapper unwrapped.
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<\/?(system-output|system-reminder)>/g, "");
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
  // Tool calls written as plain JSON: real tools become tool_use, a non-tool's answer becomes
  // text, and a non-tool with nothing to say is left as-is for isMalformedToolCall to retry.
  const pseudo = !raw.length && toolNames ? pseudoCalls(text) : null;
  if (pseudo) {
    const real = pseudo.filter((c) => toolNames!.has(c.name));
    const said = pseudo.filter((c) => !toolNames!.has(c.name)).map((c) => spokenText(c.args)).filter(Boolean);
    if (real.length || said.length) {
      for (const c of real) raw.push({ function: { name: c.name, arguments: c.args } });
      text = said.join("\n\n");
    }
  }

  const content: Block[] = [];
  if (text) content.push({ type: "text", text });
  for (const c of raw) {
    const fn = c?.function ?? c ?? {};
    content.push({ type: "tool_use", id: `toolu_${hexId()}`, name: String(fn.name || ""), input: cleanInput(asObject(fn.arguments), schemas?.get(String(fn.name))) as Record<string, unknown> });
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

/** Everything after message_start: one start/delta/stop per block (numbered from firstIndex), then message_delta + message_stop. */
export function sseEvents(msg: AnthropicMessage, firstIndex = 0): string[] {
  const events: string[] = [];
  msg.content.forEach((b, i) => {
    const index = firstIndex + i;
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

/* ─────────────── GPU usage per Claude Code session ─────────────── */

/** RunPod does not expose the endpoint's GPU or price to an endpoint-scoped key, so this is the
 *  flex rate of a 48 GB card unless RUNPOD_QWEN_USD_PER_SEC says otherwise. */
const DEFAULT_USD_PER_SEC = 0.00031;
const MAX_SESSIONS = 500;
const usage = new Map<string, { jobs: number; gpuMs: number }>();

function recordUsage(sessionId: string | undefined, executionMs: unknown) {
  if (!sessionId) return;
  const u = usage.get(sessionId) ?? { jobs: 0, gpuMs: 0 };
  u.jobs++;
  u.gpuMs += Number(executionMs) || 0;
  usage.delete(sessionId); // re-insert so the oldest session is the one evicted
  usage.set(sessionId, u);
  if (usage.size > MAX_SESSIONS) usage.delete(usage.keys().next().value!);
}

/**
 * Billed GPU time of every RunPod job this session ran (retries and failed jobs included), from
 * /status executionTime. Queue wait is not billed and not counted; cold-start time RunPod bills
 * is not reported per job, so the real figure can be a little higher.
 */
export function qwenUsage(sessionId: string): { jobs: number; gpuMs: number; usd: number; estimated: boolean } {
  const u = usage.get(sessionId) ?? { jobs: 0, gpuMs: 0 };
  const rate = Number(process.env.RUNPOD_QWEN_USD_PER_SEC);
  const estimated = !(rate > 0);
  return { ...u, usd: (u.gpuMs / 1000) * (estimated ? DEFAULT_USD_PER_SEC : rate), estimated };
}

/** The CLI sends x-claude-code-session-id (= --session-id); metadata.user_id carries it too. */
function sessionOf(req: Request, body: Json): string | undefined {
  const header = req.headers.get("x-claude-code-session-id");
  if (header) return header;
  try {
    return JSON.parse(body.metadata?.user_id ?? "{}").session_id || undefined;
  } catch {
    return undefined;
  }
}

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

type Acc = { content: string; tool_calls: Json[]; meta: Json };

/** Folds Ollama stream chunks (NDJSON strings or objects) into one message, calling onText per text delta. */
function foldChunks(outputs: unknown[], acc: Acc = { content: "", tool_calls: [], meta: {} }, onText?: (t: string) => void): Acc {
  for (const o of outputs) {
    const items = typeof o === "string" ? o.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : [o];
    for (const c of items) {
      if (!c || typeof c !== "object") continue;
      const m = c.message || {};
      if (typeof m.content === "string" && m.content) {
        acc.content += m.content;
        onText?.(m.content);
      }
      if (Array.isArray(m.tool_calls)) acc.tool_calls.push(...m.tool_calls);
      if (c.done) acc.meta = c;
    }
  }
  return acc;
}
const asOneShot = (a: Acc) => ({ ...a.meta, message: { role: "assistant", content: a.content, ...(a.tool_calls.length ? { tool_calls: a.tool_calls } : {}) } });

/**
 * Submits with /run and waits. With onText (and RUNPOD_QWEN_STREAM=1) the job runs with
 * stream:true and /stream/<id> is polled, so text reaches the user as it is generated instead of after
 * the whole answer; a handler without /stream falls back to /status polling. One-shot answers take
 * 10–130s, past any runsync wait.
 */
async function runJob(cfg: Cfg, input: OllamaPayload, signal: AbortSignal, sessionId?: string, onText?: (t: string) => void): Promise<Json> {
  const streaming = !!onText && cfg.stream;
  const sent = streaming ? { ...input, stream: true } : input;
  debugDump("last-payload.json", sent);
  let res = await runpod(cfg, "run", { input: sent }, signal);
  const id = res.id;
  const deadline = Date.now() + cfg.timeoutMs;
  const cancel = () => runpod(cfg, `cancel/${id}`, {}).catch(() => {});
  const acc: Acc = { content: "", tool_calls: [], meta: {} };
  let useStream = streaming;
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
    await Bun.sleep(useStream ? Math.min(cfg.pollMs, 1000) : cfg.pollMs);
    try {
      if (useStream) {
        const page = await runpod(cfg, `stream/${id}`, undefined, signal);
        foldChunks((page.stream || []).map((x: Json) => x?.output), acc, onText);
        res = { ...res, status: page.status ?? res.status };
      } else {
        res = await runpod(cfg, `status/${id}`, undefined, signal);
      }
      misses = 0;
    } catch (e) {
      if (signal.aborted) throw e;
      if (useStream) useStream = false; // a handler without /stream: poll /status instead
      else if (++misses > 5) throw e;
    }
  }
  if (streaming) {
    // /stream carries no billing figures; /status has executionTime (and the aggregated chunks)
    const final = await runpod(cfg, `status/${id}`, undefined, signal).catch(() => res);
    const streamed = useStream && (acc.content || acc.tool_calls.length || acc.meta.done);
    const folded = streamed ? acc : Array.isArray(final.output) ? foldChunks(final.output) : null;
    res = folded && final.status === "COMPLETED" ? { ...final, output: asOneShot(folded) } : final;
  }
  debugDump("last-result.json", res);
  recordUsage(sessionId, res.executionTime);
  // The handler silently swaps in its default (llama3.2:3b) when it cannot serve what was named.
  const served = (Array.isArray(res.output) ? res.output[0] : res.output)?.model;
  if (input.model && typeof served === "string" && served.toLowerCase() !== input.model.toLowerCase())
    console.error(`[qwen] WARNING: RunPod job ${id} was served by ${served}, not ${input.model}; answers will not be Qwen's`);
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
  const sessionId = sessionOf(req, body);
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());
  const toolNames = new Set((payload.tools || []).map((t) => t.function.name));
  const schemas = new Map((payload.tools || []).map((t) => [t.function.name, t.function.parameters as Json]));
  const complete = async (onText?: (t: string) => void) => {
    let msg = ollamaToAnthropic(await runJob(cfg, payload, abort.signal, sessionId, onText), inputEstimate, toolNames, schemas);
    if (isMalformedToolCall(msg, toolNames)) {
      console.error("[qwen] reply was a pseudo tool call to an unknown tool; retrying once with a correction");
      const bad = (msg.content[0] as { text: string }).text;
      const corrected: OllamaPayload = {
        ...payload,
        messages: [
          ...payload.messages,
          { role: "assistant", content: bad },
          { role: "user", content: `That reply was a tool call written as text, and "${bad.slice(0, 80)}" is not a tool the user can see. Either call one of your tools properly, or answer the previous request in plain words.` },
        ],
      };
      msg = ollamaToAnthropic(await runJob(cfg, corrected, abort.signal, sessionId), inputEstimate, toolNames, schemas);
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

  // The CLI drops a silent stream, so open it now and ping every few seconds while RunPod works. Text
  // is relayed live as RunPod streams it, unless the reply starts like JSON or markup (a pseudo tool
  // call or echoed tags), which is held for the full-answer handling; tool calls follow as blocks.
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
      let live = false;
      let held = false;
      let pending = "";
      const onText = (t: string) => {
        if (held) return;
        if (live) return send(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }));
        pending += t;
        const head = pending.trimStart();
        if (!head) return;
        if (/^[[{<`]/.test(head)) {
          held = true;
          return;
        }
        live = true;
        send(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        send(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: head } }));
      };
      try {
        const msg = await complete(onText);
        if (live) {
          send(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
          for (const e of sseEvents({ ...msg, content: msg.content.filter((b) => b.type !== "text") }, 1)) send(e);
        } else for (const e of sseEvents(msg)) send(e);
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
