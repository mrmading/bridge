/**
 * Twelve realistic Bridge turns, each run in a fresh copy of ./fixture (a tiny "tinyshop" repo).
 * `expect` is what the LLM judge grades against; `check` is the deterministic part (null = pass).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ToolCall = { name: string; input: any; result?: string; isError?: boolean };
export type Turn = { prompt: string; text: string; tools: ToolCall[]; ms: number; error?: string; usage?: any; cost?: number };
export type Ctx = { dir: string; turns: Turn[]; final: string; tools: ToolCall[] };
export type Task = {
  id: string;
  title: string;
  prompt: string;
  followup?: string;
  expect: string;
  check?: (c: Ctx) => string | null;
};

const read = (c: Ctx, p: string) => (existsSync(join(c.dir, p)) ? readFileSync(join(c.dir, p), "utf8") : null);
const used = (c: Ctx, ...names: string[]) => c.tools.some((t) => names.includes(t.name));
const WRITES = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const fixture = (p: string) => readFileSync(join(import.meta.dir, "fixture", p), "utf8");
const unchanged = (c: Ctx) =>
  ["README.md", "src/cart.ts", "src/format.ts", "src/greet.ts"].every((p) => read(c, p) === fixture(p));

export const TASKS: Task[] = [
  {
    id: "qa",
    title: "Plain Q&A, no tools",
    prompt: "In one or two sentences: what is the difference between TCP and UDP?",
    expect: "A short, accurate answer (TCP is connection-oriented and reliable/ordered; UDP is connectionless, no delivery guarantees, lower overhead). No tools needed.",
    check: (c) => (c.tools.length ? `used tools: ${c.tools.map((t) => t.name).join(",")}` : null),
  },
  {
    id: "identity",
    title: "What model are you",
    prompt: "What model are you? One sentence.",
    expect: "Says it is Qwen (an open-weight model running on the user's RunPod) for the Qwen run, or Claude for the Claude run. One sentence, no tools, no JSON.",
    check: (c) => (c.tools.length ? "used tools" : null),
  },
  {
    id: "readme",
    title: "Summarize the README",
    prompt: "Summarize README.md in this folder in 3 bullet points.",
    expect: "Reads README.md and gives exactly 3 bullets covering what tinyshop is and its features (cart totals in cents, SAVE10 10% discount, regional tax, CSV export). No invented features.",
    check: (c) => (!used(c, "Read", "Bash", "Grep") ? "never read the file" : !/discount|SAVE10/i.test(c.final) ? "missed the discount feature" : null),
  },
  {
    id: "grep",
    title: "Find a function",
    prompt: "Which file defines the function formatPrice? Give the path and the line number.",
    expect: "Answers src/format.ts, line 2, found with a search tool (Grep/Glob/Bash grep).",
    check: (c) => (!/src\/format\.ts/.test(c.final) ? "wrong or missing path" : !/\b2\b/.test(c.final) ? "missing line 2" : null),
  },
  {
    id: "edit",
    title: "Edit a file correctly",
    prompt: "In src/greet.ts change the greeting from Hello to Hola. Don't change anything else.",
    expect: "Edits src/greet.ts so the greeting reads `Hola, ${name}!`; nothing else changes; confirms briefly.",
    check: (c) => {
      const want = fixture("src/greet.ts").replace("Hello", "Hola");
      return read(c, "src/greet.ts") === want ? null : "src/greet.ts is not exactly the expected edit";
    },
  },
  {
    id: "command",
    title: "Run a command and report",
    prompt: "Run `bun --version` and tell me the version.",
    expect: `Runs the command with Bash and reports the exact version (${Bun.version}).`,
    check: (c) => (!used(c, "Bash") ? "did not run Bash" : !c.final.includes(Bun.version) ? `version ${Bun.version} not in answer` : null),
  },
  {
    id: "bugfix",
    title: "Fix a bug and run its test",
    prompt: "The tests in src/cart.test.ts fail. Fix the bug in src/cart.ts and run the tests to confirm they pass.",
    expect: "Finds that applyDiscount returns 10% instead of 90% (totalCents * 0.1), fixes it to * 0.9 (or equivalent), runs `bun test`, and reports they pass. Does not modify the test.",
    check: (c) => {
      if (read(c, "src/cart.test.ts") !== fixture("src/cart.test.ts.fixture")) return "modified the test";
      const r = Bun.spawnSync(["bun", "test"], { cwd: c.dir });
      if (r.exitCode !== 0) return "tests still fail";
      return used(c, "Bash") ? null : "fixed but never ran the tests";
    },
  },
  {
    id: "multistep",
    title: "Create a file, then list the folder",
    prompt: "Create docs/todo.md containing a markdown list whose only item is 'ship eval', then list the docs directory and tell me what's in it.",
    expect: "Writes docs/todo.md with a single list item `- ship eval`, lists docs/ (ls or Glob), and reports that it contains todo.md.",
    check: (c) => {
      const f = read(c, "docs/todo.md");
      if (!f || !/^\s*[-*] ship eval\s*$/m.test(f)) return "docs/todo.md missing or wrong";
      return /todo\.md/.test(c.final) ? null : "answer does not mention todo.md";
    },
  },
  {
    id: "clarify",
    title: "Ask when ambiguous",
    prompt: "Rename the function.",
    expect: "The request is ambiguous (several functions, no new name). Asks a short clarifying question (which function, what name). Must not edit anything.",
    check: (c) => (used(c, ...WRITES) || !unchanged(c) ? "edited files" : !c.final.includes("?") ? "no question asked" : null),
  },
  {
    id: "noinvent",
    title: "Don't invent files",
    prompt: "What does src/payments.ts export?",
    expect: "Checks and says src/payments.ts does not exist (optionally lists the real files). Must not invent its contents or create it.",
    check: (c) =>
      existsSync(join(c.dir, "src/payments.ts")) ? "created the file" : !/(not exist|doesn't exist|does not exist|no such|not found|there is no|isn't|no file)/i.test(c.final) ? "did not say the file is missing" : null,
  },
  {
    id: "spanish",
    title: "Spanish question",
    prompt: "¿Cuál es la capital de Australia? Responde en una frase.",
    expect: "Answers in Spanish, one sentence: la capital de Australia es Canberra. No tools.",
    check: (c) => (!/Canberra/.test(c.final) ? "no Canberra" : c.tools.length ? "used tools" : null),
  },
  {
    id: "followup",
    title: "Follow-up turn uses context",
    prompt: "Read src/format.ts and tell me what formatPrice(250) returns.",
    followup: "And what would it return for 5?",
    expect: "Turn 1: \"$2.50\". Turn 2 (follow-up, relying on turn 1's context): \"$0.05\".",
    check: (c) => (!c.turns[0]?.text.includes("$2.50") ? "turn 1 missing $2.50" : !c.final.includes("$0.05") ? "turn 2 missing $0.05" : null),
  },
];

/** Output that should never reach the user: echoed tags, tool-call JSON, thinking. */
export function junkIn(text: string): string | null {
  if (/<\/?(system-reminder|system-output|tool_call|think|function_calls?)>/i.test(text)) return "markup tags";
  if (/^\s*```?(json)?\s*[\[{]\s*"(name|type|function)"/i.test(text)) return "tool-call JSON";
  if (/"parameters"\s*:\s*\{/.test(text) && /"name"\s*:/.test(text)) return "tool-call JSON";
  return null;
}
