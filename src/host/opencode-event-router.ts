import { experimental_COMPACTION_PRESENTATION as compactionPresentation } from "@get-bb/plugin-sdk/provider-bridge";
import {
  backgroundReport,
  backgroundShellJob,
  backgroundSubagentJob,
  movedToBackground,
  openBackgroundJobDelta,
  reportTaskStatus,
  settleBackgroundJobDelta,
  unwrapReport,
} from "./background-work.ts";
import { dynamicToolCallRouter, emit } from "./bridge-runtime.ts";
import { OpenCodeInteractions } from "./opencode-interactions.ts";
import { toolFailureError } from "./prompt.ts";
import { dynamicMcpServerName, locationQuery } from "./opencode-requests.ts";
import {
  boundedTimelineText,
  itemKey,
  itemKeyForOpenItem,
  manualCompactionOutcomeDeltas,
  providerFailureDeltas,
} from "./timeline.ts";
import {
  contentText,
  dynamicToolRow,
  gitDiff,
  gitDiffNewFile,
  metadataFileChanges,
  toolRow,
  touchedPaths,
  workspacePath,
} from "./tool-mapping.ts";
import {
  createActiveTurn,
  inputRecord,
  parseInputText,
  sessionsByProviderId,
  stringValue,
  type ActiveTurn,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

const SHELL_OUTPUT_POLL_MS = 400;
const SHELL_OUTPUT_CHUNK_BYTES = 32 * 1024;

type RequestOpenCode = (
  path: string,
  init?: RequestInit,
) => Promise<RecordValue>;

/**
 * OpenCode v2 reports a shell tool's exit status as `metadata.exit` on
 * `session.tool.success` (a non-zero exit is still a "success" event) and
 * appends "Exited with code N" to the content.
 */
export function shellExitCode(data: RecordValue): number | undefined {
  const candidates = [inputRecord(data.metadata).exit, data.exitCode];
  for (const value of candidates)
    if (typeof value === "number" && Number.isInteger(value)) return value;
  const match = contentText(data.content).match(/Exited with code (-?\d+)/);
  return match ? Number(match[1]) : undefined;
}

function sessionToolRow(session: SessionState, name: string, input: unknown) {
  return (
    (session.dynamicTools.length > 0
      ? dynamicToolRow(
          dynamicMcpServerName(session.providerThreadId),
          session.dynamicTools,
          name,
          input,
        )
      : undefined) ?? toolRow(name, input, session.cwd)
  );
}

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function tokenBreakdown(raw: unknown) {
  const tokens = inputRecord(raw);
  const cache = inputRecord(tokens.cache);
  const breakdown = {
    inputTokens: tokenCount(tokens.input),
    outputTokens: tokenCount(tokens.output),
    reasoningOutputTokens: tokenCount(tokens.reasoning),
    cachedInputTokens: tokenCount(cache.read),
  };
  const cacheWrite = tokenCount(cache.write);
  return {
    breakdown: {
      ...breakdown,
      totalTokens:
        breakdown.inputTokens +
        breakdown.outputTokens +
        breakdown.reasoningOutputTokens +
        breakdown.cachedInputTokens +
        cacheWrite,
    },
    cacheWrite,
  };
}

/**
 * `session.usage.updated` carries OpenCode's cumulative session totals, so it
 * stays correct across resumes and workers. The latest step's tokens are the
 * last request's usage and approximate the live context size.
 */
export function usageDeltas(
  session: SessionState,
  active: ActiveTurn,
  totals: unknown,
): RecordValue[] {
  const total = tokenBreakdown(totals);
  const last = tokenBreakdown(active.lastStepTokens ?? {});
  session.usage = {
    input: total.breakdown.inputTokens,
    output: total.breakdown.outputTokens,
    reasoning: total.breakdown.reasoningOutputTokens,
    cacheRead: total.breakdown.cachedInputTokens,
    cacheWrite: total.cacheWrite,
  };
  const size = session.contextWindow ?? null;
  const used = active.lastStepTokens ? last.breakdown.totalTokens : null;
  return [
    {
      kind: "usage",
      total: total.breakdown,
      last: last.breakdown,
      modelContextWindow: size,
      providerTurnId: active.providerTurnId,
    },
    ...(used !== null
      ? [
          {
            kind: "contextWindow",
            used,
            size,
            estimated: false,
            attach: "currentOrLast",
            providerTurnId: active.providerTurnId,
          },
        ]
      : []),
  ];
}

function retryErrorCategory(error: RecordValue) {
  const text =
    `${stringValue(error.type) ?? ""} ${stringValue(error.message) ?? ""}`.toLowerCase();
  if (/rate.?limit|429|too many requests/.test(text)) return "rate-limit";
  if (/overload|529|503|unavailable/.test(text)) return "overloaded";
  if (/timeout|connection|network|econn|socket/.test(text))
    return "connection-failed";
  return undefined;
}

const CHILD_EVENT_PATTERN =
  /^(permission\.asked|session\.(text|reasoning|tool)\.)/;

export class OpenCodeEventRouter {
  private readonly interactions: OpenCodeInteractions;
  private readonly emitTimeline: typeof emit;
  private readonly sessionLookup: ReadonlyMap<string, SessionState>;
  private readonly request: RequestOpenCode;
  /**
   * Native subagent sessions by child session ID, until the parent turn that
   * spawned them ends. A background subagent working past that turn is shown
   * only through its delegation row's final report.
   */
  private readonly childSessions = new Map<
    string,
    { parentId: string; callId: string }
  >();
  /** Provider item ID -> the delegation call it is nested under. */
  private readonly parentRefs = new Map<string, string>();
  /** Set while handling a child-session event. */
  private childParentRef?: string;

  constructor(
    request: RequestOpenCode,
    emitTimeline: typeof emit = emit,
    sessionLookup: ReadonlyMap<string, SessionState> = sessionsByProviderId,
  ) {
    this.request = request;
    this.emitTimeline = emitTimeline;
    this.interactions = new OpenCodeInteractions(request, this.emit);
    this.sessionLookup = sessionLookup;
  }

  /**
   * Emit deltas, nesting items that belong to a native subagent under its
   * delegation row. An item first opened while handling a child-session
   * event records its parent; later deltas for it (output, close, turn-end
   * cleanup) reuse that parent wherever they are emitted from.
   */
  private readonly emit = (threadId: string, deltas: RecordValue[]) => {
    this.emitTimeline(
      threadId,
      deltas.map((delta) => {
        const key = inputRecord(delta.key);
        const id = stringValue(key.providerItemId);
        if (!id) return delta;
        if (
          delta.kind === "item.open" &&
          this.childParentRef &&
          !this.parentRefs.has(id)
        )
          this.parentRefs.set(id, this.childParentRef);
        const parentRef = this.parentRefs.get(id);
        return parentRef ? { ...delta, key: { ...key, parentRef } } : delta;
      }),
    );
  };

  async handleEvent(event: RecordValue): Promise<void> {
    const data = inputRecord(event.data);
    const sessionId = stringValue(data.sessionID);
    if (!sessionId) return;
    const session = this.sessionLookup.get(sessionId);
    if (session) return this.handleSessionEvent(session, event, data);
    const child = this.childSessions.get(sessionId);
    const type = stringValue(event.type) ?? "";
    // A subagent's own lifecycle, usage, and compaction belong to the child
    // session; only its visible work joins the parent turn.
    if (!child || !CHILD_EVENT_PATTERN.test(type)) return;
    const parent = this.sessionLookup.get(child.parentId);
    if (!parent) return;
    this.childParentRef = child.callId;
    try {
      await this.handleSessionEvent(parent, event, data);
    } finally {
      this.childParentRef = undefined;
    }
  }

  private async handleSessionEvent(
    session: SessionState,
    event: RecordValue,
    data: RecordValue,
  ): Promise<void> {
    if (event.type === "permission.asked") {
      void this.interactions.handlePermission(session, data);
      return;
    }
    if (event.type === "session.inbox.enqueued") {
      this.settleBackgroundJob(session, data.item);
      // Prompts and reports get a reply worth a turn. Compaction and session
      // moves are housekeeping.
      const kind = inputRecord(data.item).type;
      if (!session.active && (kind === "user" || kind === "synthetic"))
        this.openProviderTurn(session, stringValue(data.inboxID));
      return;
    }
    const active = session.active;
    if (!active) return;
    const eventId = stringValue(data.id) ?? "";
    const eventType = stringValue(event.type) ?? "";
    if (eventType.startsWith("session.tool.") && !eventId) return;
    if (this.handleCompactionEvent(session, active, event.type, data)) return;
    const assistantMessageId = stringValue(data.assistantMessageID);
    const ordinal =
      typeof data.ordinal === "number" && Number.isSafeInteger(data.ordinal)
        ? data.ordinal
        : undefined;
    const textPartId =
      assistantMessageId && ordinal !== undefined
        ? `text:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.text.started" && textPartId) {
      const item = { type: "agentMessage", text: "" };
      active.opened.set(textPartId, item);
      this.emit(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(textPartId, "agentMessage"),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.delta" &&
      textPartId &&
      typeof data.delta === "string"
    ) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.textDelta",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.delta,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.ended" &&
      textPartId &&
      typeof data.text === "string"
    ) {
      const item = active.opened.get(textPartId) ?? {
        type: "agentMessage",
        text: data.text,
      };
      item.text = data.text;
      active.opened.delete(textPartId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.text,
          providerTurnId: active.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(textPartId, "agentMessage"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    const reasoningPartId =
      assistantMessageId && ordinal !== undefined
        ? `reasoning:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.reasoning.started" && reasoningPartId) {
      const item = { type: "reasoning", summary: [], content: [] };
      active.opened.set(reasoningPartId, item);
      this.emit(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(reasoningPartId, "reasoningText"),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.delta" &&
      reasoningPartId &&
      typeof data.delta === "string"
    ) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.textDelta",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.delta,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.ended" &&
      reasoningPartId &&
      typeof data.text === "string"
    ) {
      const item = active.opened.get(reasoningPartId) ?? {
        type: "reasoning",
        summary: [],
        content: [],
      };
      item.content = [data.text];
      active.opened.delete(reasoningPartId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.text,
          providerTurnId: active.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(reasoningPartId, "reasoningText"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (event.type === "session.tool.input.started") {
      const toolName = stringValue(data.name);
      if (eventId && toolName) active.pendingTools.set(eventId, toolName);
    }
    if (event.type === "session.tool.input.ended") {
      if (eventId && typeof data.text === "string")
        active.pendingInput.set(eventId, data.text);
    }
    if (event.type === "session.tool.called") {
      const name = active.pendingTools.get(eventId);
      if (name) {
        const input = inputRecord(
          data.input ?? parseInputText(active.pendingInput.get(eventId)),
        );
        const row = sessionToolRow(session, name, input);
        if (row.item.type === "delegation")
          (row.item as RecordValue).childRef = eventId;
        active.opened.set(eventId, row.item);
        const touched = touchedPaths(name, input);
        if (touched.length) active.touchedFiles.set(eventId, touched);
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(eventId, "tool"),
            item: row.item,
            presentation: row.presentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
        // OpenCode's question tool blocks forever waiting on an interactive
        // form that no TUI will answer in a BB thread. Relay it to BB's
        // native question UI instead (see handleQuestion).
        if (name.toLowerCase() === "question") {
          void this.interactions
            .handleQuestion(session, active, eventId)
            .catch(() => {});
        }
      } else {
        const item = active.opened.get(eventId);
        if (item) item.args = data.input;
      }
    }
    if (event.type === "session.tool.progress") {
      const childId = stringValue(inputRecord(data.metadata).sessionID);
      const opened = active.opened.get(eventId);
      if (childId && opened?.type === "delegation") {
        opened.childRef = childId;
        this.childSessions.set(childId, {
          parentId: session.providerThreadId,
          callId: eventId,
        });
      }
      const shellId = stringValue(inputRecord(data.metadata).shellID);
      if (shellId && active.opened.get(eventId)?.type === "command")
        this.streamShellOutput(session, active, eventId, shellId);
    }
    if (
      event.type === "session.tool.success" ||
      event.type === "session.tool.failed"
    ) {
      this.stopShellOutput(active, eventId);
      active.finishedTools ??= new Set();
      if (active.finishedTools.has(eventId)) return;
      active.finishedTools.add(eventId);
      // handleQuestion may already have closed + answered this call.
      if (active.settledTools.has(eventId)) {
        active.settledTools.delete(eventId);
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        active.pendingTools.delete(eventId);
        return;
      }
      const name =
        active.pendingTools.get(eventId) ??
        stringValue(data.name) ??
        "OpenCode tool";
      const input = inputRecord(
        data.input ?? parseInputText(active.pendingInput.get(eventId)),
      );
      let item = active.opened.get(eventId);
      if (!item) {
        const row = sessionToolRow(session, name, input);
        if (row.item.type === "delegation")
          (row.item as RecordValue).childRef = eventId;
        item = row.item;
        active.opened.set(eventId, item);
        const touched = touchedPaths(name, input);
        if (touched.length) active.touchedFiles.set(eventId, touched);
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(eventId, "tool"),
            item,
            presentation: row.presentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
      const output = contentText(data.content);
      if (
        event.type === "session.tool.success" &&
        movedToBackground(data) &&
        this.moveToBackground(session, active, eventId, item, output, data)
      ) {
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        return;
      }
      if (item.type === "delegation") {
        item.summary =
          event.type === "session.tool.success"
            ? unwrapReport(output)
            : toolFailureError(
                name,
                session.disableSubagents,
                stringValue(inputRecord(data.error).message),
              );
        if (!item.summary) delete item.summary;
        const childId = stringValue(inputRecord(data.metadata).sessionID);
        if (childId) item.childRef = childId;
      } else if (item.type === "tool") {
        if (event.type === "session.tool.success") item.result = output;
        else {
          const error = inputRecord(data.error);
          item.error = toolFailureError(
            name,
            session.disableSubagents,
            stringValue(error.message),
          );
        }
      } else if (item.type === "command") {
        const error = inputRecord(data.error);
        item.aggregatedOutput =
          event.type === "session.tool.success"
            ? output
            : (stringValue(error.message) ?? "OpenCode tool failed");
        const exitCode = shellExitCode(data);
        item.exitCode =
          event.type === "session.tool.success"
            ? (exitCode ?? 0)
            : (exitCode ?? 1);
      }
      active.opened.delete(eventId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKey(eventId, "tool"),
          status:
            event.type.endsWith("failed") ||
            (item.type === "command" && item.exitCode !== 0)
              ? "failed"
              : "completed",
          ...(item.type === "tool" && item.result
            ? { resultText: item.result }
            : {}),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
      if (event.type === "session.tool.success") {
        const touched =
          active.touchedFiles.get(eventId) ?? touchedPaths(name, input);
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        const patched = metadataFileChanges(data.metadata, session.cwd);
        if (patched.length) {
          this.emitFileChangeRow(session, active, `files:${eventId}`, patched);
        } else if (touched.length) {
          await this.emitFileChanges(
            session,
            active,
            `files:${eventId}`,
            touched,
          );
        }
      } else {
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
      }
    }
    if (
      event.type === "session.step.ended" ||
      event.type === "session.step.failed"
    ) {
      if (data.tokens !== undefined)
        active.lastStepTokens = inputRecord(data.tokens);
    }
    if (event.type === "session.usage.updated") {
      this.emit(session.bbThreadId, usageDeltas(session, active, data.tokens));
    }
    if (event.type === "session.retry.scheduled") {
      const error = inputRecord(data.error);
      const attempt =
        typeof data.attempt === "number" ? ` (attempt ${data.attempt})` : "";
      const category = retryErrorCategory(error);
      this.emit(session.bbThreadId, [
        {
          kind: "provider.error",
          message: `${stringValue(error.message) ?? "OpenCode model request failed"}. Retrying${attempt}.`,
          willRetry: true,
          ...(category ? { category } : {}),
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.inbox.delivered" &&
      active.promptIds?.has(stringValue(data.inboxID) ?? "")
    )
      active.inputDelivered = true;
    // Nothing will run for a turn whose every prompt was withdrawn, and the
    // withdrawn message is no checkpoint to rewind to.
    if (
      event.type === "session.inbox.cancelled" &&
      !active.inputDelivered &&
      active.promptIds?.delete(stringValue(data.inboxID) ?? "") &&
      active.promptIds.size === 0
    ) {
      active.checkpointId = undefined;
      this.finish(session, "interrupted");
      return;
    }
    if (
      eventType.startsWith("session.execution.") &&
      active.promptIds?.size &&
      !active.inputDelivered
    )
      return;
    if (event.type === "session.execution.succeeded")
      this.finish(session, "completed");
    if (event.type === "session.execution.interrupted")
      this.finish(session, "interrupted");
    if (event.type === "session.execution.failed") {
      const error = inputRecord(data.error);
      this.finish(
        session,
        "failed",
        stringValue(error.message) ?? "OpenCode execution failed",
      );
    }
  }

  private handleCompactionEvent(
    session: SessionState,
    active: ActiveTurn,
    type: unknown,
    data: RecordValue,
  ) {
    const eventType = stringValue(type);
    if (!eventType) return false;
    const message = inputRecord(data.message ?? data.info);
    const messageId = stringValue(
      data.messageID ?? data.messageId ?? data.id ?? message.id,
    );
    const reason = stringValue(data.reason ?? message.reason);
    const status = stringValue(data.status ?? message.status);
    const itemId = messageId ?? active.manualCompaction?.itemId;
    const isStarted =
      eventType === "session.next.compaction.started" ||
      eventType === "session.compaction.started" ||
      (eventType === "session.message.updated" &&
        status === "running" &&
        message.type === "compaction");
    const isCompleted =
      eventType === "session.next.compaction.ended" ||
      eventType === "session.compaction.ended" ||
      eventType === "session.compacted" ||
      (eventType === "session.message.updated" &&
        status === "completed" &&
        message.type === "compaction");
    const isFailed =
      eventType === "session.compaction.failed" ||
      (eventType === "session.message.updated" &&
        status === "failed" &&
        message.type === "compaction");
    if (!isStarted && !isCompleted && !isFailed) return false;

    if (isStarted) {
      if (itemId && !active.opened.has(itemId)) {
        const item = { type: "compaction" };
        active.opened.set(itemId, item);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(itemId, "compaction"),
            item,
            presentation: compactionPresentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
      return true;
    }

    const error =
      stringValue(
        data.error?.message ??
          data.error ??
          message.error?.message ??
          message.error,
      ) ?? "OpenCode context compaction failed";
    const manualCompaction = active.manualCompaction;
    const manual =
      manualCompaction !== undefined &&
      (itemId === manualCompaction.itemId ||
        reason === "manual" ||
        eventType === "session.compacted");
    if (manual && manualCompaction) {
      active.opened.delete(manualCompaction.itemId);
      this.emit(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.providerTurnId,
          messageId: manualCompaction.itemId,
          status: isCompleted ? "completed" : "failed",
          ...(isFailed ? { error } : {}),
        }),
      );
      active.openQuestions.clear();
      active.settledTools.clear();
      active.pendingTools.clear();
      active.pendingInput.clear();
      active.touchedFiles.clear();
      active.abortController.abort();
      session.active = undefined;
      return true;
    }

    if (itemId) {
      const item = active.opened.get(itemId);
      if (item) {
        active.opened.delete(itemId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.close",
            key: itemKey(itemId, "compaction"),
            status: isCompleted ? "completed" : "failed",
            item,
            presentation: compactionPresentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
    }
    if (isCompleted)
      this.emit(session.bbThreadId, [
        { kind: "context.compacted", providerTurnId: active.providerTurnId },
      ]);
    return true;
  }

  /**
   * OpenCode v2 runs shell tools as background shells and only reports their
   * output when the tool finishes. Poll the shell's byte-cursor output API so
   * BB's command row streams like a local terminal.
   */
  private streamShellOutput(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    shellId: string,
  ) {
    active.shellPolls ??= new Map();
    if (active.shellPolls.has(callId)) return;
    const poll = { stopped: false };
    active.shellPolls.set(callId, poll);
    void (async () => {
      let cursor = 0;
      while (!poll.stopped && session.active === active) {
        try {
          const result = await this.request(
            `/api/shell/${encodeURIComponent(shellId)}/output?${locationQuery(session.cwd)}&cursor=${cursor}`,
            { signal: active.abortController.signal },
          );
          const output = inputRecord(result.data);
          if (
            !poll.stopped &&
            session.active === active &&
            typeof output.output === "string" &&
            output.output.length > 0
          ) {
            this.emit(session.bbThreadId, [
              {
                kind: "item.outputDelta",
                key: itemKey(callId, "tool"),
                channel: "command",
                text: boundedTimelineText(
                  output.output,
                  SHELL_OUTPUT_CHUNK_BYTES,
                ),
                providerTurnId: active.providerTurnId,
              },
            ]);
          }
          if (typeof output.cursor === "number") cursor = output.cursor;
        } catch {
          // The shell is gone (finished and cleaned up) or the turn ended.
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, SHELL_OUTPUT_POLL_MS),
        );
      }
    })();
  }

  private stopShellOutput(active: ActiveTurn, callId: string) {
    const poll = active.shellPolls?.get(callId);
    if (!poll) return;
    poll.stopped = true;
    active.shellPolls?.delete(callId);
  }

  /**
   * The call returned while its work keeps running (see background-work.ts).
   * Track the work so its row stays open past this turn. Returns false for a
   * call BB cannot follow, which then closes like any other.
   */
  private moveToBackground(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    item: RecordValue,
    output: string,
    data: RecordValue,
  ): boolean {
    // A subagent's own background work reports to the subagent.
    if (this.childParentRef) return false;
    const metadata = inputRecord(data.metadata);
    const jobId = stringValue(
      item.type === "delegation" ? metadata.sessionID : metadata.shellID,
    );
    if (!jobId) return false;
    if (item.type === "delegation") {
      item.childRef = jobId;
      (session.backgroundJobs ??= new Map()).set(
        jobId,
        backgroundSubagentJob(callId, item),
      );
    } else if (item.type === "command") {
      // The call itself is done; the shell lives on as a background task.
      item.aggregatedOutput = output;
      const job = backgroundShellJob(
        jobId,
        stringValue(item.command) ?? "",
        output,
      );
      (session.backgroundJobs ??= new Map()).set(jobId, job);
      this.emit(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKey(callId, "tool"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
        },
        openBackgroundJobDelta(job, active.providerTurnId),
      ]);
    } else {
      return false;
    }
    active.opened.delete(callId);
    return true;
  }

  /** Closes a background job's row when OpenCode reports it finished. */
  private settleBackgroundJob(session: SessionState, inboxItem: unknown) {
    const report = backgroundReport(inboxItem);
    const job = report && session.backgroundJobs?.get(report.jobId);
    if (!report || !job) return;
    const taskStatus = reportTaskStatus(report);
    if (!taskStatus) return;
    session.backgroundJobs?.delete(report.jobId);
    this.emit(session.bbThreadId, [
      settleBackgroundJobDelta(job, report, taskStatus),
    ]);
  }

  /**
   * OpenCode started work no BB turn asked for: a background job's report
   * woke the idle session, or another client prompted it. Open a turn so the
   * work shows up. It ends like any other, on the execution's terminal event.
   */
  private openProviderTurn(session: SessionState, inboxId?: string) {
    const active = createActiveTurn();
    active.promptDelivered = true;
    if (inboxId) {
      active.promptIds = new Set([inboxId]);
      active.checkpointId = inboxId;
    }
    session.active = active;
    this.emit(session.bbThreadId, [
      { kind: "turn.open", providerTurnId: active.providerTurnId },
    ]);
  }

  private async emitFileChanges(
    session: SessionState,
    active: ActiveTurn,
    key: string,
    paths: string[],
  ): Promise<void> {
    // OpenCode's step.ended carries no file list, and write/edit rows are
    // suppressed, so render the change from the tool input recorded at call
    // time. The event reader awaits this method to preserve delta ordering.
    const changes = await Promise.all(
      paths.map(async (touched) => {
        const file = workspacePath(session.cwd, touched);
        const diff = await gitDiff(session.cwd, file);
        if (diff) return { path: file, kind: "update", diff };
        // An untracked new file has no `git diff`; show its whole content.
        const added = await gitDiffNewFile(session.cwd, file);
        return added
          ? { path: file, kind: "add", diff: added }
          : { path: file, kind: "update" };
      }),
    );
    this.emitFileChangeRow(session, active, key, changes);
  }

  private emitFileChangeRow(
    session: SessionState,
    active: ActiveTurn,
    key: string,
    changes: RecordValue[],
  ) {
    for (const change of changes)
      if (typeof change.diff === "string" && change.diff)
        (active.turnPatches ??= []).push(change.diff);
    const item = { type: "fileChange", changes };
    this.emit(session.bbThreadId, [
      {
        kind: "item.open",
        key: itemKey(key, "fileChange"),
        item,
        providerTurnId: active.providerTurnId,
      },
      {
        kind: "item.close",
        key: itemKey(key, "fileChange"),
        status: "completed",
        item,
        providerTurnId: active.providerTurnId,
      },
    ]);
  }

  finish(
    session: SessionState,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ) {
    const active = session.active;
    if (!active) return;
    active.abortController.abort();
    if (active.manualCompaction) {
      this.emit(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.providerTurnId,
          messageId: active.manualCompaction.itemId,
          status,
          ...(error ? { error } : {}),
        }),
      );
      session.active = undefined;
      return;
    }
    for (const [childId, child] of this.childSessions)
      if (child.parentId === session.providerThreadId)
        this.childSessions.delete(childId);
    for (const poll of active.shellPolls?.values() ?? []) poll.stopped = true;
    active.shellPolls?.clear();
    dynamicToolCallRouter.resolve(
      session.dynamicToolScope,
      "OpenCode turn ended before the BB tool returned",
    );
    for (const [, formId] of active.openQuestions)
      void this.interactions.cancelQuestionForm(session, formId);
    for (const [id, item] of active.opened) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKeyForOpenItem(id, item),
          status,
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    for (const id of active.opened.keys()) this.parentRefs.delete(id);
    active.opened.clear();
    active.openQuestions.clear();
    active.settledTools.clear();
    active.pendingTools.clear();
    active.pendingInput.clear();
    active.touchedFiles.clear();
    // OpenCode's session diff endpoint needs snapshots that are often off,
    // so the turn diff is the sequence of patches its edit tools reported.
    if (active.turnPatches?.length)
      this.emit(session.bbThreadId, [
        {
          kind: "turn.diff",
          diff: active.turnPatches
            .map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`))
            .join(""),
          providerTurnId: active.providerTurnId,
        },
      ]);
    if (status === "failed") {
      this.emit(
        session.bbThreadId,
        providerFailureDeltas({
          providerTurnId: active.providerTurnId,
          error: error ?? "OpenCode execution failed",
          ...(active.checkpointId
            ? { providerCheckpointId: active.checkpointId }
            : {}),
        }),
      );
    } else {
      this.emit(session.bbThreadId, [
        {
          kind: "turn.boundary",
          status,
          ...(active.checkpointId
            ? { providerCheckpointId: active.checkpointId }
            : {}),
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    session.active = undefined;
  }
}
