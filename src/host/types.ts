import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import type { DynamicToolsMcpProxy } from "./dynamic-tools-mcp.ts";

/**
 * OpenCode's beta API does not publish a complete event schema. Keep its
 * untyped payloads behind this adapter type and normalize fields before they
 * reach BB protocol objects.
 */
export type OpenCodeRecord = Record<string, any>;

export type OpenCodePermissionMode = "accept-edits" | "auto" | "full";
export type OpenCodePermissionReply = "once" | "always" | "reject";

export type ModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};

export type ActiveTurn = {
  providerTurnId: string;
  startedAt: number;
  /** Set once OpenCode accepted the prompt; reconciliation waits for it. */
  promptDelivered?: boolean;
  /** Message IDs of this turn's prompts (the first and any steers). */
  promptIds?: Set<string>;
  /**
   * Set when OpenCode starts working on one of this turn's prompts. Terminal
   * execution events before that belong to earlier work (for example a
   * compaction still finishing) and must not end this turn.
   */
  inputDelivered?: boolean;
  abortController: AbortController;
  manualCompaction?: { itemId: string };
  checkpointId?: string;
  opened: Map<string, OpenCodeRecord>;
  pendingTools: Map<string, string>;
  pendingInput: Map<string, string>;
  touchedFiles: Map<string, string[]>;
  openQuestions: Map<string, string>;
  settledTools: Set<string>;
  /** Tool calls already closed, so a repeated terminal event is ignored. */
  finishedTools?: Set<string>;
  /** Patches of every file change this turn, for `turn.diff`. */
  turnPatches?: string[];
  /** Live shell output pollers by tool call ID. */
  shellPolls?: Map<string, { stopped: boolean }>;
  /** Token counts of the latest finished step, for `usage.last`. */
  lastStepTokens?: OpenCodeRecord;
};

export type SessionState = {
  bbThreadId: string;
  providerThreadId: string;
  cwd: string;
  permissionMode?: OpenCodePermissionMode;
  /** Serialized ruleset last sent to OpenCode, to skip redundant PATCHes. */
  appliedPermissions?: string;
  disableSubagents: boolean;
  nativeSkillNames?: Set<string>;
  dynamicTools: DynamicTool[];
  disallowedTools: Set<string>;
  enabledModels: ReadonlySet<string> | null;
  instructions: string;
  bridgeEnvVars: Record<string, string>;
  dynamicToolScope: object;
  dynamicToolProxy?: DynamicToolsMcpProxy;
  active?: ActiveTurn;
  model?: ModelRef;
  /** The current model's context limit, from OpenCode's model catalog. */
  contextWindow?: number | null;
  /** OpenCode agent the session is currently on. */
  agent?: string;
  /** The agent chosen through BB's `agent` session option, kept across turns. */
  agentChoice?: string;
  /** Last session-options state published to BB, to skip repeats. */
  publishedAgentOptions?: string;
  usage: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export const sessions = new Map<string, SessionState>();
export const sessionsByProviderId = new Map<string, SessionState>();

export function isSubagentTool(name: string): boolean {
  const tool = name.toLowerCase();
  return tool === "task" || tool === "subagent";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parsePermissionMode(
  value: unknown,
): OpenCodePermissionMode | undefined {
  const mode = stringValue(value);
  return mode === "accept-edits" || mode === "auto" || mode === "full"
    ? mode
    : undefined;
}

export function inputRecord(value: unknown): OpenCodeRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as OpenCodeRecord)
    : {};
}

export function firstInputString(
  input: OpenCodeRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

export function parseInputText(text: unknown): OpenCodeRecord {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return inputRecord(JSON.parse(text));
  } catch {
    return {};
  }
}
