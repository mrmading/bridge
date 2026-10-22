# Deploying Bridge: Cloudflare Worker in front, Fly sprite behind, Supabase magic link

```
 browser / phone
      │  https://bridge.thepadelsociety.workers.dev
      ▼
 Cloudflare Worker `bridge`  (deploy/worker)
   /            desktop client (public/)              static, no-store
   /m/          Flutter web build (mobile/build/web)  static, SPA fallback, no-store on index.html + .js
   /api/*       streamed to BACKEND_URL as-is (SSE both ways, Authorization + query string kept)
   /qwen*, /api/qwen*   404, never exposed
      │
      ▼
 Fly sprite `bridge` (org nestor-280)  https://bridge-x2x6.sprites.app
   service `bridge` = ~/bridge/run.sh → sources ~/.bridge.env (600) → bun server.ts on :8080
   every /api call checks the Supabase access token + BRIDGE_ALLOWED_EMAILS
      │
      ▼
 Supabase `bridge-dev` (tozuyautmztgolnzgwvg): auth only, email magic link / 6-digit code
```

The Worker holds no secrets and does no auth. The gate is in the sprite's server. So the sprite URL
stays behind Fly's login (`--url-auth sprite`) until that gate has been proven on the sprite.

## Commands

| What | Command |
|---|---|
| Assemble assets (public/ + mobile/build/web → worker/dist) | `deploy/build.sh` (`BUILD_FLUTTER=1` rebuilds Flutter first) |
| Deploy the Worker | `deploy/deploy.sh` (extra args go to `wrangler deploy`, e.g. `--dry-run`) |
| Local Worker against a local Bridge | `cd deploy/worker && wrangler dev --port 8811 --var BACKEND_URL:http://localhost:4293` |
| Push auth config to Supabase | `deploy/supabase/auth.sh [ref]` (`SITE_URL=` to change the site URL) |
| Ship a commit + Flutter build + env to the sprite, restart, health-check | `deploy/sprite.sh [commit]` (`SKIP_WEB=1` keeps the sprite's Flutter build) |
| Health check only | `deploy/sprite.sh --check` (passes only if `/api/authconfig` has `required:true` and `/api/home` without a token is 401) |
| Make the sprite URL public (ONLY after `--check` passes) | `sprite config update -o nestor-280 -s bridge --url-auth public` |
| Worker logs | `cd deploy/worker && wrangler tail` |

`deploy/sprite.sh` writes `~/.bridge.env` on the sprite (mode 600) with `BRIDGE_SUPABASE_URL`,
`BRIDGE_SUPABASE_KEY` (publishable key), `BRIDGE_ALLOWED_EMAILS`, `RUNPOD_QWEN_ENDPOINT` and
`RUNPOD_QWEN_API_KEY`. The key is read by name from `~/.claude/.env` and sent over stdin: it never
appears in argv, logs or output. The script also installs `deploy/sprite-run.sh` as `~/bridge/run.sh`
so the service sources that file. It ships committed work only: uncommitted changes stay local.

## Supabase auth (bridge-dev)

- Site URL `https://bridge.thepadelsociety.workers.dev`. Redirect allow-list: the site URL, the site URL + `/**`,
  `http://localhost:4290/**`, `http://localhost:4291/**`.
- Email sign-in on, signups on (the sprite's allowlist decides who gets in), confirmations off,
  OTP **6 digits**, 1 h expiry, 60 s between emails to the same address.
- Magic-link and confirmation emails use `supabase/templates/magic_link.html`, subject "Your Bridge sign-in link".
  The email carries the link and the 6-digit code: a Home Screen web app on iOS opens links in Safari,
  not in itself, so the phone app should accept the typed code (`verifyOtp({ email, token, type: "email" })`).
- **Email delivery uses Supabase's built-in SMTP.** It sends only to the org's team members and is
  rate-limited to a few emails an hour, project-wide. Verified 2026-10-23: a sign-in email to
  nestor@thepadelsociety.co was delivered to the inbox. Anyone else needs custom SMTP
  (Resend, `[auth.email.smtp]` in `auth.sh`) before they can sign in.

## Rollback

1. Close the sprite: `sprite config update -o nestor-280 -s bridge --url-auth sprite`. This alone shuts the internet out.
2. Worker: `cd deploy/worker && wrangler deployments list`, then `wrangler rollback <version-id>`
   (or `wrangler delete` to take it down).
3. Sprite code: `deploy/sprite.sh <previous-commit>`; or on the sprite `rm ~/.bridge.env` and restart to drop the env.
4. Supabase: re-run `deploy/supabase/auth.sh` after editing it; the project holds no data but auth users.

## Notes

- SSE: the Worker passes the upstream body through untouched and sets `cache-control: no-cache, no-transform`.
  The server pings every 20 s, so long turns (20+ min) never sit idle on the wire.
  Verified locally: a haiku `/api/chat` turn streamed frame by frame through the Worker, with the same arrival profile as direct.
  A 65 s `/api/follow` showed pings at 20/40/60 s.
- The compatibility date is held at 2026-08-15 because the local wrangler (4.123) cannot run newer dates in `wrangler dev`.
