/* Bridge at the edge: the desktop client at /, the Flutter phone client at /m/, and /api/* streamed
 * through to the sprite (BACKEND_URL). The Worker holds no secrets and does no auth: the sprite checks
 * the Supabase token on every /api call, so this is a pipe, not a gate. */

interface Env {
  ASSETS: Fetcher;
  BACKEND_URL: string;
}

// never sent upstream: Cloudflare's own hop headers, and a Host the sprite would reject
const DROP_UP = ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cf-worker", "x-forwarded-proto", "x-real-ip"];

async function proxy(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.BACKEND_URL) return Response.json({ error: "backend not configured" }, { status: 503 });
  const target = new URL(url.pathname + url.search, env.BACKEND_URL);
  const headers = new Headers(req.headers);
  for (const h of DROP_UP) headers.delete(h);
  headers.set("x-forwarded-for", req.headers.get("cf-connecting-ip") || "");
  headers.set("x-forwarded-host", url.host);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let up: Response;
  try {
    // the body streams up as it arrives, the response streams down untouched: SSE flows byte for byte
    up = await fetch(target, { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: "manual" });
  } catch (e) {
    return Response.json({ error: "backend unreachable", detail: String(e) }, { status: 502 });
  }
  const out = new Headers(up.headers);
  if ((out.get("content-type") || "").includes("text/event-stream")) {
    out.set("cache-control", "no-cache, no-transform");
    out.delete("content-length");
  }
  return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });
}

function withCache(res: Response, value: string): Response {
  const r = new Response(res.body, res);
  r.headers.set("cache-control", value);
  return r;
}

async function asset(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  if (p === "/m") return Response.redirect(new URL("/m/" + url.search, url).toString(), 301);
  if (p.startsWith("/m/")) {
    let res = await env.ASSETS.fetch(req);
    const rel = p.slice(3);
    // a deep link in the Flutter app (no extension) gets its shell
    if (res.status === 404 && !rel.includes(".")) {
      res = await env.ASSETS.fetch(new Request(new URL("/m/", url), req));
      return withCache(res, "no-store");
    }
    const fresh = rel === "" || rel === "index.html" || rel.endsWith(".js");
    return res.ok ? withCache(res, fresh ? "no-store" : "public, max-age=3600") : res;
  }
  if (p === "/favicon.ico") return new Response(null, { status: 204 });
  const res = await env.ASSETS.fetch(req);
  if (!res.ok) return res;
  const r = withCache(res, "no-store");
  if (p.endsWith(".webmanifest")) r.headers.set("content-type", "application/manifest+json");
  return r;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    // the Qwen route is the sprite's own business, never reachable from the internet
    if (p === "/qwen" || p.startsWith("/qwen/") || p === "/api/qwen" || p.startsWith("/api/qwen/")) return new Response("Not found", { status: 404 });
    if (p === "/api" || p.startsWith("/api/")) return proxy(req, env, url);
    return asset(req, env, url);
  },
} satisfies ExportedHandler<Env>;
