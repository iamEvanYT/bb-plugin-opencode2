import {
  backgroundTaskItemStatus,
  experimental_presentationTitle as presentationTitle,
  experimental_withTitle as withTitle,
  LOCAL_BASH_TASK_TYPE,
  type BackgroundTaskStatus,
} from "@get-bb/plugin-sdk/provider-bridge";
import { itemKey } from "./timeline.ts";
import {
  inputRecord,
  stringValue,
  type BackgroundJob,
  type OpenCodeRecord,
} from "./types.ts";

/**
 * Since OpenCode 2.3, subagents always run in the background, and a shell
 * command still running at its timeout moves to the background instead of
 * being killed. The tool call returns at once with `metadata.status:
 * "running"`, the turn ends, and OpenCode later wakes the session with a
 * synthetic `<shell>` or `<subagent>` report. These helpers keep a BB row open
 * across that gap and settle it from the report.
 */

/** True when a tool call returned but its work continues in the background. */
export function movedToBackground(data: OpenCodeRecord): boolean {
  return inputRecord(data.metadata).status === "running";
}

export type BackgroundReport = {
  source: "shell" | "subagent";
  /** The shell ID, or the subagent's child session ID. */
  jobId: string;
  state: string;
  exit?: number;
  /** The report body, without OpenCode's `<shell>`/`<subagent>` wrapper. */
  text: string;
};

/** Reads a background report from a `session.inbox.enqueued` item. */
export function backgroundReport(value: unknown): BackgroundReport | undefined {
  const item = inputRecord(value);
  if (item.type !== "synthetic") return undefined;
  const payload = inputRecord(item.payload);
  const metadata = inputRecord(payload.metadata);
  const source = metadata.source;
  const jobId =
    source === "shell"
      ? stringValue(metadata.shellID ?? metadata.jobID)
      : source === "subagent"
        ? stringValue(metadata.childID)
        : undefined;
  const state = stringValue(metadata.state);
  if (!jobId || !state || (source !== "shell" && source !== "subagent"))
    return undefined;
  return {
    source,
    jobId,
    state,
    ...(typeof metadata.exit === "number" ? { exit: metadata.exit } : {}),
    text: unwrapReport(stringValue(payload.text) ?? ""),
  };
}

/**
 * OpenCode's opening `<shell …>`/`<subagent …>` tag. Attribute values are
 * quoted and can hold a `>`, as in `command="echo hi >&2"`.
 */
const REPORT_OPEN_TAG = /^\s*<(shell|subagent)\b(?:\s+[\w:-]+="[^"]*")*\s*>\s*/;
const REPORT_CLOSE_TAG = /\s*<\/(shell|subagent)>\s*$/;

/** Strips OpenCode's `<shell …>`/`<subagent …>` wrapper from a report. */
export function unwrapReport(text: string): string {
  return text.replace(REPORT_OPEN_TAG, "").replace(REPORT_CLOSE_TAG, "").trim();
}

/**
 * Maps a report to BB's task status. `undefined` means the job is still going
 * (a subagent that went idle with its own background work outstanding) and
 * another report will follow.
 */
export function reportTaskStatus(
  report: BackgroundReport,
): BackgroundTaskStatus | undefined {
  switch (report.state) {
    case "running":
    case "pending":
      return undefined;
    case "completed":
      return report.exit !== undefined && report.exit !== 0
        ? "failed"
        : "completed";
    case "failed":
    case "error":
      return "failed";
    default:
      return "stopped";
  }
}

function shellPresentation(command: string) {
  return withTitle(
    {
      icon: { glyph: "Terminal" },
      label: {
        pending: "Running background command",
        completed: "Background command finished",
      },
    },
    presentationTitle(command),
  );
}

/** OpenCode names the file the background shell streams its output to. */
function shellOutputFile(toolOutput: string): string | undefined {
  return toolOutput.match(/^Output is streaming to: (.+)$/m)?.[1]?.trim();
}

/** A BB background task row for a shell OpenCode moved to the background. */
export function backgroundShellJob(
  shellId: string,
  command: string,
  toolOutput: string,
): BackgroundJob {
  const outputFile = shellOutputFile(toolOutput);
  return {
    key: itemKey(shellId),
    item: {
      type: "backgroundTask",
      familyId: shellId,
      taskType: LOCAL_BASH_TASK_TYPE,
      description: command,
      status: "pending",
      taskStatus: "running",
      skipTranscript: false,
      ...(outputFile ? { outputFile } : {}),
    },
    presentation: shellPresentation(command),
  };
}

/** Keeps a native subagent's delegation row open until its report arrives. */
export function backgroundSubagentJob(
  callId: string,
  item: OpenCodeRecord,
  presentation?: OpenCodeRecord,
): BackgroundJob {
  return {
    key: itemKey(callId, "tool"),
    item,
    ...(presentation ? { presentation } : {}),
  };
}

export function openBackgroundJobDelta(
  job: BackgroundJob,
  providerTurnId: string,
): OpenCodeRecord {
  return {
    kind: "item.open",
    key: job.key,
    item: job.item,
    ...(job.presentation ? { presentation: job.presentation } : {}),
    providerTurnId,
  };
}

/**
 * Closes a background row from OpenCode's report. Background rows are
 * thread-scoped in BB, so the close needs no turn and may land long after the
 * turn that opened the row.
 */
export function settleBackgroundJobDelta(
  job: BackgroundJob,
  report: BackgroundReport,
  taskStatus: BackgroundTaskStatus,
): OpenCodeRecord {
  const status = backgroundTaskItemStatus(taskStatus);
  const item: OpenCodeRecord = { ...job.item };
  if (item.type === "backgroundTask") {
    item.status = status;
    item.taskStatus = taskStatus;
    if (report.text) item.summary = report.text;
    if (status === "failed" && report.exit !== undefined)
      item.error = `Exited with code ${report.exit}`;
  } else if (report.text) {
    item.summary = report.text;
  }
  return {
    kind: "item.close",
    key: job.key,
    status,
    item,
    ...(job.presentation ? { presentation: job.presentation } : {}),
  };
}
