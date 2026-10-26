import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../src/server.ts";

test("registers OpenCode v2 as an installed checkpoint-capable provider with every BB permission mode", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
  });

  await plugin(bb);

  const provider = harness.inspection.registrations.providerRegistrations.find(
    (registration) => registration.id === "opencode2",
  );
  assert.ok(provider);
  assert.equal(provider.displayName, "OpenCode v2");
  assert.equal(provider.experimental_visibility, "installed");
  assert.equal(provider.capabilities.fork, "checkpoint");
  assert.equal(provider.capabilities.supportsManualCompaction, true);
  assert.equal(provider.capabilities.supportsThreadRename, true);
  assert.deepEqual(provider.capabilities.permissionModes, [
    "accept-edits",
    "auto",
    "full",
  ]);
  assert.deepEqual(harness.experimental_hostRpcCalls, []);
  assert.deepEqual(provider.capabilities.reasoningLevels, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
});

test("aborts a pending settings sync when the background service stops", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => [{ id: "host-a", status: "connected" }],
      },
    },
    experimental_callHostRpc: async () => new Promise(() => {}),
  });
  await plugin(bb);

  const service = harness.runService("sync-model-settings");
  await new Promise((resolve) => setImmediate(resolve));
  service.controller.abort();
  await Promise.race([
    service.done,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("settings sync did not abort")), 100),
    ),
  ]);
});

test("synchronizes settings when each host connects", async () => {
  let connected = [{ id: "host-a", status: "connected" }];
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => connected,
      },
    },
    experimental_callHostRpc: async () => ({ ok: true }),
  });
  await plugin(bb);

  const firstRun = harness.runService("sync-model-settings");
  await new Promise((resolve) => setImmediate(resolve));
  firstRun.controller.abort();
  await firstRun.done;
  assert.deepEqual(
    harness.experimental_hostRpcCalls.map((call) => call.hostId),
    ["host-a"],
  );

  connected = [
    { id: "host-a", status: "connected" },
    { id: "host-b", status: "connected" },
  ];
  const secondRun = harness.runService("sync-model-settings");
  await new Promise((resolve) => setImmediate(resolve));
  secondRun.controller.abort();
  await secondRun.done;
  assert.deepEqual(
    harness.experimental_hostRpcCalls.map((call) => call.hostId),
    ["host-a", "host-b"],
  );
});
