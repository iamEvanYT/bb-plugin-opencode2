// BB provider registration for OpenCode v2.
//
// The host bridge talks to OpenCode's local v2 HTTP API. This file only owns
// provider metadata and keeps process/API details out of the BB server runtime.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  opencodeHostContract,
  opencodeSettingsRpcContract,
  type HostStatus,
  type ModelSummary,
} from "./settings-contract.ts";
import { normalizeModelSettings } from "./model-settings.ts";

const PROVIDER_ID = "opencode2";
const SETTINGS_KEY = "model-settings";

export default async function plugin(bb: BbPluginApi) {
  let modelSettings = normalizeModelSettings(
    await bb.storage.kv.get(SETTINGS_KEY),
  );
  const host = bb.hosts.experimental_client({ contract: opencodeHostContract });
  const syncedSettings = new Map<string, string>();

  async function connectedHostIds(signal?: AbortSignal) {
    return (await bb.sdk.hosts.list({ signal }))
      .filter((item) => item.status === "connected")
      .map((item) => item.id);
  }

  async function syncSettings(hostIds?: string[], signal?: AbortSignal) {
    const connected = hostIds ?? (await connectedHostIds(signal));
    const revision = JSON.stringify(modelSettings);
    const targets = connected.filter(
      (hostId) => syncedSettings.get(hostId) !== revision,
    );
    const results = await Promise.allSettled(
      targets.map((hostId) => {
        const call = host.call("setModelSettings", modelSettings, {
          hostId,
          signal,
        });
        if (!signal) return call;
        return new Promise((resolve, reject) => {
          const aborted = () =>
            reject(signal.reason ?? new Error("Settings sync aborted"));
          if (signal.aborted) {
            aborted();
            return;
          }
          signal.addEventListener("abort", aborted, { once: true });
          call.then(resolve, reject).finally(() => {
            signal.removeEventListener("abort", aborted);
          });
        });
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        syncedSettings.set(targets[index], revision);
      }
    });
    for (const hostId of syncedSettings.keys()) {
      if (!connected.includes(hostId)) syncedSettings.delete(hostId);
    }
    if (
      !signal?.aborted &&
      results.some((result) => result.status === "rejected")
    ) {
      bb.log.warn(
        "Could not sync OpenCode model settings to every connected host",
      );
    }
  }

  async function listModels() {
    const hostIds = await connectedHostIds();
    await syncSettings(hostIds);
    const results = await Promise.allSettled(
      hostIds.map((hostId) => host.call("listModels", {}, { hostId })),
    );
    const models = new Map<string, ModelSummary>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const model of result.value.models) models.set(model.id, model);
    }
    return {
      models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async function getStatus() {
    const hosts = (await bb.sdk.hosts.list()).filter(
      (item) => item.status === "connected",
    );
    const results = await Promise.all(
      hosts.map(async (item): Promise<HostStatus> => {
        try {
          return {
            hostId: item.id,
            hostName: item.name,
            status: await host.call("getStatus", {}, { hostId: item.id }),
          };
        } catch (error) {
          return {
            hostId: item.id,
            hostName: item.name,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { hosts: results };
  }

  bb.rpc.register(opencodeSettingsRpcContract, {
    getSettings: () => modelSettings,
    listModels,
    getStatus,
    async saveSettings(next) {
      modelSettings = normalizeModelSettings(next);
      await bb.storage.kv.set(SETTINGS_KEY, modelSettings);
      await syncSettings();
      bb.realtime.publish("settings-changed", modelSettings);
      return modelSettings;
    },
  });

  bb.background.service("sync-model-settings", {
    async start(signal) {
      while (!signal.aborted) {
        await syncSettings(undefined, signal);
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            signal.removeEventListener("abort", stop);
            resolve();
          }, 5_000);
          signal.addEventListener("abort", stop, { once: true });
        });
      }
    },
  });

  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "OpenCode v2",
    icon: "./icons/opencode.svg",
    strings: {
      signInHint:
        "Run `opencode2 auth login` on this machine to connect a model provider.",
      expiredHint:
        "An OpenCode model provider needs to be reconnected. Run `opencode2 auth login`, then reload.",
      installUrl: "https://opencode.ai/v2/docs/",
      brandPrefix: "OpenCode ",
      iconTint: { light: "#18181B", dark: "#FAFAFA" },
    },
    // Only show the provider when `opencode2` is installed on the target machine.
    experimental_visibility: "installed",
    maintenance: { health: true, usage: false, installation: true },
    models: { scope: "workspace" },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: true,
      fork: "checkpoint",
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ],
    },
    // BB's plan mode is not offered; `plan` is an OpenCode agent picked through
    // the `agent` session option instead.
    composerActions: [],
    // OpenCode discovers skills in more places than BB scans by default;
    // the host entry answers with the roots OpenCode actually uses.
    experimental_resolvesNativeRoots: true,
    // Settings reach every session and turn command as providerOptions, so a
    // change applies on the next turn without waiting for the host sync.
    deriveProviderOptions: () => ({ modelSettings }),
  });

  bb.log.info("registered OpenCode v2 provider");
}
