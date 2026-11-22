import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { OpenCodeServer } from "./support/host-api.js";

test("launches the OpenCode CLI from PATH", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "opencode launch & "));
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  });
  const script = join(dir, "fake.mjs");
  await writeFile(script, 'console.log(process.argv.slice(2).join(" "));');
  await writeFile(
    join(dir, process.platform === "win32" ? "opencode2.cmd" : "opencode2"),
    process.platform === "win32"
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = [dir, previousPath].filter(Boolean).join(delimiter);
  const server = new OpenCodeServer() as unknown as {
    cli(args: string[]): Promise<string>;
  };
  assert.equal(
    (await server.cli(["service", "start"])).trim(),
    "service start",
  );
  assert.equal((await server.cli(["pair"])).trim(), "pair");
});

test("follows checkpoint cursors even when a page is shorter than the requested limit", async () => {
  const paths: string[] = [];
  const server = new OpenCodeServer();
  server.request = async (path: string) => {
    paths.push(path);
    return paths.length === 1
      ? { data: [{ id: "msg-1", type: "user" }], cursor: { next: "next" } }
      : { data: [{ id: "msg-2", type: "assistant" }], cursor: {} };
  };

  assert.deepEqual(await server.listSessionMessageIds("session"), [
    { id: "msg-1", type: "user" },
    { id: "msg-2", type: "assistant" },
  ]);
  assert.match(paths[1], /limit=200/);
  assert.match(paths[1], /cursor=next/);
  assert.doesNotMatch(paths[1], /order=/);
});

test("persists the BB thread session mapping for stateless rewinds", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "opencode2-sessions-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const server = new OpenCodeServer();
  server.setDataDir(dataDir);
  await server.rememberSessionRegistration("bb-thread", {
    providerThreadId: "ses_123",
    cwd: "/repo",
    usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
  });
  assert.deepEqual(await server.lookupSessionRegistration("bb-thread"), {
    providerThreadId: "ses_123",
    cwd: "/repo",
    usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
  });

  // A fresh server over the same data dir still resolves the mapping, so a
  // restarted worker can tell an in-place rewind from a true fork.
  const restarted = new OpenCodeServer();
  restarted.setDataDir(dataDir);
  assert.equal(
    (await restarted.lookupSessionRegistration("bb-thread"))?.providerThreadId,
    "ses_123",
  );
  await restarted.forgetSessionRegistration("bb-thread");
  assert.equal(
    await restarted.lookupSessionRegistration("bb-thread"),
    undefined,
  );
});

test("serializes MCP registry mutations without dropping persisted entries", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "opencode2-registry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, "opencode2-mcp-registry.json");
  await writeFile(
    path,
    JSON.stringify({
      existing: { serverName: "bb_existing", cwd: "/existing" },
    }),
  );

  const server = new OpenCodeServer();
  server.setDataDir(dataDir);
  await Promise.all([
    server.rememberMcpRegistration("session-a", {
      serverName: "bb_a",
      cwd: "/a",
    }),
    server.rememberMcpRegistration("session-b", {
      serverName: "bb_b",
      cwd: "/b",
    }),
    server.rememberMcpRegistration("session-c", {
      serverName: "bb_c",
      cwd: "/c",
    }),
  ]);

  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(stored, {
    existing: { serverName: "bb_existing", cwd: "/existing" },
    "session-a": { serverName: "bb_a", cwd: "/a" },
    "session-b": { serverName: "bb_b", cwd: "/b" },
    "session-c": { serverName: "bb_c", cwd: "/c" },
  });

  await Promise.all([
    server.forgetMcpRegistration("session-a"),
    server.forgetMcpRegistration("session-b"),
  ]);
  const remaining = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(remaining, {
    existing: { serverName: "bb_existing", cwd: "/existing" },
    "session-c": { serverName: "bb_c", cwd: "/c" },
  });
});

test("tells listeners which workspace's agents changed", async () => {
  const server = new OpenCodeServer();
  const directories: string[] = [];
  const unsubscribe = server.onAgentsUpdated((directory: string) =>
    directories.push(directory),
  );
  await server.handleEvent({
    type: "agent.updated",
    location: { directory: "/repo" },
    data: {},
  });
  await server.handleEvent({ type: "agent.updated", data: {} });
  await server.handleEvent({
    type: "model.updated",
    location: { directory: "/repo" },
    data: {},
  });
  unsubscribe();
  await server.handleEvent({
    type: "agent.updated",
    location: { directory: "/other" },
    data: {},
  });
  assert.deepEqual(directories, ["/repo"]);
});
