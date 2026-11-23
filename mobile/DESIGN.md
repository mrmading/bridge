# Bridge Mobile — design

A phone client for a Bridge server (your Mac, or a Fly sprite). It follows the friendly-UX
prototype (`docs/friendly-ux-prototype.html`): Bridge is where every chat starts, so the phone is
not a terminal mirror. It is the Claude iOS app in Bridge's visual language: a drawer of chats,
a Home that tells you what needs you and what is working, and chats that read as outcomes, not
tool logs.

## Principles

1. **One thumb.** The composer, send, stop, Answer and the drawer edge are all in thumb reach.
2. **Outcomes first, mechanics on demand.** A turn is one "Worked for 6m · read 14 files · ran 3
   commands" line, the prose, and cards for the files it made. Raw tool calls, thinking and hooks
   appear only with Settings › Advanced › Show technical details.
3. **Long work is visible and leaveable.** Running chats pulse in the drawer with a live timer,
   show on Home with their current step and jobs, and inside the chat as a job card ("You can
   leave, I'll notify you") plus a "N running in the background" tray above the composer.
   When a run ends while you are elsewhere, a snackbar says so with an Open action.
4. **Plain words for power settings.** Permission modes are freedom levels: Plan first (`plan`),
   Ask before changes (`manual`), Edit freely (`acceptEdits`, the default), Autopilot
   (`bypassPermissions`). Model + effort and the teammate (agent) sit in bottom sheets.
5. **Native voice.** Talk is a full-screen overlay over the server's desk session: on-device
   speech to text, server TTS (Kokoro/ElevenLabs) or on-device TTS, hands-free toggle.
6. **Works on the web too.** Same app served by the Bridge server at `/m/` (same origin, no CORS).

## Information architecture

```
Onboarding ─ server URL (prefilled with the page origin at /m/) → connect
Drawer (burger or edge swipe):
  BRIDGE mark · [New chat]
  Search · Home · Inbox (badge = needs you) · Projects · Files · Agents & skills
  WORKING NOW   needs-you chats (amber pulse) · running chats (blue pulse + live elapsed)
  TODAY / YESTERDAY / THIS WEEK / EARLIER   other chats
  footer: avatar · name · plan · theme toggle · Settings
Root views (behind the drawer, burger + Talk pill in the bar):
  Home       orb (tap = Talk) · greeting · catch-up line · composer (project picker, runs-on)
             · suggestion chips · Needs you (Answer) · Working now (step, timer, job chips)
             · Recently made for you (file tiles) · Jump back in (projects)
  New chat   "What should we work on?" · composer · recent projects as chips
  Chat       see below
  Inbox      All / Needs you / Working / Done
  Projects   search · project rows (chats, needs, live dot)
  Files      describe-to-find search (/api/find) · Made for you (by kind) · Browse folders
  Agents     team cards with Give a task · skills with Use (/skill prefilled)
Pushed screens: Project page (New chat here · Instructions CLAUDE.md · Automations hooks · Chats
  · Files) · File preview (markdown, code, images; raw open) · Folder browser · Search · Settings
Overlay: Talk (orb, captions, hold/tap to talk, keyboard ↔ text, hands-free, end)
```

### Chat
- App bar: burger · project icon · title (or the first message) · project (or "Working · …") ·
  Talk · Files & progress · ⋯ (Rename, Browse project folder, Copy chat id, Stop all running work).
- Stream: user bubbles; each assistant turn = name · work line (live: spinner + timer) · prose ·
  decision card for ```choices (numbered buttons) · file cards (Write = new, Edit = edited) ·
  cost/time footer. Background-task notifications fold into the turn as one check line.
- Live: opening a running chat re-attaches through `/api/follow` from the transcript offset;
  `/api/jobs` is polled every 3 s for running/step/jobs. Messages sent while anything runs are
  queued and go when it ends.
- Composer: text · teammate · freedom · model+effort · dictation mic · send / stop.
- Files & progress (bottom sheet): Files touched · Progress (latest TodoWrite) · Details (teammate,
  model, freedom, folder, computer, tokens, chat id, Show technical details).

### Settings
General (appearance, Claude account sign-in/out) · Voice (speak replies, hands-free, engine) ·
Defaults for new messages (teammate, freedom, model) · Computers (this computer, server URL, test,
forget) · Advanced (technical details, global CLAUDE.md, folders Bridge can see) · the assistant's
desk (mode, model, reset) · About.

## Visual language

- Dark first. Tokens mirror the desktop client (lib/core/theme.dart): bg `#080a0f`, raised
  `#11141b`, accent `#4aa8ff`, accent2 `#7fd0ff`, ok `#4ecf95`, warn `#e3a955`, err `#ff7b72`,
  think `#b79cf5`. Light theme uses the desktop light tokens.
- Brand: black tile with an Orbitron "B" glowing in the accent; BRIDGE wordmark in Orbitron
  (bundled, SIL OFL, `assets/fonts`).
- Accent bloom from the top of Home and New chat. Cards radius 14, composer 18, chips round.
- Status colours: blue pulse = working, amber pulse = needs you, green check = done.
- Motion: orb breathes; dots pulse; step text slides in; one shared 1 s clock ticks every timer.

## Data flow

`BridgeApi` (lib/core/api.dart) is the only place that knows URLs. `AppStore` holds server config,
bootstrap, auth, recent chats, projects, agents and `home` (`/api/home`: running, needs, made,
projects), polled every 5 s in the foreground (recent every 20 s). On a server without
`/api/home` the store derives running/needs from `/api/recent` flags. `Nav` (lib/core/nav.dart)
owns the root view, the open chat and pushes, so the drawer, Home, Inbox and Search open things
the same way.

## Removed

Terminal mirroring (`/api/live`), "Take over" and session sync. Every chat starts in Bridge.

## Running it

- Simulator against a local server: `BRIDGE_PORT=4291 bun server.ts` (repo root), then
  `flutter build ios --simulator --debug --dart-define=BRIDGE_SERVER=http://localhost:4291` and
  `xcrun simctl install booted build/ios/iphonesimulator/Runner.app`
  (or `flutter run --dart-define=BRIDGE_SERVER=…`).
- Web: `flutter build web --base-href /m/ --release --no-web-resources-cdn --pwa-strategy=none`;
  the server serves it at `/m/`.
- Tests: `flutter test` (never `pumpAndSettle`: the orb and timers animate forever).
