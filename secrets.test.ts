import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecrets, mask, parseEnv } from "./secrets.ts";

async function fresh() {
  const d = await mkdtemp(join(tmpdir(), "secrets-"));
  const globalFile = join(d, ".env");
  return { d, globalFile, s: createSecrets({ globalFile, dataDir: join(d, "data") }) };
}

test("global: upserts into .env, keeps other lines, file is 600, list shows only a hint", async () => {
  const { globalFile, s } = await fresh();
  await writeFile(globalFile, "# mine\nOTHER=1\nAPI_TOKEN=old\n");
  await s.set("API_TOKEN", "abcd1234efgh5678", "global", "");
  await s.set("NEW_KEY", "with space and \"quote\"", "global", "");
  const text = await readFile(globalFile, "utf8");
  expect(text).toContain("# mine\nOTHER=1\nAPI_TOKEN=abcd1234efgh5678\n");
  expect(parseEnv(text).NEW_KEY).toBe('with space and "quote"');
  expect((await stat(globalFile)).mode & 0o777).toBe(0o600);
  const l = await s.list();
  expect(l.find((x) => x.name === "API_TOKEN")!.hint).toBe("abcd…5678");
  expect(JSON.stringify(l)).not.toContain("abcd1234efgh5678");
});

test("project: stored outside the repo, applies to the folder and below, deepest wins", async () => {
  const { d, s } = await fresh();
  await s.set("SHARED", "global-value", "global", "");
  await s.set("SHARED", "proj-value-123456", "project", "/work/app");
  await s.set("SHARED", "deep-value-123456", "project", "/work/app/sub");
  expect((await s.envFor("/work/app/src")).SHARED).toBe("proj-value-123456");
  expect((await s.envFor("/work/app/sub/x")).SHARED).toBe("deep-value-123456");
  expect((await s.envFor("/work/other")).SHARED).toBe("global-value");
  expect((await s.envFor("/work/application")).SHARED).toBe("global-value");   // a sibling with the same prefix is not inside
  expect((await stat(join(d, "data", "secrets", "projects.json"))).mode & 0o777).toBe(0o600);
  await s.remove("SHARED", "project", "/work/app");
  expect((await s.envFor("/work/app/src")).SHARED).toBe("global-value");
});

test("rejects bad names and multi-line values", async () => {
  const { s } = await fresh();
  await expect(s.set("lower", "x", "global", "")).rejects.toThrow();
  await expect(s.set("OK_NAME", "a\nb", "global", "")).rejects.toThrow();
  await expect(s.set("OK_NAME", "x", "project", "")).rejects.toThrow();
  expect(mask("short")).toBe("•••••");
});
