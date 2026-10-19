# Bridge HTTP API contract

Source of truth: `server.ts` (router `Bun.serve` at L1504). Line numbers below are `server.ts` unless prefixed `app.js:` / `desk.js:` (under `public/`).
Written for a Flutter client. Read-only description of the server as of 2026-10-20.

## 0. Transport basics

| Item | Value |
|---|---|
| Base URL | `http://<host>:4270` (`BRIDGE_PORT`, L17). No `hostname` set, so Bun binds all interfaces. |
| Auth on the HTTP API | **None.** No token, no cookie, no CORS headers. Anyone who can reach the port drives the CLI. |
| JSON responses | `json()` L33: `content-type: application/json; charset=utf-8`, `cache-control: no-store`. |
| Unhandled exception | `500 {"error": "<stack>"}` (L1863). |
| Method checks | Routes marked POST only match on POST. A GET to a POST-only path falls through to static files, so you get **404 text `Not found`**, not 405. |
| Body parsing | Most POST routes do `req.json().catch(() => ({}))`, so a bad body becomes `{}`. Exceptions that throw (→500) on bad JSON: `/api/roots` POST, `/api/save`, `/api/open`, `/api/rename`, `/api/abort`, `/api/chat`. |
| SSE framing (all streaming routes) | `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`. Each frame is exactly `data: <one-line JSON>\n\n`. No `event:`, `id:` or `retry:` fields. |
| Heartbeat | Every SSE stream sends a `ping` frame every 20 s (keeps Bun's `idleTimeout: 255` s, L1506, from dropping it). |
| Envelope | Every SSE frame is `{ "t": <type>, ... }`. Payload usually under `d`. |

---

## 1. Bootstrap

### `GET /api/bootstrap` (L1514)
```json
{
  "user": "mrmading",            // settings.json daidentity.userName || basename(HOME)
  "assistant": "Paquito",        // daidentity.name || displayName || "Claude"
  "color": "#3B82F6",            // daidentity.color || ""
  "home": "/Users/mrmading",
  "claudeDir": "/Users/mrmading/.claude",
  "version": "2.x.y (Claude Code)",   // trimmed stdout of `claude --version`
  "models": ["opus", "sonnet", "haiku", "fable"],
  "permissionModes": ["acceptEdits", "auto", "plan", "bypassPermissions", "manual", "dontAsk"],
  "efforts": ["", "low", "medium", "high", "xhigh", "max"],
  "auth": AuthStatus              // see §8
}
```
Web client boots with `/api/bootstrap`, `/api/recent?limit=80`, `/api/agents`, `/api/configs`, `/api/roots` in parallel (app.js:2188).

---

## 2. Projects and sessions (history on disk)

Transcripts live at `~/.claude/projects/<key>/<sessionId>.jsonl`. `key` = cwd with every non-alphanumeric char replaced by `-` (`projectKey`, L914): `/Users/mrmading/code` → `-Users-mrmading-code`.

### `SessionMeta` (type L76, built in `computeMeta` L167, `sessionMeta` L161)
| field | type | notes |
|---|---|---|
| `id` | string | session uuid (file basename) |
| `key` | string | project dir name |
| `title` | string | custom rename > last `ai-title` > first 60 chars of preview > `"Untitled session"` |
| `preview` | string | first user text, tags stripped, ≤220 chars |
| `mtime` | number | ms epoch of the file |
| `size` | number | bytes |
| `turns` | number | count of non-sidechain string-content user lines in first 300 KB |
| `model` | string? | last assistant `message.model` in the tail |
| `cwd` | string? | first `cwd` seen |
| `branch` | string? | `gitBranch` at that line |
| `named` | true? | present only when a custom title exists |

### `GET /api/projects` (L1539, `listProjects` L198)
Array, sorted by `lastActivity` desc. Only dirs with ≥1 `.jsonl`.
```json
[{ "key": "-Users-mrmading-code", "path": "/Users/mrmading/code", "name": "code",
   "sessions": 12, "lastActivity": 1760000000000, "exists": true }]
```
`path` is the cwd from the newest transcript; fallback is a lossy decode of `key`.

### `GET /api/sessions?key=<key>` (L1540, `listSessions` L225)
`SessionMeta[]`, newest first, max 200. Unknown key → `[]`.

### `GET /api/recent?limit=<n>` (L1541)
`limit` default 60, capped 200. Takes 30 newest per project, merges, sorts by `mtime` desc.
Each item = `SessionMeta` + `{ project: <key>, projectName: <basename>, projectPath: <cwd> }`.

### `GET /api/search?q=<term>` (L1790)
Substring match on `title + " " + preview`, case-insensitive. `q` shorter than 2 chars → `[]`. Scans 40 projects × 60 sessions, stops after ~61 hits.
Each item = `SessionMeta` + `{ project: <project NAME, not key>, projectPath }`. **Note the inconsistency with `/api/recent` where `project` is the key.** Use `key` from SessionMeta.

### `GET /api/find?q=&scope=all|project|folder&key=&cwd=` (L1786, `findSessions` L538)
Full-text ripgrep over transcripts. `scope=project` needs `key`; `scope=folder` needs `cwd` (matches that path and its subfolders); anything else = all. Tokens: lowercase words >2 chars minus stopwords, max 8. Max 24 results, best first. Empty query → `[]`. The web client retries with `scope=all` when a narrower scope returns nothing (app.js:1944).
Each item = `SessionMeta` +
| field | type |
|---|---|
| `hits` | number, total match count |
| `covered` | number, terms matched |
| `terms` | number, terms in query |
| `score` | number |
| `project` | string, **key** |
| `projectPath` | string, `meta.cwd` or `""` |
| `first` | string, first user message ≤240 |
| `last` | string, last assistant text ≤240 |
| `tools` | number, tool_use count |
| `wrote` | string[], up to 8 Write/Edit/NotebookEdit paths |
| `snippets` | string[], up to 3 `…context…` strings around a hit |

### `POST /api/rename` (L1805)
Body `{ "id": string (required), "title": string }`. Empty title clears. Title is trimmed and capped at 120 chars. Stored in Bridge sidecar `~/.claude/bridge/titles.json`, transcript untouched.
→ `{ "ok": true, "id": "...", "title": "<stored>", "named": boolean }` · `400 {"error":"id required"}`.

---

## 3. `GET /api/session?key=<key>&id=<id>` — normalized transcript (L1550, `normalizeLines` L243)

`404 {"error":"not found"}` if the file is missing.

```json
{
  "events": [Event, ...],
  "meta": {
    "model": "claude-opus-...",      // last assistant model, "" if none
    "cwd": "/path", "branch": "main", // first line carrying cwd
    "title": "ai-title or custom",    // custom rename overrides
    "named": true,                    // only when a custom title exists
    "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "thinking": 0 },  // summed once per requestId
    "outputs": [{ "path": "/abs/file", "tool": "Write|Edit|NotebookEdit|Artifact", "ts": "ISO" }],
    "hookCount": 3                    // count of attachment lines with type hook_success
  },
  "offset": 123456                    // byte length up to the last "\n": pass as `from` to /api/follow
}
```

### Event kinds (exactly what is emitted)
| `kind` | fields | source |
|---|---|---|
| `user` | `text`, `ts` (ISO string), `uuid` | non-sidechain `type:"user"` line. String content, or array `text` parts joined by `\n`. `<system-reminder>…</system-reminder>` removed. Empty after cleaning → skipped. Tool-result-only user lines produce no `user` event. |
| `assistant` | `text`, `ts`, `uuid`, `model` | non-sidechain assistant `text` block (non-blank) |
| `agent_text` | `text`, `ts`, `uuid`, `model` | **sidechain** assistant `text` block. No `side` field. |
| `thinking` | `text`, `ts`, `uuid`, `side: boolean` | assistant `thinking` block (non-blank) |
| `tool` | `name`, `input` (raw tool input object), `id` (tool_use id), `ts`, `side: boolean`, `result: ToolResult \| null` | assistant `tool_use` block, joined with its result |

`ToolResult` = `{ "content": string, "isError": boolean, "structured": any|null /* the line's toolUseResult */, "ts": "ISO" }`. `content` is flattened (L322): text parts joined by `\n`, images as `[image]`, other parts as JSON.

Not emitted as events: sidechain **user** lines, hook lines (only `meta.hookCount`), system lines, attachments, `ai-title`. **No phase/ISC data** is produced by the server. Phases/plans are a client-side render of assistant text. `ts` in transcript events is an ISO string; events built live by the web client use ms numbers, so accept both.

Desk history: the desk transcript is `key = projectKey(home)` with `id = daState.historyId`. Its `user` texts start with a `<bridge>…</bridge>` block that clients strip (desk.js:243).

---

## 4. `POST /api/chat` — run one turn (L1827, `runClaude` L610)

Response is **SSE over a POST**. You cannot use an `EventSource`-style client. Read the body stream, split on `\n\n`, drop frames not starting with `data: `, `JSON.parse` the rest (app.js:1666).

### Request body
| field | type | default | effect |
|---|---|---|---|
| `prompt` | string | **required in practice** | Passed as the positional arg (no attachments) or as the first text part (attachments). If missing without attachments, `undefined` goes into argv. |
| `resume` | string \| null | — | Session id to continue → `--resume <id>`. |
| `sessionId` | string | random UUID | Used only when `resume` is absent → `--session-id <id>`. Lets the client pick the id of a new session. |
| `cwd` | string | `$HOME` | Must be inside a Bridge root (see §9). Outside → silently falls back to `$HOME`. |
| `model` | string \| null | CLI default | `--model`. Values from bootstrap `models`. |
| `permissionMode` | string | `"acceptEdits"` | `--permission-mode`. |
| `effort` | string \| null | none | `--effort` when truthy. |
| `agent` | string \| null | none | Must match `^[A-Za-z0-9:_-]{1,64}$`, else ignored. Adds `--agent` **and** appends a system-prompt rule telling the main loop to dispatch that agent with the Agent tool. `"auto"` is resolved **client-side** first via `/api/route` (app.js:1649). The server would treat `"auto"` as a literal agent name. |
| `attachments` | Attachment[] | `[]` | See below. |

Every turn also gets `--append-system-prompt BRIDGE_PROTOCOL` (L22) plus `-p --output-format stream-json --include-partial-messages --verbose`.

`Attachment`: either `{ path }` (server reads it) or `{ kind, data, mediaType?, name? }` (client inlines it).
| field | notes |
|---|---|
| `path` | Abs path inside roots, not sensitive, a file. `.png/.jpg/.jpeg/.gif/.webp/.svg` → inlined as base64 image; other files ≤200 KB → inlined as text; larger → skipped. |
| `kind` | `"image"` or `"text"` |
| `data` | base64 (no `data:` prefix) for images, raw text for text |
| `mediaType` | e.g. `image/png` (images) |
| `name` | label used in `File: <name>` header for text |
Attachments that fail get an `error` set server-side and are silently dropped. With ≥1 usable attachment the CLI is started with `--input-format stream-json` and one user envelope is written to stdin: `[{type:"text",text:prompt}, {type:"image",source:{type:"base64",media_type,data}} | {type:"text",text:"File: name\n```\n...\n```"}]`.

### Stream frames, in order
| order | frame | meaning |
|---|---|---|
| 0 (only if signed out) | `{"t":"auth","d":AuthStatus}` then `{"t":"end","code":0}` | Turn never started. Show sign-in. |
| 1 | `{"t":"start","sessionId":"<key>","cwd":"/abs","args":[...argv]}` | `sessionId` = `resume ?? sessionId`. **This is the key `/api/abort` needs.** |
| n | `{"t":"msg","d":<one CLI stream-json object, verbatim>}` | Every stdout line from `claude -p`. |
| any | `{"t":"stderr","d":"<chunk>"}` | Raw stderr chunk. Web client hides lines matching `/hook\|deprecat\|warning/i`. |
| any | `{"t":"raw","d":"<line>"}` | Stdout line that was not JSON. |
| any | `{"t":"ping","ts":<ms>}` | Heartbeat, every 20 s. |
| last | `{"t":"end","code":<exit code\|null>}` | Child process closed. The HTTP stream closes. **This is the end of the turn**, not `result`. |
| alt. last | `{"t":"error","d":"<spawn error>"}` | Spawn failure. Stream closes right after. Usually no `end`. |

### Stream-json objects (`d` of `t:"msg"`) the clients act on
All lines are forwarded verbatim. The ones the web client handles (app.js:1555-1645, desk.js:248-305):
| `d.type` / `subtype` | use |
|---|---|
| `system` / `init` | `d.session_id` is the CLI's session id. `d.model`. Client sets its tab id from it. |
| `system` / `hook_started` | status "Running `d.hook_name`" |
| `system` / `hook_response` | hook finished |
| `stream_event` | `d.event` is an Anthropic streaming event. `d.parent_tool_use_id` non-null = sidechain (subagent). |
| ↳ `message_start` | reset the per-message block index map |
| ↳ `content_block_start` | `event.index`, `event.content_block.type` ∈ `text`, `thinking`, `tool_use`, `server_tool_use`, `redacted_thinking`. Open a live row for `text` / `thinking`. |
| ↳ `content_block_delta` | `event.delta.type`: `text_delta` → append `delta.text`; `thinking_delta` → append `delta.thinking`; `input_json_delta` etc. ignored. |
| ↳ `content_block_stop` | close the live row |
| ↳ `message_delta`, `message_stop` | forwarded, unused |
| `assistant` | Full message `d.message.content[]`. Create `tool` rows from `tool_use` blocks (`id`, `name`, `input`). Use `text` blocks only if no `stream_event` blocks were seen for this message (avoid doubles). `d.message.usage` for usage. |
| `user` | `d.message.content[]` items of `type:"tool_result"`: match `tool_use_id` → tool row; `content` string or array of `{type,text}`; `is_error`. |
| `result` | Turn summary: `subtype`, `is_error`, `total_cost_usd`, `duration_ms`, `num_turns`. **The process may stay alive after `result`** (e.g. a Workflow reporting back), so wait for `end`. |

### Session id rules
- New session: omit `resume`. Optionally send `sessionId` to choose the uuid. The `start` frame echoes it.
- Resume: send `resume: <id>`. The CLI may report a different `session_id` in `system/init`. Persist the init id for the next turn's `resume`.
- Abort uses the `start.sessionId` (the `live` map key), not the init id.

### Cancellation: `POST /api/abort` (L1812)
Body `{ "sessionId": "<start.sessionId>" }` → `{ "ok": boolean }` (`false` = no running child under that key).
Sends SIGINT, then SIGTERM after 1.5 s, then SIGKILL after 4 s if still the same child. The `/api/chat` stream then ends with `{"t":"end","code":...}`.
**Dropping the HTTP connection does not stop the turn.** The stream has no `cancel` handler, so the CLI keeps running.

---

## 5. Live terminal sessions

The server polls `~/.claude/sessions/<pid>.json` every 1.5 s (`watchLive` L1018). Only interactive, alive, non-Bridge, non-desk processes are listed (`liveSessions` L985). Print-mode runs (including Bridge's own `/api/chat`) never appear.

### `GET /api/live` (L1572)
```json
{ "now": 1760000000000, "sessions": [LiveSession], "events": [LiveEvent] /* last 40 */ }
```
`LiveSession` (L972):
| field | type | notes |
|---|---|---|
| `pid` | number | |
| `id` | string | session uuid |
| `key` | string | `projectKey(cwd)` |
| `cwd` | string | where the CLI started |
| `name` | string | registry name or `"claude <pid>"` |
| `status` | string | `"busy"` \| `"idle"` (from registry) |
| `startedAt`, `updatedAt` | number | ms |
| `file` | string | abs transcript path |
| `version` | string? | CLI version |
| `title` | string | meta title, else last user text, else folder |
| `folder` | string | basename of current work dir, `"home"` for $HOME |
| `last` | string | last assistant text, markdown-stripped, ≤400 |
| `lastTs` | number | ms |
| `lastUser` | string | ≤200 |
| `waiting` | `null` \| `{ kind: "question"\|"plan"\|"permission", text, options?: string[] }` | Hard signal: pending `AskUserQuestion` (options = labels, ≤6) or `ExitPlanMode`. Soft signal: idle and last line ends in `?`. `"permission"` is declared but never produced. |
| `turns` | number | user turns in the tail |

`LiveEvent` (L1013): `{ kind: "started"|"ended"|"done"|"waiting", at, pid, id, key, name, folder, cwd, title, text, options? }`. `done` = busy→idle with no waiting. `text` = last assistant text for `done`, question text for `waiting`, title otherwise. The same events are pushed on the desk stream as `{t:"event"}` and raise macOS notifications.

### `POST /api/live/takeover` (L1573, `takeover` L1063)
Body `{ "pid": number, "id": string }`. Only works when that pid/id pair is live and `idle`. SIGTERMs the terminal and waits (up to ~9 s total, then SIGHUP).
→ `{ "ok": true, "id", "key", "cwd" }` · `{ "ok": false, "error": "<human message>" }`. Then continue with `/api/chat` `resume: id`, `cwd`.

### `GET /api/follow?key=&id=&from=<byteOffset>` (L1582, `followTranscript` L1089)
`404 {"error":"not found"}` before the stream if the file is missing. Polls file growth every 650 ms. Read-only.
| frame | fields |
|---|---|
| `{"t":"events", ...}` | `events`: Event[] (same kinds as §3, only for the new lines). `patches`: `[{ id: <tool_use id>, result: ToolResult }]` for results whose tool_use arrived in an earlier batch, so patch the existing `tool` row. `usage`: the **delta** for this batch only (`{input,output,cacheRead,cacheWrite,thinking}`), so add it to your total. `model`: `""` if the batch has no assistant line. `offset`: new byte offset. |
| `{"t":"ping"}` | 20 s heartbeat (no `ts`) |
| `{"t":"gone"}` | File disappeared. The server closes the stream. |
| `{"t":"error","d":"..."}` | Read error. Polling continues. |
If the file shrinks (compaction rewrite), the server silently resyncs to the new end.

Flow used by the web client (app.js:533-570): `GET /api/session` → render → `GET /api/follow` with `from = response.offset` → on reconnect use the last `events.offset`.

### `POST /api/notify` (L1577)
Body `{ title, subtitle, body }` (strings). Shows a macOS notification on the server host. → `{ "ok": true }`.

---

## 6. The desk (persistent DA session) — `/api/da/*`

One long-lived `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose` process in `$HOME` (`daBoot` L1183). Default `permissionMode` is `bypassPermissions`. State is persisted in `~/.claude/bridge/da.json`. Every message is prefixed with a `<bridge>` live-state block (`bridgeBlock` L1256).

### `DaState` (`daState` L1170)
```json
{ "alive": true, "busy": false, "sessionId": "uuid", "historyId": "uuid-or-empty",
  "started": 1760000000000, "turns": 4, "queued": 0, "error": "",
  "name": "Paquito", "model": "", "permissionMode": "bypassPermissions" }
```
`historyId` = the id whose transcript exists on disk (current, else previous, else `""`). Load history with `/api/session?key=<projectKey(home)>&id=<historyId>`.

### `GET /api/da/state` (L1599) → `DaState`

### `GET /api/da/stream?since=<seq>&replay=0|1` (L1600)
SSE. **Opening it boots the desk** if not running.
Server-broadcast frames carry `seq` (monotonic, global across clients) and `ts` (ms). They are kept in a ring of the last 600.
| frame | fields | when |
|---|---|---|
| `{"t":"hello","d":DaState,"seq":<current seq>}` | always first. No `ts`. Not in the ring. | on connect |
| (replay) | every ring frame with `seq > since` | on connect unless `replay=0` |
| `{"t":"state","d":DaState,seq,ts}` | | boot, each write, turn end, exit, error, queueing |
| `{"t":"user","d":{"text":"..."},seq,ts}` | echo of a sent message (without the `<bridge>` block), to every client | each turn start |
| `{"t":"da","d":<CLI stream-json object>,seq,ts}` | same objects as §4 `t:"msg"` (`system/init`, `stream_event`, `assistant`, `user`, `result`, ...) | while running |
| `{"t":"event","d":LiveEvent,seq,ts}` | live terminal event (§5) | whenever watchLive emits |
| `{"t":"stderr","d":"..."}` | stderr not matching `/hook\|deprecat\|warning/i` | |
| `{"t":"raw","d":"<line>"}` | non-JSON stdout | |
| `{"t":"ping"}` | no `seq`, not in ring | every 20 s |
Replay semantics (desk.js:205-213): on first open send `replay=0`, take `hello.seq` as your cursor, load history from `/api/session`. On reconnect send `since=<max seq seen>` with replay on, to get exactly what you missed (if still in the 600-frame ring). There is no "gap" signal if the ring overflowed.
A turn ends on `{t:"da", d:{type:"result"}}`, followed by `{t:"state", d:{busy:false}}`. The process stays up between turns.

### `POST /api/da/send` (L1619, `daSend` L1277)
Body `{ "text": string }`. Blank → `400 {"error":"empty"}`.
→ `{ "ok": true }` (written to stdin now) · `{ "queued": true }` (desk busy; sent after the current result) · `{ "error": "<why>" }` (could not start, e.g. `"Claude Code is not signed in"`). The reply text arrives only on `/api/da/stream`. desk.js reads `r.booting`, but the server never sends it.

### `POST /api/da/interrupt` (L1625) → `{ "ok": boolean }`. Sends SIGINT to the desk process (false if none).
### `POST /api/da/reset` (L1626, `daReset` L1289) → `DaState`. Kills the process, clears the queue, starts a **fresh** session id.
### `POST /api/da/config` (L1627)
Body `{ "permissionMode"?: string, "model"?: string }` (only string fields applied; `""` model = CLI default). Saves, then **runs `daReset`**, so changing config starts a new desk conversation. → `DaState`.

---

## 7. Voice

### `GET /api/voice/health` (L1634, `voiceHealth` L1330)
```json
{ "tts": "elevenlabs" | "kokoro" | "pulse" | "browser",
  "pulse": boolean,
  "stt": "parakeet" | "mlx" | "faster" | "whisper" | "whisper-cli" | "none",
  "local": { "stt": "<same set>", "tts": "kokoro" | "none" },
  "voice": { "voiceId": "..." } | null,
  "name": "Paquito", "user": "mrmading", "color": "#3B82F6" }
```
`tts` priority: ElevenLabs (key in env or `~/.claude/.env` and a `daidentity.voices.main.voiceId`) > local Kokoro > Pulse on :31337 > `browser` (client must synthesize itself).

### `POST /api/voice/warm` (L1635) → `{ "ok": true, "engine": stt, "stt": stt, "tts": tts }`. Starts the Python worker in the background. Call it when the mic opens.

### `POST /api/stt` (L1640)
Body = **raw audio bytes** (not multipart, not JSON). `Content-Type` picks the temp extension: contains `mp4` → .mp4, `ogg` → .ogg, `wav` → .wav, else .webm (default `audio/webm`). ffmpeg converts to 16 kHz mono PCM. Any ffmpeg-readable format works if the header roughly matches.
→ always HTTP 200: `{ "text": "...", "ms": 840 }` · `{ "text": "", "error": "too short" }` (<800 bytes) · `{ "text"?: ..., "error": "..." }` (e.g. `"no transcriber on this machine — ..."`, `"voice worker timed out after 90s"`). Cold start can take a while (model load).

### `POST /api/tts` (L1636, `ttsRespond` L1351)
Body `{ "text": string }`, trimmed and cut to 1600 chars. **Branch on the response `Content-Type`:**
| response | content-type | header `x-bridge-tts` | client action |
|---|---|---|---|
| MP3 bytes (streamed) | `audio/mpeg` | `elevenlabs` | play |
| WAV bytes | `audio/wav` | `kokoro` | play |
| `{ "played": "pulse", "chunks": n, "words": n }` | JSON | — | audio already played on the **Mac**; animate ~words/2.7 s |
| `{ "played": "none", "words": n }` | JSON | — | use on-device TTS |
| `400 { "error": "nothing to say" }` | JSON | — | empty text |
ElevenLabs settings: model `eleven_turbo_v2_5`, voice settings from `daidentity.voices.main` (defaults stability 0.35, similarity 0.8, style 0.9, speed 1.1).

---

## 8. Auth (drives the CLI's own login)

### `AuthStatus` (L804, `authStatus` L811)
`claude auth status --json` output merged with:
| field | type | notes |
|---|---|---|
| `loggedIn` | boolean | forced `true` when `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` is set |
| `authMethod`, `apiProvider`, `email`, `orgName`, `subscriptionType` | string? | from the CLI |
| `keyAuth` | boolean | env key present (logout then does nothing) |
| `cli` | boolean | CLI binary found |
| `error` | string? | status could not be read |
Cached 30 s.

### `GET /api/auth?fresh=1` (L1528) → `AuthStatus`. `fresh=1` bypasses the cache.

### `POST /api/auth/login` (L1529, `startLogin` L844)
Body `{ "mode": "claudeai" | "console", "email"?: string }`. Any mode other than `"console"` = claude.ai. Spawns `claude auth login`, waits ≤10 s for the OAuth URL.
→ `{ "url": "https://...", "mode": "<as sent>" }` · `{ "error": "<cli output tail>" }`. Open `url` in a browser. The user copies the code shown on the callback page.

### `POST /api/auth/code` (L1533, `submitCode` L877)
Body `{ "code": string }` (no whitespace, ≤400 chars). **Blocks up to 120 s** while the CLI confirms.
→ `{ "ok": true, "status": AuthStatus }` · `{ "error": "...", "restart": true, "status"?: AuthStatus }` (start login again) · `{ "error": "that doesn't look like the code — copy the whole string" }` (retry, same login).

### `POST /api/auth/cancel` (L1537) → `{ "ok": true }`. Kills the pending login process.
### `POST /api/auth/logout` (L1538, `doLogout` L898) → `{ "ok": boolean /* now signed out */, "status": AuthStatus, "out": "<cli tail ≤200>" }`. Signs out every Claude Code session on the host.

---

## 9. Files and folders (sandboxed to "roots")

All path routes go through `guard()` (L42): the absolute path must equal or sit under one of the roots in `~/.claude/bridge/roots.json`. `isSensitive()` (L47) also blocks `/.ssh/`, `/.aws/`, `/.gnupg/`, `.credentials`, `id_rsa`, `/.env`, `*.pem`, `keychain`.
Outside roots → `403 {"error":"outside your Bridge folders — add it in Files"}`.

### `GET /api/roots` (L1751) → `string[]` (abs paths).
### `POST /api/roots` body `{ "roots": string[] }` → `string[]` saved. Paths are resolved, and anything not under `$HOME` is dropped silently. Replaces the whole list.

### `GET /api/dir?path=<abs>&hidden=1` (L1725)
`path` default `$HOME`. Dotfiles hidden unless `hidden=1`. Dirs first, then by name.
```json
{ "path": "/abs", "parent": "/abs/.." | null /* null at a root */,
  "entries": [{ "name": "src", "dir": true, "size": 96, "mtime": 1760000000000 }],
  "roots": ["/abs/root", ...] }
```

### `GET /api/file?path=<abs>` (L1739) — four response shapes
| case | body |
|---|---|
| sensitive | `{ "path", "blocked": true, "text": "🔒 Blocked by Bridge — ..." }` (200) |
| missing or a dir | `404 { "error": "not a file" }` |
| image/pdf (`.png .jpg .jpeg .gif .webp .svg .pdf`) | `{ "path", "size", "binary": true, "url": "/api/raw?path=...", "ext": ".png" }` |
| >800 KB | `{ "path", "size", "text": "File too large to preview (N KB).", "lang": "text" }` |
| text | `{ "path", "size", "mtime", "lang": "<ts\|js\|md\|...\|text>", "text": "..." }` |

### `GET /api/raw?path=<abs>` (L1774) → file bytes (`Bun.file`, type inferred from extension). Blocked → `403` text `blocked`.
### `POST /api/save` (L1763) body `{ "path": string, "text": string }` (≤5,000,000 chars) → `{ "ok": true, "size", "mtime" }` · 403 outside/protected · `400 {"error":"bad payload"}`.
### `POST /api/open` (L1779) body `{ "path": string }` → `{ "ok": true }`. Runs macOS `open` on the **server host**.

---

## 10. Catalogs, routing, activity, LifeOS

### `GET /api/agents` (L1660, `collectAgents` L377)
From `~/.claude/agents`, `~/.claude/custom-agents`, `~/.claude/teams/*/agents`. Sorted by name.
`[{ name, description, color, model, tools, voice, source: "core"|"custom"|"team:<t>", path, words, category }]` (all strings except `words`: number).

### `GET /api/skills` (L1661, `collectSkills` L408)
`[{ name, description, source: "user"|"plugin:<p>", path, mtime, bytes, category }]`.

### `GET /api/instructions` (L1662, `collectInstructions` L430)
`[{ label, path, tag: "core"|"pai"|"config"|"memory"|"memory-index", bytes, mtime }]` (only files that exist). Memory dir path is hardcoded to `-Users-mrmading`.

### `GET /api/hooks` (L1663, `collectHooks` L449)
From settings.json `hooks`: `[{ event, matcher /* "*" default */, type, command, timeout }]`.

### `GET /api/configs` (L1712)
Flat list with `group` ∈ `Core` | `Memory` | `Agents` | `Skills`:
`{ group, label, path, bytes?, mtime?, desc?, sub? }`. `sub` is the agent category or skill source.

### `POST /api/route` (L1656, `routeAgent` L760)
Body `{ "prompt": string, "previous"?: string /* agent picked last turn */ }`. Local keyword/IDF scoring, no model call.
→ `{ "agent": "<name or \"\">", "score": number, "why": string, "runnerUp": string, "top3"?: string[] }`. `agent: ""` = plain Claude Code. Send the result as `agent` in `/api/chat`.

### `GET /api/activity` (L1664)
```json
{ "now": ms,
  "live": [{ "id", "cwd", "model"?, "started", "prompt", "elapsed", "title"? }],   // Bridge's own running /api/chat turns
  "summary": { "running", "turns", "done", "failed", "stopped", "spend" /* USD today */, "wall" /* ms */, "saves", "sessionsToday" },
  "log": [LogRow & { "sessionTitle"?, "sessionKey"?, "sessionPath"? }],   // newest first, ≤200, in-memory ring of 800
  "sessions": [SessionMeta & { project /* key */, projectName, projectPath }]   // touched today, ≤30
}
```
`LogRow` (L599): `{ ts, kind, msg, outcome?, session?, cwd?, cost?, ms?, model? }`. `kind` values: `turn.start|turn.done|turn.error|turn.exit|turn.stop`, `desk.start|desk.turn|desk.done|desk.error|desk.exit`, `live.started|live.ended|live.done|live.waiting|live.takeover`, `file.save`, `folders`, `session.rename`, `auth.login|auth.ok|auth.fail|auth.logout`, `voice.ready|voice.heard|voice.said|voice.error`.

### `GET /api/lifeos` (L1562)
```json
{ "versions": ["LifeOS 7.40.4", "Algorithm v8.20.2", ...],
  "dims": [{ "name": "health", "pct": 62, "tbd": 3, "updated": "..." }],
  "generated": "ISO" | null, "mtime": ms, "installed": boolean }
```

---

## Gotchas

1. **No auth, no CORS, all interfaces.** Bun binds 0.0.0.0:4270 by default. A phone client on the LAN works with no handshake. So does anyone else on that network. Flutter web would also need CORS, which the server does not send.
2. **`/api/chat` is SSE over POST.** Use a streaming HTTP client and parse `data: ` frames split on `\n\n`. The turn ends on `{t:"end"}`, not on the `result` message. `claude -p` can outlive `result` while a Workflow runs.
3. **Closing the chat HTTP stream does not cancel the turn.** Always `POST /api/abort {sessionId: start.sessionId}`.
4. **Resume can change the session id.** Read `system/init.session_id` and use it as the next `resume`. Abort still uses the `start.sessionId` of the current request.
5. **Interactive tools are unavailable in `-p` mode.** `AskUserQuestion` and `ExitPlanMode` do not work in Bridge turns. `BRIDGE_PROTOCOL` (L22) tells the model to instead end with a fenced ` ```choices ` block (2-6 option lines, render as buttons, the tap becomes the next message) and, in plan mode, a markdown heading starting with `Plan` (render a plan card; Approve resends with an edit-capable permission mode). Terminal sessions (§5) *can* be blocked on those tools. That is what `waiting` reports.
6. **`--agent` has no effect on `-p` turns** (CLI 2.1.259, comment L245). Bridge works around it with a system-prompt instruction to dispatch via the Agent tool.
7. **Project key encoding is lossy.** `key = cwd.replace(/[^A-Za-z0-9]/g, "-")`. Never decode a key back into a path. Use `path` from `/api/projects` or `cwd` from meta. `/api/search` returns `project` as a display **name**, while `/api/recent` and `/api/find` return it as the **key**.
8. **`cwd` outside the roots silently becomes `$HOME`** in `/api/chat`. Check `start.cwd`.
9. **`/api/follow` `offset` is the file size, including any partial last line** held in server memory. If you reconnect with that offset mid-line, the remainder of that line is unparseable and dropped. For a guaranteed clean resume, refetch `/api/session` and use its `offset` (complete-line boundary).
10. **Follow `usage` is per-batch.** Accumulate it. `/api/session` `meta.usage` is the full total.
11. **Desk config resets the conversation.** `/api/da/config` calls `daReset`, so it starts a new session id. The desk also boots as soon as anyone opens `/api/da/stream`.
12. **Desk replay ring is 600 frames with no overflow marker.** After a long disconnect, reload history from `/api/session` instead of trusting replay.
13. **Desk user messages on disk include the `<bridge>…</bridge>` block.** Strip it with `/<bridge>[\s\S]*?<\/bridge>\s*/g`.
14. **`idleTimeout: 255` s.** Any non-SSE request that takes longer is dropped. `/api/auth/code` can block 120 s and `/api/live/takeover` ~9 s, so set client timeouts above that. SSE routes ping every 20 s.
15. **Caching.** JSON responses send `cache-control: no-store`. SSE sends `no-cache`. Static files send `no-store`. `/api/raw` sends no cache header. Server-side caches: auth status 30 s, voice probe 120 s, Pulse health 20 s, agent route index 60 s, session meta keyed by file mtime.
16. **POST-only routes 404 on GET** rather than 405, because they fall through to the static handler.
17. **Several POSTs throw → 500 on malformed JSON** (`roots`, `save`, `open`, `rename`, `abort`, `chat`). Always send a valid JSON body with `content-type: application/json`.
18. **`/api/stt` wants raw bytes** with an audio content-type, not multipart. It returns 200 even on failure. Check `error`.
19. **`/api/tts` is polymorphic.** Branch on `Content-Type`: `audio/*` means play the bytes. JSON `played:"pulse"` means it already played on the Mac. `played:"none"` means use device TTS.
20. **Event `ts` types differ.** Transcript events carry ISO strings. SSE envelopes from the desk carry ms numbers.
