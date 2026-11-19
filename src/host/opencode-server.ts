import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { withoutBridgeRuntimeEnv } from "@get-bb/plugin-sdk/provider-bridge";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeModelSettings,
} from "../model-settings.ts";
import type { ModelSettings } from "../settings-contract.ts";
import { modelCatalogEntry, type ModelCatalogEntry } from "./models.ts";
import {
  forkBoundaryRetainingThrough,
  locationQuery,
  revertTargetRetainingThrough,
  type CheckpointMessage,
} from "./opencode-requests.ts";
import { OpenCodeEventRouter } from "./opencode-event-router.ts";
import { writeJsonFileAtomic } from "./persistence.ts";
import {
  errorMessage,
  inputRecord,
  stringValue,
  sessions,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

const SETTINGS_FILE = "opencode2-model-settings.json";
const MCP_REGISTRY_FILE = "opencode2-mcp-registry.json";
const SESSION_REGISTRY_FILE = "opencode2-session-registry.json";

const MODEL_CATALOG_TTL_MS = 60_000;
const MCP_CONNECT_TIMEOUT_MS = 10_000;
const MCP_CONNECT_POLL_MS = 150;
const MCP_SETTLE_MS = 1_000;
const CONFIG_RELOAD_RETRY_MS = 30_000;
// Give up after a day of continuous activity; a service restart applies it.
const CONFIG_RELOAD_MAX_ATTEMPTS = 2_880;
const RECONCILE_INTERVAL_MS = 30_000;
const RECONCILE_MIN_TURN_AGE_MS = 10_000;
const RECONCILE_SETTLE_MS = 5_000;
const MODEL_CATALOG_COLD_RETRIES = 10;
const MODEL_CATALOG_COLD_RETRY_MS = 300;

export type OpenCodeModelCatalog = {
  models: RecordValue[];
  defaultId?: string;
  entries: Map<string, ModelCatalogEntry>;
};

export type McpBridgeRegistration = { serverName: string; cwd: string };

// Persisted so an in-place rewind (BB reuses the same BB thread ID) still
// works when the host worker holding the live session is gone: after a worker
// restart, or when another worker owns the thread, thread/fork carries no
// in-memory session and would otherwise fall through to the fork path and
// copy the session instead of truncating it.
export type SessionBridgeRegistration = {
  providerThreadId: string;
  cwd: string;
  usage: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export function parseOpenCodeServiceUrl(output: string): string {
  const token = output.trim().split(/\s+/)[0];
  if (!token) {
    throw new Error("`opencode2 service start` did not report a server URL");
  }

  let url: URL;
  try {
    url = new URL(token);
  } catch {
    throw new Error("`opencode2 service start` reported an invalid server URL");
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error("OpenCode service must use an HTTP loopback URL");
  }
  if (url.username || url.password) {
    throw new Error("OpenCode service URL must not contain credentials");
  }
  return url.origin;
}

export class OpenCodeServer {
  private baseUrl?: string;
  private password?: string;
  private starting?: Promise<void>;
  private dataDir?: string;
  private eventAbortController?: AbortController;
  private watchdog?: ReturnType<typeof setInterval>;
  private connectionGeneration = 0;
  private readonly eventRouter = new OpenCodeEventRouter((path, init) =>
    this.request(path, init),
  );

  setDataDir(dataDir: string) {
    this.dataDir = dataDir;
  }

  private settingsPath() {
    return this.dataDir ? join(this.dataDir, SETTINGS_FILE) : undefined;
  }

  /**
   * Plugin settings reach session and turn commands as `providerOptions`
   * (see `deriveProviderOptions` in server.ts), which is always current.
   * Sessionless maintenance requests (`model/list`, `provider/health`) carry
   * only static options, so they read the copy the host RPC worker keeps in
   * its own data directory, a sibling of the bridge's.
   */
  async readModelSettings(providerOptions?: unknown): Promise<ModelSettings> {
    const derived = inputRecord(providerOptions).modelSettings;
    if (derived !== undefined) return normalizeModelSettings(derived);
    if (!this.dataDir) return DEFAULT_MODEL_SETTINGS;
    for (const path of [
      join(this.dataDir, SETTINGS_FILE),
      join(dirname(this.dataDir), "host-data", SETTINGS_FILE),
    ]) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return normalizeModelSettings(parsed);
      } catch {
        // Try the next location.
      }
    }
    return DEFAULT_MODEL_SETTINGS;
  }

  async writeModelSettings(settings: ModelSettings) {
    const path = this.settingsPath();
    if (!path) throw new Error("OpenCode host data directory is unavailable");
    await writeJsonFileAtomic(path, settings);
  }

  // Tracks per-session MCP bridges so discard can remove OpenCode's
  // registration even when this worker holds no session state (another host
  // worker owns the thread, or this worker restarted since setup). Entries
  // persist to the host data dir; a failed DELETE keeps its entry for retry.
  private mcpRegistry = new Map<string, McpBridgeRegistration>();
  private mcpRegistryLoaded = false;
  private mcpRegistryOperation: Promise<void> = Promise.resolve();

  private mcpRegistryPath() {
    return this.dataDir ? join(this.dataDir, MCP_REGISTRY_FILE) : undefined;
  }

  private async withMcpRegistryLock<T>(operation: () => Promise<T>) {
    const result = this.mcpRegistryOperation.then(operation, operation);
    this.mcpRegistryOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadMcpRegistry() {
    if (this.mcpRegistryLoaded) return;
    this.mcpRegistryLoaded = true;
    const path = this.mcpRegistryPath();
    if (!path) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          const record = value as Record<string, unknown> | null;
          if (
            record &&
            typeof record.serverName === "string" &&
            typeof record.cwd === "string"
          ) {
            this.mcpRegistry.set(key, {
              serverName: record.serverName,
              cwd: record.cwd,
            });
          }
        }
      }
    } catch {
      // Missing or corrupt registry: treat as empty and rebuild from here.
    }
  }

  async rememberMcpRegistration(
    providerThreadId: string,
    entry: McpBridgeRegistration,
  ) {
    await this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      const previous = this.mcpRegistry.get(providerThreadId);
      this.mcpRegistry.set(providerThreadId, entry);
      try {
        await this.writeMcpRegistry();
      } catch (error) {
        if (previous) this.mcpRegistry.set(providerThreadId, previous);
        else this.mcpRegistry.delete(providerThreadId);
        throw error;
      }
    });
  }

  async forgetMcpRegistration(providerThreadId: string) {
    await this.forgetMcpRegistrations([providerThreadId]);
  }

  async forgetMcpRegistrations(providerThreadIds: readonly string[]) {
    await this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      const previous = new Map<string, McpBridgeRegistration>();
      for (const providerThreadId of providerThreadIds) {
        const entry = this.mcpRegistry.get(providerThreadId);
        if (entry) previous.set(providerThreadId, entry);
        this.mcpRegistry.delete(providerThreadId);
      }
      try {
        await this.writeMcpRegistry();
      } catch (error) {
        for (const [providerThreadId, entry] of previous) {
          this.mcpRegistry.set(providerThreadId, entry);
        }
        throw error;
      }
    });
  }

  async lookupMcpRegistration(
    providerThreadId: string,
  ): Promise<McpBridgeRegistration | undefined> {
    return this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      return this.mcpRegistry.get(providerThreadId);
    });
  }

  private async writeMcpRegistry() {
    const path = this.mcpRegistryPath();
    if (!path || !this.dataDir) return;
    await writeJsonFileAtomic(path, Object.fromEntries(this.mcpRegistry));
  }

  private sessionRegistry = new Map<string, SessionBridgeRegistration>();
  private sessionRegistryLoaded = false;
  private sessionRegistryOperation: Promise<void> = Promise.resolve();

  private sessionRegistryPath() {
    return this.dataDir ? join(this.dataDir, SESSION_REGISTRY_FILE) : undefined;
  }

  private async withSessionRegistryLock<T>(operation: () => Promise<T>) {
    const result = this.sessionRegistryOperation.then(operation, operation);
    this.sessionRegistryOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadSessionRegistry() {
    if (this.sessionRegistryLoaded) return;
    this.sessionRegistryLoaded = true;
    const path = this.sessionRegistryPath();
    if (!path) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          const record = value as Record<string, unknown> | null;
          const usage = (record?.usage ?? {}) as Record<string, unknown>;
          const usageNumber = (entry: unknown) =>
            typeof entry === "number" && Number.isFinite(entry) && entry >= 0
              ? entry
              : 0;
          if (
            record &&
            typeof record.providerThreadId === "string" &&
            typeof record.cwd === "string"
          ) {
            this.sessionRegistry.set(key, {
              providerThreadId: record.providerThreadId,
              cwd: record.cwd,
              usage: {
                input: usageNumber(usage.input),
                output: usageNumber(usage.output),
                reasoning: usageNumber(usage.reasoning),
                cacheRead: usageNumber(usage.cacheRead),
                cacheWrite: usageNumber(usage.cacheWrite),
              },
            });
          }
        }
      }
    } catch {
      // Missing or corrupt registry: treat as empty and rebuild from here.
    }
  }

  private async writeSessionRegistry() {
    const path = this.sessionRegistryPath();
    if (!path || !this.dataDir) return;
    await writeJsonFileAtomic(path, Object.fromEntries(this.sessionRegistry));
  }

  async rememberSessionRegistration(
    bbThreadId: string,
    entry: SessionBridgeRegistration,
  ) {
    await this.withSessionRegistryLock(async () => {
      await this.loadSessionRegistry();
      const previous = this.sessionRegistry.get(bbThreadId);
      this.sessionRegistry.set(bbThreadId, entry);
      try {
        await this.writeSessionRegistry();
      } catch (error) {
        if (previous) this.sessionRegistry.set(bbThreadId, previous);
        else this.sessionRegistry.delete(bbThreadId);
        throw error;
      }
    });
  }

  async forgetSessionRegistration(bbThreadId: string) {
    await this.withSessionRegistryLock(async () => {
      await this.loadSessionRegistry();
      const previous = this.sessionRegistry.get(bbThreadId);
      this.sessionRegistry.delete(bbThreadId);
      try {
        await this.writeSessionRegistry();
      } catch (error) {
        if (previous) this.sessionRegistry.set(bbThreadId, previous);
        throw error;
      }
    });
  }

  async lookupSessionRegistration(
    bbThreadId: string,
  ): Promise<SessionBridgeRegistration | undefined> {
    return this.withSessionRegistryLock(async () => {
      await this.loadSessionRegistry();
      return this.sessionRegistry.get(bbThreadId);
    });
  }

  async start() {
    if (this.baseUrl) return;
    if (this.starting) {
      await this.starting;
      return;
    }
    const generation = ++this.connectionGeneration;
    this.starting = this.connect(generation);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async connect(generation: number) {
    // OpenCode runs one shared background service for everything. Connect to
    // it instead of spawning a private server: per-worker servers would hold
    // disjoint session state, so sessions created on one worker could not be
    // resumed from another.
    const status = await this.cli(["service", "start"]);
    const url = parseOpenCodeServiceUrl(status);
    await this.servicePassword();
    if (generation !== this.connectionGeneration) {
      throw new Error("OpenCode connection was stopped during startup");
    }
    this.baseUrl = url;
    this.eventAbortController?.abort();
    this.eventAbortController = new AbortController();
    void this.consumeEvents(this.eventAbortController.signal);
    if (!this.watchdog) {
      this.watchdog = setInterval(
        () => void this.reconcileActiveTurns(),
        RECONCILE_INTERVAL_MS,
      );
      this.watchdog.unref();
    }
  }

  private async cli(args: string[]): Promise<string> {
    const { stdout } = await promisify(execFile)("opencode2", args, {
      env: withoutBridgeRuntimeEnv(process.env),
      timeout: 15_000,
    });
    return stdout;
  }

  private async servicePassword(): Promise<string> {
    if (process.env.OPENCODE_SERVER_PASSWORD)
      return process.env.OPENCODE_SERVER_PASSWORD;
    if (this.password) return this.password;
    const configHome =
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(configHome, "opencode", "service.json"), "utf8"),
      );
      const password = (parsed as Record<string, unknown> | null)?.password;
      if (typeof password === "string" && password) {
        this.password = password;
        return password;
      }
    } catch {
      // Fall through to `opencode2 pair`.
    }
    const pair = await this.cli(["pair"]);
    const match = pair.match(/^Password\s+(.+?)\s*$/m);
    if (!match) throw new Error("Could not read OpenCode service credentials");
    this.password = match[1].trim();
    return this.password;
  }

  private headers() {
    const password = process.env.OPENCODE_SERVER_PASSWORD ?? this.password;
    if (!password)
      throw new Error("OpenCode service credentials are unavailable");
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    };
  }

  async request(path: string, init: RequestInit = {}): Promise<RecordValue> {
    await this.start();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `OpenCode API ${response.status}: ${await response.text()}`,
      );
    if (response.status === 204) return {};
    return inputRecord(await response.json());
  }

  private modelCatalogs = new Map<
    string,
    { at: number; result: Promise<OpenCodeModelCatalog> }
  >();

  /**
   * OpenCode's models and default model for a workspace. Cached briefly so a
   * turn's model switch can resolve variants and context limits without
   * re-listing hundreds of models.
   */
  async modelCatalog(
    cwd: string,
    fresh = false,
  ): Promise<OpenCodeModelCatalog> {
    const cached = this.modelCatalogs.get(cwd);
    if (!fresh && cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS)
      return cached.result;
    const result = (async () => {
      const query = locationQuery(cwd);
      // A location OpenCode has not loaded yet answers with an empty list
      // for a few hundred milliseconds, so retry briefly before trusting it.
      let models: RecordValue[] = [];
      for (let attempt = 0; attempt < MODEL_CATALOG_COLD_RETRIES; attempt++) {
        if (attempt > 0)
          await new Promise((resolve) =>
            setTimeout(resolve, MODEL_CATALOG_COLD_RETRY_MS),
          );
        const list = await this.request(`/api/model?${query}`);
        models = (Array.isArray(list.data) ? list.data : [])
          .map(inputRecord)
          .filter(
            (model) =>
              model.enabled !== false &&
              stringValue(model.providerID) !== undefined &&
              stringValue(model.id) !== undefined,
          );
        if (models.length > 0) break;
      }
      const fallback = await this.request(`/api/model/default?${query}`).catch(
        () => ({}),
      );
      const defaultModel = inputRecord(inputRecord(fallback).data);
      const defaultId =
        stringValue(defaultModel.providerID) && stringValue(defaultModel.id)
          ? `${defaultModel.providerID}/${defaultModel.id}`
          : undefined;
      return {
        models,
        defaultId,
        entries: new Map(
          models.map((model) => {
            const entry = modelCatalogEntry(model);
            return [entry.id, entry] as const;
          }),
        ),
      };
    })();
    this.modelCatalogs.set(cwd, { at: Date.now(), result });
    const forget = () => {
      if (this.modelCatalogs.get(cwd)?.result === result)
        this.modelCatalogs.delete(cwd);
    };
    result.then((catalog) => {
      if (catalog.models.length === 0) forget();
    }, forget);
    return result;
  }

  async lookupModel(
    cwd: string,
    id: string,
  ): Promise<ModelCatalogEntry | undefined> {
    try {
      return (await this.modelCatalog(cwd)).entries.get(id);
    } catch {
      return undefined;
    }
  }

  /**
   * Agents a user can pick as a session's primary agent: OpenCode's `primary`
   * and `all` modes, minus hidden ones. Subagent-only agents are reached
   * through delegation instead.
   */
  async primaryAgents(
    cwd: string,
  ): Promise<{ id: string; description?: string }[]> {
    const result = await this.request(`/api/agent?${locationQuery(cwd)}`);
    return (Array.isArray(result.data) ? result.data : []).flatMap(
      (value: unknown) => {
        const agent = inputRecord(value);
        const id = stringValue(agent.id ?? agent.name);
        if (!id || agent.hidden === true || agent.mode === "subagent")
          return [];
        const description = stringValue(agent.description);
        return [{ id, ...(description ? { description } : {}) }];
      },
    );
  }

  /** Skills OpenCode discovered for a workspace: ID and SKILL.md path. */
  async nativeSkills(cwd: string): Promise<{ id: string; path?: string }[]> {
    const result = await this.request(`/api/skill?${locationQuery(cwd)}`);
    return (Array.isArray(result.data) ? result.data : []).flatMap(
      (value: unknown) => {
        const skill = inputRecord(value);
        const id = stringValue(skill.id ?? skill.name);
        if (!id) return [];
        const path = stringValue(skill.location ?? skill.path);
        return [{ id, ...(path ? { path } : {}) }];
      },
    );
  }

  /**
   * Wait until OpenCode reports a runtime MCP server connected. Gives up
   * quietly after the timeout or when the server failed: the session still
   * works, only without that server's tools, and the failure is logged.
   */
  async waitForMcpServer(
    serverName: string,
    cwd: string,
    timeoutMs = MCP_CONNECT_TIMEOUT_MS,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let last = "unknown";
    while (Date.now() < deadline) {
      const result = await this.request(`/api/mcp?${locationQuery(cwd)}`).catch(
        (): OpenCodeRecord => ({}),
      );
      const server = (Array.isArray(result.data) ? result.data : [])
        .map(inputRecord)
        .find((entry) => entry.name === serverName);
      const status = inputRecord(server?.status);
      last = stringValue(status.status) ?? "missing";
      if (last === "connected") {
        // OpenCode lists the server's tools before it reports "connected",
        // but refreshes the tool set a session step sees a few hundred
        // milliseconds later, with no event to wait on. Measured under
        // 500 ms on OpenCode 2.0.27.
        await new Promise((resolve) => setTimeout(resolve, MCP_SETTLE_MS));
        return true;
      }
      if (last === "failed") {
        process.stderr.write(
          `[opencode2] BB tool server ${serverName} failed to start: ${stringValue(status.error) ?? "unknown error"}\n`,
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, MCP_CONNECT_POLL_MS));
    }
    process.stderr.write(
      `[opencode2] BB tool server ${serverName} did not connect within ${timeoutMs} ms (last status: ${last})\n`,
    );
    return false;
  }

  private reloadTimer?: ReturnType<typeof setTimeout>;

  /**
   * OpenCode reads its global config once; a changed file takes effect on the
   * next location reload. A reload cancels every pending approval and
   * question service-wide, so only do it while OpenCode is idle (nothing
   * pending, no running session) and otherwise try again later.
   */
  reloadConfigWhenIdle(attempt = 0) {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    void (async () => {
      try {
        const [permissions, forms, active] = await Promise.all([
          this.request("/api/permission/request"),
          this.request("/api/form"),
          this.request("/api/session/active"),
        ]);
        const busy =
          (Array.isArray(permissions.data) && permissions.data.length > 0) ||
          (Array.isArray(forms.data) && forms.data.length > 0) ||
          Object.keys(inputRecord(active.data)).length > 0;
        if (!busy) {
          // A location whose directory was deleted makes the reload report
          // 503, but every other location still reloads.
          await this.request("/api/location/reload", { method: "POST" }).catch(
            () => {},
          );
          return;
        }
      } catch {
        // Service unreachable; retry below.
      }
      if (attempt + 1 >= CONFIG_RELOAD_MAX_ATTEMPTS) return;
      this.reloadTimer = setTimeout(
        () => this.reloadConfigWhenIdle(attempt + 1),
        CONFIG_RELOAD_RETRY_MS,
      );
      this.reloadTimer.unref();
    })();
  }

  async nativeSkillNames(cwd: string) {
    try {
      const result = await this.request(`/api/skill?${locationQuery(cwd)}`);
      return new Set<string>(
        (Array.isArray(result.data) ? result.data : [])
          .map((value: unknown) => {
            const skill = inputRecord(value);
            return stringValue(skill.id ?? skill.name);
          })
          .filter(
            (name: string | undefined): name is string => name !== undefined,
          ),
      );
    } catch {
      return undefined;
    }
  }

  async listSessionMessageIds(sessionId: string): Promise<CheckpointMessage[]> {
    const messages: CheckpointMessage[] = [];
    let cursor: string | undefined;
    const maxPages = 100;
    for (let page = 0; page < maxPages; page++) {
      // OpenCode rejects combining a pagination cursor with order, so only
      // the first page carries order=asc; follow-ups send cursor alone.
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      else query.set("order", "asc");
      const result = await this.request(
        `/api/session/${encodeURIComponent(sessionId)}/message?${query}`,
      );
      const pageMessages = Array.isArray(result.data) ? result.data : [];
      // OpenCode always returns a `next` cursor; an empty page is the end.
      if (pageMessages.length === 0) break;
      for (const msg of pageMessages) {
        const record = inputRecord(msg);
        const id = stringValue(record.id);
        if (id) messages.push({ id, type: stringValue(record.type) });
      }
      const next = stringValue(result?.cursor?.next);
      if (!next || next === cursor) break;
      if (page === maxPages - 1) {
        throw new Error(
          "OpenCode session history exceeded the pagination limit",
        );
      }
      cursor = next;
    }
    return messages;
  }

  async forkBoundaryRetainingThrough(sessionId: string, checkpointId?: string) {
    if (!checkpointId) return {};
    const messages = await this.listSessionMessageIds(sessionId);
    if (!messages.some((entry) => entry.id === checkpointId)) {
      throw new Error(`OpenCode checkpoint not found: ${checkpointId}`);
    }
    return forkBoundaryRetainingThrough(messages, checkpointId);
  }

  async rewindSessionRetainingThrough(sessionId: string, checkpointId: string) {
    let messages: CheckpointMessage[];
    try {
      messages = await this.listSessionMessageIds(sessionId);
    } catch (error) {
      throw new Error(
        `Could not list OpenCode messages for rewind: ${errorMessage(error)}`,
      );
    }
    const target = revertTargetRetainingThrough(messages, checkpointId);
    if (target === undefined) {
      await this.request(
        `/api/session/${encodeURIComponent(sessionId)}/revert`,
        {
          method: "DELETE",
        },
      ).catch(() => {});
      return;
    }
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" },
    ).catch(() => {});
    // The previous turn may still be draining after interrupt; retry staged
    // reverts that hit a busy session instead of failing edit/rewind outright.
    let staged = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.request(
          `/api/session/${encodeURIComponent(sessionId)}/revert/stage`,
          {
            method: "POST",
            body: JSON.stringify({ messageID: target, files: true }),
          },
        );
        staged = true;
        break;
      } catch (error) {
        lastError = error;
        if (!/409|busy/i.test(errorMessage(error)) || attempt === 4)
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 400 * (attempt + 1)),
        );
      }
    }
    if (!staged) throw lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.request(
          `/api/session/${encodeURIComponent(sessionId)}/revert/commit`,
          { method: "POST" },
        );
        return;
      } catch (error) {
        if (!/409|busy/i.test(errorMessage(error)) || attempt === 4)
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 400 * (attempt + 1)),
        );
      }
    }
  }

  private async consumeEvents(signal: AbortSignal) {
    let connectedBefore = false;
    while (this.baseUrl && !signal.aborted) {
      try {
        const response = await fetch(`${this.baseUrl}/api/event`, {
          headers: this.headers(),
          signal,
        });
        if (!response.ok || !response.body)
          throw new Error(
            `OpenCode event stream returned HTTP ${response.status}`,
          );
        // The stream does not replay: anything that happened while it was
        // down is gone, including the end of a turn.
        if (connectedBefore) void this.reconcileActiveTurns();
        connectedBefore = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame
              .split("\n")
              .find((value) => value.startsWith("data: "));
            if (!line) continue;
            try {
              await this.handleEvent(JSON.parse(line.slice(6)));
            } catch {
              // Ignore malformed or unsupported provider events.
            }
          }
        }
      } catch {
        if (this.baseUrl && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
  }

  private reconciling = false;

  /**
   * Finish BB turns whose OpenCode execution already ended without BB seeing
   * the terminal event (a dropped event stream, or a service restart). Runs
   * after every stream reconnect and periodically as a watchdog. A turn is
   * only settled once OpenCode reports the session idle since the turn began
   * and that idle state has had time for its trailing events to arrive.
   */
  async reconcileActiveTurns(now = Date.now()): Promise<void> {
    if (this.reconciling) return;
    const candidates = [...sessions.values()].filter(
      (session) =>
        session.active?.promptDelivered === true &&
        !session.active.manualCompaction &&
        now - session.active.startedAt > RECONCILE_MIN_TURN_AGE_MS,
    );
    if (candidates.length === 0) return;
    this.reconciling = true;
    try {
      const running = inputRecord(
        (await this.request("/api/session/active")).data,
      );
      for (const session of candidates) {
        const active = session.active;
        if (!active || session.providerThreadId in running) continue;
        const info = inputRecord(
          (
            await this.request(
              `/api/session/${encodeURIComponent(session.providerThreadId)}`,
            ).catch((): OpenCodeRecord => ({}))
          ).data,
        );
        const idle = inputRecord(info.time).idle;
        if (
          session.active !== active ||
          typeof idle !== "number" ||
          idle < active.startedAt ||
          Date.now() - idle < RECONCILE_SETTLE_MS
        )
          continue;
        if (info.outcome === "failed")
          this.finish(
            session,
            "failed",
            "OpenCode reported this turn failed while BB was disconnected from its event stream",
          );
        else
          this.finish(
            session,
            info.outcome === "interrupted" ? "interrupted" : "completed",
          );
      }
    } catch {
      // The service is unreachable; the next reconnect or tick retries.
    } finally {
      this.reconciling = false;
    }
  }

  private readonly agentListeners = new Set<(directory: string) => void>();

  /**
   * Since OpenCode 2.2.7, `/api/agent` answers with the agents loaded so far
   * while a workspace's plugins are still loading, and sends `agent.updated`
   * once they finish. Listeners get the workspace directory, so anything built
   * from the agent list can be refreshed.
   */
  onAgentsUpdated(listener: (directory: string) => void): () => void {
    this.agentListeners.add(listener);
    return () => this.agentListeners.delete(listener);
  }

  async handleEvent(event: RecordValue): Promise<void> {
    if (event.type === "agent.updated") {
      const directory = stringValue(inputRecord(event.location).directory);
      if (directory)
        for (const listener of this.agentListeners) listener(directory);
    }
    await this.eventRouter.handleEvent(event);
  }

  finish(
    session: SessionState,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ): void {
    this.eventRouter.finish(session, status, error);
  }

  async stop() {
    // The background service is shared with the OpenCode app/CLI; never stop
    // it here. Just drop our reference so the event loop exits.
    this.connectionGeneration += 1;
    this.baseUrl = undefined;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.eventAbortController?.abort();
    this.eventAbortController = undefined;
  }
}

export const openCodeServer = new OpenCodeServer();
