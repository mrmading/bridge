import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  anthropicToOllama,
  estimateTokens,
  handleQwen,
  ollamaToAnthropic,
  sseEvents,
} from "./qwen";

const toolUseTurn = {
  role: "assistant",
  content: [
    { type: "text", text: "Running it." },
    { type: "tool_use", id: "toolu_abc", name: "Bash", input: { command: "echo QWEN_OK" } },
  ],
};
const toolResultTurn = {
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "toolu_abc", content: [{ type: "text", text: "QWEN_OK" }] },
    { type: "text", text: "go on" },
  ],
};

describe("anthropicToOllama", () => {
  test("system blocks, string system and mid-conversation system messages become system turns", () => {
    const { payload } = anthropicToOllama({
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
        { type: "text", text: "You are a helper." },
      ],
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "# Environment" }] },
      ],
    });
    expect(payload.messages[0]).toEqual({ role: "system", content: "You are a helper." });
    expect(payload.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(payload.messages[2]).toEqual({ role: "system", content: "# Environment" });

    const plain = anthropicToOllama({ system: "Be brief.", messages: [{ role: "user", content: "x" }] });
    expect(plain.payload.messages[0]).toEqual({ role: "system", content: "Be brief." });
  });

  test("tool_use becomes tool_calls with arguments as an OBJECT, tool_result a tool turn", () => {
    const { payload } = anthropicToOllama({
      messages: [{ role: "user", content: "run it" }, toolUseTurn, toolResultTurn],
    });
    const [, assistant, tool, user] = payload.messages;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Running it.");
    expect(assistant.tool_calls).toEqual([{ function: { name: "Bash", arguments: { command: "echo QWEN_OK" } } }]);
    expect(typeof assistant.tool_calls![0].function.arguments).toBe("object");
    expect(tool).toEqual({ role: "tool", content: "QWEN_OK", tool_name: "Bash", tool_call_id: "toolu_abc" });
    expect(user).toEqual({ role: "user", content: "go on" });
  });

  test("string arguments replayed by a client are turned back into objects (the round-trip bug)", () => {
    const { payload } = anthropicToOllama({
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: '{"file_path":"/a"}' }] },
      ],
    });
    expect(payload.messages[1].tool_calls![0].function.arguments).toEqual({ file_path: "/a" });
  });

  test("tool_result errors are marked and images are dropped with a note", () => {
    const { payload } = anthropicToOllama({
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what is this" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] },
      ],
    });
    expect(payload.messages[0].content).toContain("[image omitted");
    expect(payload.messages[0].content).toContain("what is this");
    expect(payload.messages[2].content).toBe("Error: boom");
  });

  test("thinking blocks are dropped", () => {
    const { payload } = anthropicToOllama({
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "text", text: "done" }] },
      ],
    });
    expect(payload.messages[1]).toEqual({ role: "assistant", content: "done" });
  });

  test("tools map to function tools; deferred and schema-less server tools are skipped", () => {
    const { payload } = anthropicToOllama({
      messages: [{ role: "user", content: "x" }],
      tools: [
        { name: "Bash", description: "Run a command. Long detail.", input_schema: { type: "object", properties: { command: { type: "string" } } } },
        { name: "Later", description: "d", input_schema: { type: "object" }, defer_loading: true },
        { type: "web_search_20250305", name: "web_search" },
      ],
    });
    expect(payload.tools).toEqual([
      { type: "function", function: { name: "Bash", description: "Run a command. Long detail.", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    ]);
  });

  test("options carry num_ctx, a capped num_predict and temperature", () => {
    const { payload } = anthropicToOllama(
      { messages: [{ role: "user", content: "x" }], max_tokens: 80000, temperature: 0.2 },
      { numCtx: 65536, maxOutput: 8192 },
    );
    expect(payload.options).toEqual({ num_ctx: 65536, num_predict: 8192, temperature: 0.2 });
  });

  test("nothing is trimmed when the prompt fits", () => {
    const { trimmed } = anthropicToOllama({ messages: [{ role: "user", content: "small" }] }, { numCtx: 65536, maxOutput: 8192 });
    expect(trimmed).toEqual([]);
  });

  test("over budget: tool descriptions go to their first sentence first, schemas kept", () => {
    const long = "First sentence here. " + "More detail. ".repeat(2000);
    const schema = { type: "object", properties: { a: { type: "string", description: "kept" } } };
    const { payload, trimmed } = anthropicToOllama(
      { messages: [{ role: "user", content: "x" }], tools: [{ name: "T", description: long, input_schema: schema }] },
      { numCtx: 6000, maxOutput: 1000 },
    );
    expect(payload.tools![0].function.description).toBe("First sentence here.");
    expect(payload.tools![0].function.parameters).toEqual(schema);
    expect(trimmed.join(" ")).toContain("tool descriptions");
  });

  test("still over budget: the longest context text is cut in the middle, the last user turn intact", () => {
    const huge = "A".repeat(40000) + "TAIL";
    const { payload, trimmed } = anthropicToOllama(
      { messages: [{ role: "user", content: huge }, { role: "assistant", content: "ok" }, { role: "user", content: "the question" }] },
      { numCtx: 6000, maxOutput: 1000 },
    );
    const total = payload.messages.reduce((n, m) => n + m.content.length, 0);
    expect(estimateTokens(total)).toBeLessThanOrEqual(5000);
    expect(payload.messages[0].content).toContain("[... ");
    expect(payload.messages[0].content.endsWith("TAIL")).toBe(true);
    expect(payload.messages.at(-1)!.content).toBe("the question");
    expect(trimmed.join(" ")).toContain("cut");
  });

  test("last resort: oldest turns are dropped without orphaning tool results", () => {
    const filler = (i: number) => ({ role: i % 2 ? "assistant" : "user", content: "word ".repeat(300) + i });
    const msgs: any[] = [{ role: "user", content: "first" }];
    for (let i = 1; i <= 40; i++) msgs.push(filler(i));
    msgs.push(toolUseTurn, toolResultTurn);
    const { payload, trimmed } = anthropicToOllama({ messages: msgs }, { numCtx: 3000, maxOutput: 500 });
    expect(payload.messages[0].content).toBe("first");
    const firstTool = payload.messages.findIndex((m) => m.role === "tool");
    expect(payload.messages[firstTool - 1].tool_calls).toBeDefined();
    expect(payload.messages.at(-1)!.content).toBe("go on");
    expect(trimmed.join(" ")).toContain("dropped");
  });
});

describe("ollamaToAnthropic", () => {
  test("text answer becomes an end_turn message with usage from Ollama counts", () => {
    const msg = ollamaToAnthropic({ output: { message: { role: "assistant", content: "Hello" }, prompt_eval_count: 12, eval_count: 3, done_reason: "stop" } }, 99);
    expect(msg.model).toBe("qwen");
    expect(msg.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  test("tool_calls with OBJECT arguments become tool_use blocks with fresh ids", () => {
    const msg = ollamaToAnthropic({
      output: [{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "Bash", arguments: { command: "echo QWEN_OK" } } }] } }],
    }, 10);
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content).toHaveLength(1);
    const block = msg.content[0] as any;
    expect(block.type).toBe("tool_use");
    expect(block.id).toMatch(/^toolu_[a-z0-9]{20,}$/);
    expect(block.input).toEqual({ command: "echo QWEN_OK" });
    expect(msg.usage.input_tokens).toBe(10);
  });

  test("string arguments are parsed into an input object", () => {
    const msg = ollamaToAnthropic({ output: { message: { content: "", tool_calls: [{ function: { name: "Read", arguments: '{"file_path":"/x"}' } }] } } }, 1);
    expect((msg.content[0] as any).input).toEqual({ file_path: "/x" });
  });

  test("<think> is stripped and <tool_call> text is recovered as tool_use", () => {
    const msg = ollamaToAnthropic({
      output: { message: { content: '<think>plan</think>Sure.\n<tool_call>\n{"name": "Bash", "arguments": {"command": "ls"}}\n</tool_call>' } },
    }, 1);
    expect(msg.content[0]).toEqual({ type: "text", text: "Sure." });
    expect((msg.content[1] as any).name).toBe("Bash");
    expect((msg.content[1] as any).input).toEqual({ command: "ls" });
    expect(msg.stop_reason).toBe("tool_use");
  });

  test("length stop maps to max_tokens; OpenAI-shaped and bare-string outputs are understood", () => {
    expect(ollamaToAnthropic({ output: { message: { content: "x" }, done_reason: "length" } }, 1).stop_reason).toBe("max_tokens");
    expect(ollamaToAnthropic({ output: { choices: [{ message: { content: "oa" } }] } }, 1).content).toEqual([{ type: "text", text: "oa" }]);
    expect(ollamaToAnthropic({ output: "plain" }, 1).content).toEqual([{ type: "text", text: "plain" }]);
  });
});

describe("sseEvents", () => {
  test("replays a message as Anthropic SSE with input_json_delta for tool_use", () => {
    const msg = ollamaToAnthropic({
      output: { message: { content: "Running.", tool_calls: [{ function: { name: "Bash", arguments: { command: "echo hi" } } }] }, eval_count: 7 },
    }, 5);
    const events = sseEvents(msg).map((e) => {
      const [ev, data] = e.trim().split("\n");
      return { ev: ev.slice(7), data: JSON.parse(data.slice(6)) };
    });
    expect(events.map((e) => e.ev)).toEqual([
      "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(events[0].data.content_block).toEqual({ type: "text", text: "" });
    expect(events[1].data.delta).toEqual({ type: "text_delta", text: "Running." });
    expect(events[3].data.index).toBe(1);
    expect(events[3].data.content_block).toMatchObject({ type: "tool_use", name: "Bash", input: {} });
    expect(events[4].data.delta.type).toBe("input_json_delta");
    expect(JSON.parse(events[4].data.delta.partial_json)).toEqual({ command: "echo hi" });
    expect(events[6].data.delta.stop_reason).toBe("tool_use");
    expect(events[6].data.usage.output_tokens).toBe(7);
  });
});

/* ───────────── handleQwen against a fake RunPod (fetch stubbed) ───────────── */

describe("handleQwen", () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; body: any }[] = [];
  let statusPolls = 0;

  beforeEach(() => {
    calls = [];
    statusPolls = 0;
    process.env.RUNPOD_QWEN_API_KEY = "test-key";
    process.env.RUNPOD_QWEN_ENDPOINT = "ep123";
    process.env.RUNPOD_POLL_MS = "5";
    process.env.RUNPOD_PING_MS = "5";
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith("/run")) return Response.json({ id: "job1", status: "IN_QUEUE" });
      if (url.includes("/status/job1")) {
        statusPolls++;
        if (statusPolls < 3) return Response.json({ id: "job1", status: "IN_PROGRESS" });
        return Response.json({
          id: "job1",
          status: "COMPLETED",
          output: { message: { content: "", tool_calls: [{ function: { name: "Bash", arguments: { command: "echo QWEN_OK" } } }] }, prompt_eval_count: 50, eval_count: 9 },
        });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const post = (body: unknown) =>
    new Request("http://127.0.0.1/qwen/v1/messages?beta=true", { method: "POST", body: JSON.stringify(body) });

  test("non-streaming: submits /run with the key, polls /status, returns an Anthropic message", async () => {
    const res = await handleQwen(post({ model: "qwen", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }), "v1/messages");
    expect(res.status).toBe(200);
    const msg = await res.json();
    expect(msg.type).toBe("message");
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content[0].input).toEqual({ command: "echo QWEN_OK" });
    expect(calls[0].url).toBe("https://api.runpod.ai/v2/ep123/run");
    expect(calls[0].body.input.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(calls[0].body.input.options.num_ctx).toBe(65536);
    expect(statusPolls).toBe(3);
  });

  test("streaming: message_start first, pings while the job runs, then blocks and message_stop", async () => {
    const res = await handleQwen(post({ model: "qwen", stream: true, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }), "v1/messages");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const names = [...text.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("ping");
    expect(names.slice(-2)).toEqual(["message_delta", "message_stop"]);
    expect(text).toContain('"type":"input_json_delta"');
  });

  test("count_tokens returns an estimate without calling RunPod", async () => {
    const res = await handleQwen(
      new Request("http://x/qwen/v1/messages/count_tokens", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "a".repeat(350) }] }) }),
      "v1/messages/count_tokens",
    );
    const body = await res.json();
    expect(body.input_tokens).toBeGreaterThan(50);
    expect(calls).toHaveLength(0);
  });

  test("startup probe HEAD api/hello is 200; models lists qwen; unknown paths are Anthropic-shaped 404s", async () => {
    expect((await handleQwen(new Request("http://x/qwen/api/hello", { method: "HEAD" }), "api/hello")).status).toBe(200);
    const models = await (await handleQwen(new Request("http://x/qwen/v1/models"), "v1/models")).json();
    expect(models.data[0].id).toBe("qwen");
    const nf = await handleQwen(new Request("http://x/qwen/v1/nope"), "v1/nope");
    expect(nf.status).toBe(404);
    expect((await nf.json()).type).toBe("error");
  });

  test("a FAILED job surfaces as an api_error (non-streaming 500, streaming error event)", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/run")) return Response.json({ id: "job2", status: "IN_QUEUE" });
      return Response.json({ id: "job2", status: "FAILED", error: "HTTP 400 from /api/chat" });
    }) as typeof fetch;
    const res = await handleQwen(post({ messages: [{ role: "user", content: "hi" }] }), "v1/messages");
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toContain("FAILED");
    const s = await handleQwen(post({ stream: true, messages: [{ role: "user", content: "hi" }] }), "v1/messages");
    const text = await s.text();
    expect(text).toContain("event: error");
    expect(text).toContain("HTTP 400 from /api/chat");
  });
});
