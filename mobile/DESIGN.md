# Bridge Mobile — design

A phone client for a Bridge server (your Mac, or a Fly sprite). It is not the desktop UI squeezed
down: a phone is for talking to your assistant, watching sessions, and answering the one that is
waiting on you. Everything else is a tap away, not on screen.

## Principles

1. **One thumb.** Every primary action sits in the bottom 40 % of the screen: tabs, composer,
   mic, send, approve. Nothing you need often is in the top bar.
2. **Voice first on the home tab.** The assistant tab opens on the orb with a hold-to-talk button.
   Text is one tap away and never required.
3. **Sessions are the unit of work.** A session is a card with a status; tapping it opens the
   stream. "Waiting on you" sessions always float to the top and badge the tab.
4. **Tool activity is a summary, not a transcript.** Tool calls render as one-line cards (icon,
   name, what it touched, ok/err). Expanding one is optional. Thinking is collapsed by default.
5. **Native everything.** Speech-to-text and text-to-speech run on the device
   (`speech_to_text`, `flutter_tts`), so a server with no transcriber still works. The server's
   voice is used when it has one.
6. **Works on the web too.** Same app served by the Bridge server at `/m/`, same origin, so no
   CORS and the sprite URL is already a phone app. Native iOS/Android builds use the same code.

## Information architecture

```
Onboarding ─ server URL (prefilled with the page origin on web) → test → sign in to Claude
Tabs (bottom):
  ◉ Assistant   orb · captions · hold-to-talk · keyboard · updates sheet
  ▤ Sessions    Waiting on you / Running / Recent · search · + new session
  ▭ Projects    roots and folders · recent sessions per folder · start here
  ⚙ Settings    server · account · voice · appearance · about
Session screen (push):
  app bar: title · status pill · ⋯ (rename, open folder, stop)
  stream: user bubbles, assistant prose (markdown), tool cards, thinking (collapsed), phase chips
  composer: text · mic · send · tune (model, mode, effort, agent) as a bottom sheet
```

## Visual language

- Dark first. Tokens mirror the desktop client: bg `#080a0f`, raised `#11141b`, border `#1d222c`,
  fg `#e9edf4`, muted `#98a3b4`, accent `#4aa8ff`, accent2 `#7fd0ff`, ok `#4ecf95`,
  warn `#e3a955`, err `#ff7b72`, think `#b79cf5`. Light theme uses the desktop light tokens.
- Type: the platform font (SF on iOS). Sizes 17 body, 15 secondary, 13 meta, 11 chips.
- Radius 14 for cards and the composer, 20 for chips, full round for the mic and orb.
- Motion: the orb breathes when idle, pulses with mic level when listening, shimmers when
  thinking, swells when speaking. Lists use 180 ms fades. No parallax, no bounce.
- Safe areas respected everywhere; the composer sits on the keyboard, never under it.

## Screens in detail

### Assistant (home)
- Top: assistant name and a state line (`ready`, `listening`, `thinking`, `speaking`, `offline`).
- Centre: the orb (220 pt). Under it, the last exchange as two caption lines (you / assistant),
  fading in and out.
- Bottom: a 72 pt round mic button (hold to talk; release sends), a keyboard button that swaps
  the orb for a chat list with a text composer, and an "updates" button that opens a bottom
  sheet listing what sessions did recently.
- Voice: on-device STT via `speech_to_text`. If the server reports a voice (`/api/voice/health`
  tts != none) the reply audio comes from `/api/tts`; otherwise `flutter_tts` speaks it.
- The DA stream (`/api/da/stream`) is an SSE subscription kept open while the tab is visible.

### Sessions
- Three groups: **Waiting on you** (red dot, tap opens with the composer focused), **Running**
  (green dot, live elapsed), **Recent** (last 40 across projects, grouped by day).
- Search field filters by title, project and last message.
- `+` opens "New session": pick a folder (recent roots first), optional first message, go.

### Session
- App bar title is the session name; subtitle is the project folder. Status pill at the right.
- Stream auto-follows the bottom; a "↓ new" chip appears when you scroll up and something lands.
- Message kinds: user (right-aligned bubble), assistant (left, markdown), tool card
  (collapsed: icon + name + argument summary + badge), thinking (one-line, expandable),
  hook/system lines (small mono text), phase strip (chips) when LifeOS phase data is present.
- Composer: multiline field, mic (tap to start, tap to stop; transcript lands in the field),
  send. A "tune" icon opens a sheet with model, mode, effort and agent segmented controls.
- Running turn: send becomes stop. Messages sent while running are queued and shown as such.

### Projects
- Roots from `/api/roots`, each expandable to its folders (`/api/dir`). Tap a folder to see its
  sessions or start one there.

### Settings
- Server: URL field, test button (hits `/api/bootstrap`), shows assistant name and version.
- Account: sign-in state from `/api/auth`; sign in runs the claude.ai flow (opens link, paste code).
- Voice: speak replies (on/off), hands-free (auto-listen after reply), voice engine shown.
- Appearance: system / dark / light.

## Data flow

`BridgeApi` (lib/core/api.dart) is the only place that knows URLs. It exposes typed calls plus an
SSE helper. `AppStore` (ChangeNotifier) holds server config, bootstrap, auth, live sessions
(polled every 5 s while the app is foregrounded) and the DA state. Screens read the store and
call the API; nothing talks to `http` directly.
