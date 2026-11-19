import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative } from "node:path";
import {
  experimental_resolveExecutablePath as resolveExecutablePath,
  sanitizeInheritedChildProcessEnv,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import { inputRecord, stringValue, type OpenCodeRecord } from "./types.ts";

type RecordValue = OpenCodeRecord;

const BB_INSTRUCTIONS_ENTRY = "bb.provider.instructions";

/**
 * Location-scoped OpenCode resources take a deep-object `location` query
 * parameter. A legacy `directory` query is silently ignored and resolves the
 * service's default location instead.
 */
export function locationQuery(cwd: string) {
  return `location[directory]=${encodeURIComponent(cwd)}`;
}

export const DYNAMIC_MCP_SERVER_PREFIX = "bb_opencode2_";

/** Per-session name of the MCP server that exposes BB dynamic tools. */
export function dynamicMcpServerName(providerThreadId: string) {
  return `${DYNAMIC_MCP_SERVER_PREFIX}${createHash("sha256").update(providerThreadId).digest("hex").slice(0, 20)}`;
}

/** OpenCode v2 adds and removes runtime MCP servers under `experimental`. */
export function dynamicMcpRegistrationRequest(
  serverName: string,
  cwd: string,
  config: RecordValue,
) {
  return {
    path: `/api/experimental/mcp/${encodeURIComponent(serverName)}?${locationQuery(cwd)}`,
    init: { method: "PUT", body: JSON.stringify({ config }) },
  };
}

export function dynamicMcpRemovalRequest(serverName: string, cwd: string) {
  return {
    path: `/api/experimental/mcp/${encodeURIComponent(serverName)}?${locationQuery(cwd)}`,
    init: { method: "DELETE" },
  };
}

/**
 * Session instruction entries are the documented beta mechanism for BB
 * instructions. The endpoint has no append/replace selector, so a BB
 * `replace` mode cannot be represented exactly. Empty instructions remove
 * the entry so a resumed session does not keep stale BB guidance.
 */
export function sessionInstructionsRequest(
  sessionId: string,
  instructions: string,
) {
  const path = `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${BB_INSTRUCTIONS_ENTRY}`;
  if (!instructions) return { path, init: { method: "DELETE" } };
  return {
    path,
    init: { method: "PUT", body: JSON.stringify({ value: instructions }) },
  };
}

export type PermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};

// OpenCode evaluates the agent ruleset and then the session ruleset, and the
// last matching rule wins. v2's `build` agent allows every action, so without
// session rules OpenCode never asks and BB's permission modes do nothing.
const ACCEPT_EDITS_ALLOWED_ACTIONS = [
  "read",
  "list",
  "grep",
  "glob",
  "codesearch",
  "lsp",
  "edit",
  "question",
  "skill",
  "todowrite",
  "todoread",
];

/**
 * Translate BB's permission mode into an OpenCode session ruleset.
 *
 * - `accept-edits` asks for everything except reads, searches, and edits.
 * - `auto` and `full` keep the agent's own rules; BB answers any remaining
 *   ask automatically (see automaticPermissionReply).
 * - BB dynamic tools are approved by BB itself, so their MCP server is
 *   always allowed instead of prompting twice.
 * - Disabled native subagents are denied outright, which OpenCode reports to
 *   the model as a tool error instead of interrupting the turn.
 */
export function sessionPermissionRules(input: {
  permissionMode?: string;
  disableSubagents: boolean;
  dynamicToolServer?: string;
  dynamicToolNames?: readonly string[];
}): PermissionRule[] {
  const rules: PermissionRule[] = [];
  if (input.permissionMode === "accept-edits") {
    rules.push({ action: "*", resource: "*", effect: "ask" });
    for (const action of ACCEPT_EDITS_ALLOWED_ACTIONS)
      rules.push({ action, resource: "*", effect: "allow" });
    // Keep OpenCode's own secret-file guard after the broad read allow.
    rules.push(
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    );
  } else if (input.permissionMode === "full") {
    rules.push({ action: "*", resource: "*", effect: "allow" });
  }
  // OpenCode registers MCP servers per directory, not per session, so every
  // OpenCode thread in a checkout sees every other thread's BB tool server.
  // Hide them all (a deny removes the tools from the model's catalog), then
  // allow this session's own server. MCP permission actions are
  // `<server>_<tool>`, and rules match globs with the last match winning.
  rules.push({
    action: `${DYNAMIC_MCP_SERVER_PREFIX}*`,
    resource: "*",
    effect: "deny",
  });
  if (input.dynamicToolServer && input.dynamicToolNames?.length)
    rules.push({
      action: `${input.dynamicToolServer}_*`,
      resource: "*",
      effect: "allow",
    });
  if (input.disableSubagents)
    rules.push(
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "task", resource: "*", effect: "deny" },
    );
  return rules;
}

export function sessionPermissionsRequest(
  sessionId: string,
  permissions: PermissionRule[],
) {
  return {
    path: `/api/session/${encodeURIComponent(sessionId)}`,
    init: { method: "PATCH", body: JSON.stringify({ permissions }) },
  };
}

export function sessionRenameRequest(sessionId: string, title: string) {
  return {
    path: `/api/session/${encodeURIComponent(sessionId)}`,
    init: { method: "PATCH", body: JSON.stringify({ title }) },
  };
}

/**
 * BB-spawned agents (e.g. Codex via its bridge child process) inherit the
 * host PATH, which BB augments with its own binary directory, so `bb` works
 * in their shells. OpenCode shells run under the shared background service
 * instead, whose environment is fixed at service start and may predate BB.
 * The session environment endpoint replaces the shell environment. Each
 * session therefore receives a credential-filtered host environment, BB's
 * explicit per-session envVars, and a PATH that includes `bb`.
 */
const SENSITIVE_ENVIRONMENT_KEY =
  /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PRIVATE_?KEY|PASSWORD|SECRET|TOKEN)(?:$|_)/i;
const SENSITIVE_ENVIRONMENT_PREFIX = /^(?:AWS|AZURE|GCP|GOOGLE|OPENCODE)_/i;

export function isSensitiveEnvironmentKey(key: string): boolean {
  return (
    SENSITIVE_ENVIRONMENT_KEY.test(key) ||
    SENSITIVE_ENVIRONMENT_PREFIX.test(key)
  );
}

export function sessionEnvironmentVariables(input: {
  hostEnv: NodeJS.ProcessEnv;
  bridgeEnvVars?: Record<string, string>;
  bbBinDir?: string;
}): Record<string, string> {
  const base = withoutBridgeRuntimeEnv(
    sanitizeInheritedChildProcessEnv({ env: input.hostEnv }),
  );
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string" && !isSensitiveEnvironmentKey(key)) {
      variables[key] = value;
    }
  }
  // BB passes these values explicitly for this provider session, so they are
  // trusted configuration rather than incidental host-process credentials.
  for (const [key, value] of Object.entries(input.bridgeEnvVars ?? {})) {
    if (typeof value === "string") variables[key] = value;
  }
  if (input.bbBinDir) {
    const entries = (variables.PATH ?? "")
      .split(delimiter)
      .filter((entry) => entry.length > 0);
    if (!entries.includes(input.bbBinDir)) entries.unshift(input.bbBinDir);
    variables.PATH = entries.join(delimiter);
  }
  return variables;
}

export function sessionEnvironmentRequest(
  sessionId: string,
  variables: Record<string, string>,
) {
  return {
    path: `/api/session/${encodeURIComponent(sessionId)}/environment`,
    init: { method: "PUT", body: JSON.stringify({ variables }) },
  };
}

export async function resolveBbBinDir(): Promise<string | undefined> {
  try {
    const executable = await resolveExecutablePath("bb");
    return executable ? dirname(executable) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * BB rewind retains *through* a provider checkpoint, while OpenCode's fork
 * and revert APIs take a *before* boundary (exclude the given message).
 * Checkpoints are user message IDs, and a turn is user + following assistant
 * messages. To retain through checkpoint C, fork/revert before the next *user*
 * message after C. When C is already the last user turn, forking through the
 * tip (or no revert) keeps everything.
 */
export type CheckpointMessage = { id: string; type?: string };

function messageIdList(
  messages: readonly CheckpointMessage[] | readonly string[],
): string[] {
  return messages.map((entry) =>
    typeof entry === "string" ? entry : entry.id,
  );
}

/**
 * A user prompt starts a turn. So does a synthetic message (a background
 * shell's or subagent's report) that woke an idle session; one delivered while
 * the session was busy joined the turn already running.
 */
function startsTurn(types: readonly (string | undefined)[], index: number) {
  return (
    types[index] === "user" ||
    (types[index] === "synthetic" && types[index - 1] === "idle")
  );
}

export function nextMessageIdAfterCheckpoint(
  messages: readonly CheckpointMessage[] | readonly string[],
  checkpointId: string,
): string | undefined {
  const ids = messageIdList(messages);
  const types =
    Array.isArray(messages) &&
    messages.length > 0 &&
    typeof messages[0] !== "string"
      ? (messages as readonly CheckpointMessage[]).map((entry) => entry.type)
      : undefined;
  const index = ids.indexOf(checkpointId);
  if (index === -1) return undefined;
  // When types are known, skip to the next message that starts a turn so the
  // retained turn keeps its assistant reply.
  if (types) {
    for (let i = index + 1; i < ids.length; i++) {
      if (startsTurn(types, i)) return ids[i];
    }
    return undefined;
  }
  return index + 1 < ids.length ? ids[index + 1] : undefined;
}

/**
 * Body for `POST /api/session/{id}/fork`. OpenCode copies every message
 * before `before`, or the whole session when it is omitted. (Unknown keys are
 * stripped, so a wrong field silently forks the tip.)
 */
export function forkBoundaryRetainingThrough(
  messages: readonly CheckpointMessage[] | readonly string[],
  checkpointId?: string,
): { before?: string } {
  if (!checkpointId) return {};
  const ids = messageIdList(messages);
  const next = nextMessageIdAfterCheckpoint(messages, checkpointId);
  // Unknown checkpoint: fall back to a before-boundary on the given ID so
  // OpenCode surfaces MessageNotFound instead of silently forking the tip.
  if (next === undefined && !ids.includes(checkpointId)) {
    return { before: checkpointId };
  }
  if (next === undefined) return {};
  return { before: next };
}

export function steerAcceptedDelta(
  clientRequestId: string,
  providerTurnId: string,
): RecordValue {
  return { kind: "input.accepted", clientRequestId, providerTurnId };
}

export function revertTargetRetainingThrough(
  messages: readonly CheckpointMessage[] | readonly string[],
  checkpointId: string,
): string | undefined {
  const ids = messageIdList(messages);
  const next = nextMessageIdAfterCheckpoint(messages, checkpointId);
  // Unknown checkpoint: fall back to the given ID (before-semantics) so the
  // server error is explicit. Tip checkpoint: nothing to truncate.
  if (next === undefined) {
    return ids.includes(checkpointId) ? undefined : checkpointId;
  }
  return next;
}

/**
 * Skill roots for BB's composer, derived from the SKILL.md files OpenCode
 * discovered: each skill lives at `<root>/<name>/SKILL.md`. Built-in skills
 * (no file on disk) are skipped; roots inside the workspace are `project`.
 */
export function nativeSkillRoots(
  skills: readonly { path?: string }[],
  cwd: string | null,
) {
  const roots = new Map<string, "project" | "user">();
  for (const skill of skills) {
    if (!skill.path || !isAbsolute(skill.path)) continue;
    if (basename(skill.path) !== "SKILL.md") continue;
    const root = dirname(dirname(skill.path));
    if (!existsSync(root)) continue;
    const inWorkspace =
      cwd !== null && (root === cwd || !relative(cwd, root).startsWith(".."));
    roots.set(root, inWorkspace ? "project" : "user");
  }
  return [...roots].map(([path, origin]) => ({
    path,
    origin,
    shape: "skills" as const,
  }));
}

/**
 * OpenCode answers a failed request with a tagged JSON error such as
 * `{_tag: "SessionNotFoundError", message}`. Since 2.3.1 a server crash is
 * `{_tag: "UnknownError", message, ref}`, where `ref` locates the entry in the
 * OpenCode server log. Show the message instead of the raw body; the status
 * stays first, since callers retry on 409.
 */
export function apiErrorMessage(status: number, body: string): string {
  let detail = body.trim();
  try {
    const error = inputRecord(JSON.parse(body));
    const message = stringValue(error.message);
    const ref = stringValue(error.ref);
    if (message) detail = ref ? `${message} (server log ref ${ref})` : message;
  } catch {
    // Not JSON: keep the body as it is.
  }
  return `OpenCode API ${status}${detail ? `: ${detail}` : ""}`;
}
