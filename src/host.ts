import { join } from "node:path";
import {
  experimental_defineHostEntry,
  experimental_filterResolvedNativeRoots,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import {
  modelSummarySchema,
  opencodeHostContract,
} from "./settings-contract.ts";
import {
  installationStatus,
  MIN_OPENCODE_VERSION,
  OPENCODE_LOGIN_COMMAND,
  providerHealth,
} from "./host/maintenance.ts";
import { syncBbToolsRule } from "./host/opencode-config.ts";
import { openCodeServer } from "./host/opencode-server.ts";
import { shutdownBridge } from "./host/provider-bridge.ts";
import { nativeSkillRoots } from "./host/opencode-requests.ts";
import { sessions } from "./host/types.ts";

export { createDynamicToolCallRouter } from "./host/bridge-runtime.ts";
export {
  DYNAMIC_TOOLS_MCP_ARG,
  handleDynamicToolsMcpRequest,
  startDynamicToolsMcpProxy,
} from "./host/dynamic-tools-mcp.ts";
export {
  agentSessionOption,
  assertModelEnabled,
  mapModel,
  modelCatalogEntry,
  resolveModelVariant,
  modelRefFromOptions,
  modelSwitchRequest,
  sameModelRef,
  turnModelRef,
} from "./host/models.ts";
export {
  OpenCodeServer,
  parseOpenCodeServiceUrl,
} from "./host/opencode-server.ts";
export {
  OpenCodeEventRouter,
  shellExitCode,
  usageDeltas,
} from "./host/opencode-event-router.ts";
export {
  askableFields,
  bbQuestion,
  formReply,
} from "./host/opencode-interactions.ts";
export {
  dynamicMcpRegistrationRequest,
  dynamicMcpRemovalRequest,
  forkBoundaryRetainingThrough,
  isSensitiveEnvironmentKey,
  nativeSkillRoots,
  nextMessageIdAfterCheckpoint,
  revertTargetRetainingThrough,
  sessionEnvironmentRequest,
  sessionEnvironmentVariables,
  sessionInstructionsRequest,
  sessionPermissionRules,
  sessionPermissionsRequest,
  sessionRenameRequest,
  steerAcceptedDelta,
} from "./host/opencode-requests.ts";
export {
  approvalPermissionReply,
  automaticPermissionReply,
  enabledDynamicTools,
  permissionReplyBody,
  promptBody,
  sameDynamicTools,
  SUBAGENT_DISABLED_TOOL_ERROR,
  subagentDisabledToolError,
  toolFailureError,
} from "./host/prompt.ts";
export {
  addBbToolsRule,
  removeBbToolsRule,
  syncBbToolsRule,
} from "./host/opencode-config.ts";
export { experimental_providerBridge } from "./host/provider-bridge.ts";
export { sessionFromParams } from "./host/session-manager.ts";
export { sessions } from "./host/types.ts";
export {
  boundedTimelineDelta,
  boundedTimelineText,
  isManualCompactionTurn,
  itemKeyForOpenItem,
  manualCompactionOutcomeDeltas,
  manualCompactionRequest,
  manualCompactionStartDeltas,
  MAX_TIMELINE_DELTA_BYTES,
  providerFailureDeltas,
  timelineDeltasForEmission,
} from "./host/timeline.ts";
export {
  dynamicToolRow,
  metadataFileChanges,
  toolRow,
  touchedPaths,
  workspacePath,
} from "./host/tool-mapping.ts";

export default experimental_defineHostEntry({
  contract: {
    ...opencodeHostContract,
    ...experimental_nativeRootsHostContract,
  },
  handlers: {
    // BB lists these directories in the composer for OpenCode threads, so
    // skills OpenCode found on its own (~/.agents/skills, ~/.claude/skills,
    // project and config roots) can be invoked with /name.
    async resolveNativeRoots(input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      const skills = await openCodeServer.nativeSkills(
        input.cwd ?? process.cwd(),
      );
      return experimental_filterResolvedNativeRoots(
        { skills: nativeSkillRoots(skills, input.cwd), commands: [] },
        {
          warn: (message) => process.stderr.write(`[opencode2] ${message}\n`),
        },
      ).answer;
    },
    async listModels(input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      const catalog = await openCodeServer.modelCatalog(
        input.cwd ?? process.cwd(),
        true,
      );
      return {
        models: catalog.models.map((model) => {
          const id = `${model.providerID}/${model.id}`;
          return modelSummarySchema.parse({
            id,
            providerId: model.providerID,
            displayName: typeof model.name === "string" ? model.name : id,
            ...(id === catalog.defaultId ? { isDefault: true } : {}),
          });
        }),
      };
    },
    async getStatus(_input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      const cwd = process.cwd();
      // Report OpenCode itself even while the BB provider is switched off.
      const [health, installation] = await Promise.all([
        providerHealth(
          {
            ...(await openCodeServer.readModelSettings()),
            providerEnabled: true,
          },
          cwd,
        ),
        installationStatus(true),
      ]);
      const modelCount = await openCodeServer
        .modelCatalog(cwd)
        .then((catalog) => catalog.models.length)
        .catch(() => 0);
      return {
        status: health.status === "expired" ? "unauthenticated" : health.status,
        statusMessage: health.statusMessage,
        installedVersion: health.installedVersion,
        latestVersion: installation.latestVersion,
        minimumSupportedVersion: MIN_OPENCODE_VERSION,
        loginCommand: OPENCODE_LOGIN_COMMAND,
        modelCount: health.status === "ready" ? modelCount : 0,
      };
    },
    async setModelSettings(input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      await openCodeServer.writeModelSettings(input);
      // Best-effort: a config we cannot edit only leaves BB tools visible
      // to OpenCode's own sessions, where calling them is refused anyway.
      await syncBbToolsRule(
        input.hideBbToolsOutsideBb !== false,
        undefined,
        join(context.experimental_paths.dataDir, "opencode2-config-edit.json"),
      )
        .then((result) => {
          if (result !== "unchanged") openCodeServer.reloadConfigWhenIdle();
        })
        .catch((error) =>
          process.stderr.write(
            `[opencode2] Could not update OpenCode's global config: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
        );
      for (const session of sessions.values()) {
        session.disableSubagents = input.disableSubagents !== false;
        session.enabledModels =
          input.enabledModels === null ? null : new Set(input.enabledModels);
      }
      return { ok: true as const };
    },
  },
  dispose: async () => {
    await shutdownBridge("OpenCode host worker disposed");
  },
});
