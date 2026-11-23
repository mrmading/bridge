import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorStore, mask, slugify, envName } from "./store.ts";

let dir = "";
let store: ConnectorStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-conn-"));
  store = new ConnectorStore(dir);
  await store.load();
});

describe("secrets", () => {
  test("mask shows only a hint of the secret", () => {
    expect(mask("tok_fixture_0123456789xyz")).toBe("tok_…9xyz");
    expect(mask("short")).toBe("••••");
    expect(mask("")).toBe("");
  });

  test("tokens live in secrets.json, mode 600, and never in connectors.json or the public view", async () => {
    const c = await store.add({ catalogId: "github" });
    await store.setToken(c.id, "tok_fixture_SECRETSECRET_1234");
    const pub = JSON.stringify(store.publicList());
    expect(pub).not.toContain("SECRETSECRET");
    expect(pub).toContain("tok_…1234");
    const st = statSync(join(dir, "secrets.json"));
    expect(st.mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "connectors.json"), "utf8")).not.toContain("SECRET");
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toContain("SECRETSECRET");
  });

  test("disconnect forgets the secret", async () => {
    const c = await store.add({ catalogId: "linear" });
    await store.setToken(c.id, "lin_api_abcdefghijkl");
    await store.disconnect(c.id);
    expect(store.secret(c.id)).toBeUndefined();
    expect(store.get(c.id)!.status).toBe("needs-auth");
  });
});

describe("own OAuth app", () => {
  test("is kept across sign-in and sign-out, and never shown back", async () => {
    const c = await store.add({ catalogId: "slack", auth: "oauth" });
    await store.setClient(c.id, { id: "123.456", secret: "app_secret_fixture_XYZ" });
    await store.setOAuth(c.id, { access_token: "tok_fixture_OAUTH0000", client_id: "123.456", client_secret: "app_secret_fixture_XYZ", token_endpoint: "https://slack.com/api/oauth.v2.user.access" });
    expect(store.secret(c.id)?.client?.id).toBe("123.456");
    const pub = JSON.stringify(store.publicList());
    expect(pub).not.toContain("app_secret_fixture");
    expect(store.view(store.get(c.id)!).ownApp).toBe(true);
    await store.disconnect(c.id);
    expect(store.has(c.id)).toBe(false);
    expect(store.secret(c.id)?.client?.secret).toBe("app_secret_fixture_XYZ");
    await store.setToken(c.id, "tok_fixture_TOKEN1111");
    expect(store.secret(c.id)?.client?.id).toBe("123.456");
  });
});

describe("adding", () => {
  test("a catalog entry carries the vendor URL and its params", async () => {
    const c = await store.add({ catalogId: "supabase", params: { project_ref: "abc", read_only: "true" } });
    expect(c.id).toBe("supabase");
    expect(c.url).toBe("https://mcp.supabase.com/mcp?project_ref=abc&read_only=true");
    const again = await store.add({ catalogId: "supabase" });
    expect(again.id).toBe("supabase-2");
  });

  test("a custom URL must be http(s)", async () => {
    await expect(store.add({ name: "x", url: "file:///etc/passwd" })).rejects.toThrow();
    const c = await store.add({ name: "My Server", url: "https://example.com/mcp" });
    expect(c.id).toBe("my-server");
    expect(c.kind).toBe("remote");
  });

  test("slug and env names are safe", () => {
    expect(slugify("Hello, World!! API")).toBe("hello-world-api");
    expect(envName("my-api")).toBe("BRIDGE_CONN_MY_API");
  });
});

describe("turn config", () => {
  test("enabled connectors become --mcp-config entries whose secrets are env references", async () => {
    const gh = await store.add({ catalogId: "github" });
    await store.setToken(gh.id, "tok_fixture_TOPSECRET99");
    const dw = await store.add({ catalogId: "deepwiki" });
    const t = await store.turnConfig({ sessionId: "s1", cwd: "/w" });
    expect(t).not.toBeNull();
    const file = readFileSync(t!.file, "utf8");
    expect(file).not.toContain("TOPSECRET");
    const cfg = JSON.parse(file).mcpServers;
    expect(cfg.github).toEqual({ type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${BRIDGE_CONN_GITHUB}" } });
    expect(cfg.deepwiki).toEqual({ type: "http", url: "https://mcp.deepwiki.com/mcp" });
    expect(t!.env.BRIDGE_CONN_GITHUB).toBe("tok_fixture_TOPSECRET99");
    expect(t!.allowed).toEqual(["mcp__github", "mcp__deepwiki"]);
    expect(dw.enabled).toBe(true);
  });

  test("a connector that still needs a token is left out", async () => {
    await store.add({ catalogId: "linear", auth: "token" });
    expect(await store.turnConfig({ sessionId: "s", cwd: "/w" })).toBeNull();
  });

  test("a token the server refused is left out until it is replaced", async () => {
    const gh = await store.add({ catalogId: "github" });
    await store.setToken(gh.id, "tok_fixture_REFUSED000000");
    await store.update(gh.id, { status: "needs-auth" });
    expect(await store.turnConfig({ sessionId: "s", cwd: "/w" })).toBeNull();
    await store.setToken(gh.id, "tok_fixture_NEWONE00000000");
    expect((await store.turnConfig({ sessionId: "s", cwd: "/w" }))!.names).toEqual(["github"]);
  });

  test("folder and chat switches override the default, chat wins", async () => {
    const dw = await store.add({ catalogId: "deepwiki" });
    await store.setScope("folder", "/w", dw.id, false);
    expect(await store.turnConfig({ sessionId: "s", cwd: "/w" })).toBeNull();
    expect(await store.turnConfig({ sessionId: "s", cwd: "/w/sub" })).toBeNull();
    expect(await store.turnConfig({ sessionId: "s", cwd: "/other" })).not.toBeNull();
    await store.setScope("chat", "s", dw.id, true);
    expect((await store.turnConfig({ sessionId: "s", cwd: "/w" }))!.names).toEqual(["deepwiki"]);
    await store.setScope("chat", "s", dw.id, null);
    expect(await store.turnConfig({ sessionId: "s", cwd: "/w" })).toBeNull();
  });

  test("a local connector runs its server.ts with bun and gets its token through env", async () => {
    const c = await store.add({ name: "Placeholder", local: { mode: "api", baseUrl: "https://jsonplaceholder.typicode.com", authKind: "bearer" } });
    await store.setToken(c.id, "abc123secret");
    const t = await store.turnConfig({ sessionId: "s", cwd: "/w" });
    const cfg = JSON.parse(readFileSync(t!.file, "utf8")).mcpServers.placeholder;
    expect(cfg.type).toBe("stdio");
    expect(cfg.args[0]).toBe(join(dir, "placeholder", "server.ts"));
    expect(cfg.env).toEqual({ API_BASE_URL: "https://jsonplaceholder.typicode.com", API_AUTH: "bearer", API_AUTH_NAME: "", API_TOKEN: "${BRIDGE_CONN_PLACEHOLDER}" });
    expect(t!.env.BRIDGE_CONN_PLACEHOLDER).toBe("abc123secret");
    expect(existsSync(join(dir, "placeholder", "server.ts"))).toBe(true);
  });

  test("an explicit list from the request wins over every switch", async () => {
    await store.add({ catalogId: "deepwiki" });
    await store.add({ catalogId: "context7" });
    expect((await store.turnConfig({ sessionId: "s", cwd: "/w", only: ["context7"] }))!.names).toEqual(["context7"]);
    expect(await store.turnConfig({ sessionId: "s", cwd: "/w", only: [] })).toBeNull();
  });
});
