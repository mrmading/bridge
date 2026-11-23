# Remote Mac: the Computer panel on the local hub (design note, not built)

Status: proposal. Nothing here is implemented. The cloud version ships in `desktop.ts` and `public/computer.html`.

## Problem

On the sprite, the agent has a virtual screen that nobody is using, so it can act freely while the user watches.
A Mac is different. The screen is a real one, a person is often sitting at it, and macOS guards it with two
permissions (Screen Recording and Accessibility) that Bridge, a `bun` process started from a terminal, should not hold.
The goal is the same panel: watch the Mac from the phone or a browser and take control, plus let the agent act on
it. A remote session should never start without the person at the Mac agreeing to it.

## Shape

```
 phone / browser ──wss──▶ Worker ──▶ Bridge on the Mac (server.ts, :4270)
                                          │  /api/desktop/ws: same route, same RFB filter, same gate
                                          ▼
                                   Bridge Screen.app  (native helper, signed, LaunchAgent)
                                   · ScreenCaptureKit → frames
                                   · CGEvent → keys / pointer
                                   · VNC server on a unix socket (or 127.0.0.1)
```

- **A native helper, not Bridge.** A small signed Swift app (`Bridge Screen.app`) holds the two TCC permissions
  under its own bundle id. Bridge never gets them, and neither does Terminal or `bun`. The helper starts at login
  (LaunchAgent) and listens only on a unix socket in `~/.claude/bridge/` (mode 600), or on 127.0.0.1 with a per-boot key.
- **Same wire as the cloud.** The helper speaks RFB: frames from ScreenCaptureKit, encoded as tight/JPEG
  rects, and input injected with `CGEventPost`. So `desktop.ts`'s WebSocket bridge, its RFB input filter and
  `computer.html` work unchanged, and the Mac becomes one more `Desktop` backend. The open question is
  whether to write the RFB encoder or embed libvncserver. Embedding libvncserver is less code.
- **The agent's tools.** On the Mac, `desktop-mcp.ts` calls the helper (`screenshot`, `click`, `type`, `key`, `scroll`)
  over the same socket instead of xdotool. Browser work should use a separate Chrome profile driven over CDP,
  as on the sprite, never the person's own logged-in Chrome without asking.

## Consent: confirm on the Mac

1. A remote viewer opening `/api/desktop/ws` to the Mac makes Bridge ask the helper for a session. The helper
   shows a native alert on the Mac: "Nestor's phone wants to watch this Mac. [Allow for this session] [Deny]".
   It names the device, from the Supabase session's email plus the user agent. Nothing streams until someone
   clicks Allow at the Mac. If nobody answers in 30 seconds, the answer is deny.
2. "Take control" is a second, separate confirmation on the Mac, because watching and acting are different grants.
3. An agent turn that wants the screen tools asks the same way ("Claude wants to use this Mac's screen for this
   chat"). It is allowed per chat and ends when the turn ends.
4. A grant is kept for the session only, in the helper's memory. It is never written to disk and never "always allow".
   A setting can relax this to a per-device allowlist later, and that change itself needs a click at the Mac.
5. With nobody at the Mac (screen locked or the user idle), there is nobody to confirm, so the answer is deny. Unattended
   remote control is out of scope until there is a real need and a second factor.

## Visible indicator

- While any viewer is connected, the helper shows a menu-bar item with a red dot, "Bridge: being watched by
  <device>", and a floating pill at the top centre of every display. These are separate from macOS's own
  purple screen-recording indicator, which also shows.
- While control is remote, the pill turns amber: "Remote control: <device>". It has a Stop button that ends
  the session at once. Pressing Esc three times, or any local mouse movement, also hands control back, so the
  person at the Mac always wins.
- The agent acting is shown the same way ("Claude is using this Mac"), with the same Stop button.

## Security notes

- The helper accepts connections only from Bridge (the socket's file mode, or the per-boot key). The internet
  reaches it only through Bridge's gate, which checks the Supabase token and the email allowlist, and then
  through the on-Mac confirmation.
- Frames are not recorded or stored. The helper ignores clipboard sync unless control is granted.
- Sensitive windows such as 1Password or the login window are excluded with ScreenCaptureKit's window filter, using a
  bundle-id denylist in the helper's settings.
- macOS shows its own prompts for the two TCC grants the first time, once per helper install. Bridge's setup
  should open the right System Settings pane and explain why. It never scripts the grant.

## Open questions

- Should the helper live in the Bridge Desktop app (`mac/`), if that becomes the shipped Mac client, rather
  than as a separate bundle?
- What frame rate and quality fit a phone on cellular: adaptive JPEG quality from ScreenCaptureKit, or H.264
  through VideoToolbox, which noVNC 1.7 can decode?
- How should a multi-display Mac work: one display at a time with a picker in `computer.html`?
