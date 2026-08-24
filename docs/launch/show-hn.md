# Show HN — draft

Post to https://news.ycombinator.com/submit as a **URL post** (not text).
Tuesday–Thursday, **6–9am Pacific**. Then post the first comment immediately and stay in the thread
for three hours.

---

## URL

```
https://github.com/mrmading/bridge
```

The repo, not the landing page. HN trusts a repo more, and the README is the pitch.

## Title

```
Show HN: Bridge – a desktop client for Claude Code that searches every past session
```

76 characters, under the 80 limit. It states what it is, not why it is good, so a moderator has no
reason to rewrite it.

**Alternates, if the first reads long:**

```
Show HN: Bridge – a Mac client for Claude Code with search over every transcript
Show HN: I built a desktop client for Claude Code that greps all my old sessions
```

**Do not use:** "the best", "finally", "beautiful", "supercharge", or any question form. And never
ask anyone to upvote it, anywhere, including privately. That is the one thing that reliably kills a
launch.

---

## First comment — post immediately, as a top-level comment

> Hey HN, Nestor here, I built this.
>
> Backstory: I use Claude Code all day and kept losing work in it. Not losing files, losing
> *context* — I knew I had fixed a Cloudflare deploy bug some Tuesday three weeks earlier, and the
> only way back to it was `claude --resume` and arrow keys through a list of AI-generated titles.
> Meanwhile `~/.claude/projects` had 600 MB of JSONL transcripts sitting on disk that nothing could
> search. Bridge started as a grep over that directory and turned into the window I now work in.
>
> Under the hood, the decision that shaped everything: **it does not reimplement Claude Code.**
> Every turn shells out to the real CLI with
> `claude -p --output-format stream-json --include-partial-messages --session-id|--resume`, and the
> stdout is piped to the browser over SSE. So hooks, skills, MCP servers, permission modes and your
> `settings.json` env all behave exactly as they do in the terminal, and a session started in
> Bridge is an ordinary session you can pick up with `claude --resume`. The cost of that choice is
> real: I get no access to the agent loop, I cannot render anything the stream does not emit, and I
> inherit every CLI flag change. The alternative was the Agent SDK, which would have given me
> control and cost me the entire existing ecosystem, plus a second thing to keep in sync. Not worth
> it for a client.
>
> Two other bits that were more interesting than expected. **Search:** ripgrep ships inside the
> `claude` binary, so invoking it with `argv0: "rg"` gives you rg without a dependency; one pass per
> term in parallel, then rank on how many of your terms a session actually covers rather than raw
> hit count, which is the difference between finding the right session and finding the longest one.
> ~350 ms over 626 MB. **Transcript parsing:** the JSONL is an append-only event log, not a
> conversation, so tool results have to be re-joined to their `tool_use_id`, usage de-duplicated by
> `requestId`, and sub-agent turns separated by `isSidechain`, or your token counts are wrong by 3x.
>
> Known limitations, and they are real:
>
> - **macOS only.** The server is portable Bun and the UI is a web page, so Linux works today if you
>   run `bun server.ts` and open localhost. Only the native shell is Mac-specific. Windows is
>   untested.
> - **Not notarised yet**, so the .dmg needs one trip through System Settings → Privacy & Security.
>   Building from source avoids that entirely.
> - **No sandbox.** File access is confined to folders you explicitly add, and credential-shaped
>   paths are refused inside them, but Claude Code itself does whatever you permit it to do. This is
>   a client, not a safety layer.
> - **v0.1, one user.** It has been in daily use by exactly me. Expect rough edges and tell me about
>   them.
> - It is a local web view in a native window, not AppKit. If that offends you, this is the wrong
>   tool and I understand.
>
> Happy to go deep on the stream-json protocol, the transcript format, the ripgrep scoring, or why
> the native shell has to spawn Bun through a login shell (a Finder-launched app inherits dead std
> streams and Bun wedges in `openat` before it ever listens — that one cost me an hour).

---

## Answers to have ready

**"You could just do this with a shell script / fzf over the JSONL."**
Agree, genuinely, and be specific about where it stops. You can absolutely `rg` the transcripts. What
you cannot easily do is re-join tool results to their calls, de-duplicate usage by request, and rank
on term coverage rather than hit count. Before this, my own grep kept surfacing the *longest*
session rather than the right one. Everything above the search is the part I wanted, not the part I
needed.

**"Why not just use the terminal?"**
For a single conversation the terminal is better and I still use it. This is for the other thing:
five sessions in flight, and eighteen months of them behind you.

**"Anthropic will ship this."**
Probably, and it is 2,000 lines of MIT code that reads a directory. If the official one is better I
will use the official one.

**"Is my data going anywhere?"**
No. No telemetry, no analytics, no account, localhost-only bind. That is also why I cannot tell you
how many people use it.

**"Electron?"**
No. `swiftc` and a `WKWebView`, 128 KB of Swift. The whole .dmg is 1.4 MB.

---

## Thread discipline

- Reply to **every** substantive comment for the first three hours.
- Concede real points immediately and specifically. Defending an indefensible point is read by
  thousands of people.
- Never mention votes, never argue about downvotes.
- Do not sell. The README sells. In the thread you are an engineer talking about a thing you made.
- If someone finds a bug, fix it during the thread and say so. Nothing converts an HN reader faster.

## Before you post

- [ ] Notarised .dmg on the release, so the first thing a visitor does is not fight Gatekeeper
- [ ] README has a screenshot or GIF above the fold — of ⌘F finding an old session
- [ ] `bun server.ts` verified on a clean machine
- [ ] The landing page can take a spike (it is GitHub Pages, so it can)
- [ ] Three hours clear in the calendar after posting
