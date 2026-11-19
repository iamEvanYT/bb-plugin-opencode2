import {
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
} from "@get-bb/plugin-sdk/provider-bridge";
import { emit, requestRuntime } from "./bridge-runtime.ts";
import {
  approvalPermissionReply,
  automaticPermissionReply,
  permissionReplyBody,
} from "./prompt.ts";
import { itemKey } from "./timeline.ts";
import {
  errorMessage,
  inputRecord,
  stringValue,
  type ActiveTurn,
  type OpenCodePermissionReply,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;
type RequestOpenCode = (
  path: string,
  init?: RequestInit,
) => Promise<RecordValue>;

type FieldAnswer = {
  value: string | number | boolean | string[];
  /** How the answer reads in the question row's summary. */
  text: string;
};

/**
 * The form fields BB asks, capped at BB's question limit. Hidden fields keep
 * OpenCode's defaults and are never shown.
 */
export function askableFields(form: RecordValue): RecordValue[] {
  return (Array.isArray(form.fields) ? form.fields : [])
    .map(inputRecord)
    .filter((field) => field.hidden !== true)
    .slice(0, USER_QUESTION_MAX_QUESTIONS);
}

function fieldKey(field: RecordValue): string {
  return String(field.key ?? field.title ?? "q");
}

/**
 * OpenCode accepts a reply without any field not marked required, but its
 * question tool never marks one, and the model expects an answer to each.
 * Only an explicit `required: false` lets the user skip.
 */
function isRequired(field: RecordValue): boolean {
  return field.required !== false;
}

export function bbQuestion(field: RecordValue) {
  const options = Array.isArray(field.options)
    ? field.options
        .slice(0, USER_QUESTION_MAX_OPTIONS)
        .map((value: unknown) => {
          const option = inputRecord(value);
          return {
            label: stringValue(option.label) ?? String(option.value ?? ""),
            value: String(option.value ?? option.label ?? ""),
            ...(stringValue(option.description)
              ? { description: stringValue(option.description) }
              : {}),
          };
        })
    : undefined;
  return {
    id: fieldKey(field),
    prompt:
      stringValue(field.description) ?? stringValue(field.title) ?? "Question",
    ...(stringValue(field.title)
      ? { shortLabel: stringValue(field.title) }
      : {}),
    multiSelect: field.type === "multiselect",
    allowFreeText: field.custom !== false,
    required: isRequired(field),
    ...(options?.length ? { options } : {}),
  };
}

/** One field's answer in OpenCode's type, or undefined if none was given. */
function fieldAnswer(
  field: RecordValue,
  entry: unknown,
): FieldAnswer | undefined {
  const { selected, freeText } = inputRecord(entry);
  const picked: string[] = Array.isArray(selected)
    ? selected.map(String).filter((value) => value.length > 0)
    : [];
  const typed = stringValue(freeText);
  if (field.type === "multiselect") {
    const values = [...(typed ? [typed] : []), ...picked];
    return values.length
      ? { value: values, text: values.join(", ") }
      : undefined;
  }
  const raw = (typed ?? picked[0] ?? "").trim();
  if (!raw) return undefined;
  if (field.type === "boolean") {
    const value = ["true", "yes", "y", "1"].includes(raw.toLowerCase());
    return { value, text: String(value) };
  }
  if (field.type === "number" || field.type === "integer") {
    const numeric = Number(raw);
    return { value: Number.isFinite(numeric) ? numeric : raw, text: raw };
  }
  return { value: typed ?? picked[0], text: typed ?? picked[0] };
}

/**
 * OpenCode's form reply for BB's answers, with a summary for the question row.
 * Undefined when the user dismissed the question or skipped a required field.
 */
export function formReply(
  fields: readonly RecordValue[],
  answers: RecordValue | undefined,
): { answer: RecordValue; summary: string } | undefined {
  if (!answers) return undefined;
  const answer: RecordValue = {};
  const summary: string[] = [];
  for (const field of fields) {
    const given = fieldAnswer(field, answers[fieldKey(field)]);
    if (given) {
      answer[fieldKey(field)] = given.value;
      summary.push(given.text);
    } else if (isRequired(field)) {
      return undefined;
    }
  }
  return { answer, summary: summary.join("\n") };
}

export class OpenCodeInteractions {
  constructor(
    private readonly request: RequestOpenCode,
    private readonly emitTimeline: typeof emit = emit,
  ) {}

  /**
   * Never rejects: a reply can 404 when the request was already answered
   * elsewhere (another client, or OpenCode cancelled it), and an unhandled
   * rejection would take the whole bridge process down.
   */
  async handlePermission(session: SessionState, data: RecordValue) {
    try {
      await this.resolvePermission(session, data);
    } catch (error) {
      process.stderr.write(
        `[opencode2] Could not answer an OpenCode permission request: ${errorMessage(error)}\n`,
      );
    }
  }

  private async resolvePermission(session: SessionState, data: RecordValue) {
    const active = session.active;
    if (!active) return;
    const sessionId = stringValue(data.sessionID);
    const requestId = stringValue(data.id);
    if (!sessionId || !requestId) return;
    const action = stringValue(data.action) ?? "";
    const automaticReply = automaticPermissionReply(
      session.permissionMode,
      session.disableSubagents,
      action,
    );
    if (automaticReply) {
      await this.replyPermission(sessionId, requestId, automaticReply);
      return;
    }
    const tool = action || "OpenCode permission";
    const message = stringValue(data.message);
    const source = inputRecord(data.source);
    const payload = {
      kind: "approval",
      subject: {
        kind: "tool_use",
        itemId: stringValue(source.id) ?? requestId,
        tool,
        presentation: {
          label: {
            pending: "Requesting permission",
            completed: "Permission handled",
          },
          icon: { glyph: "Shield" },
          ...(presentationTitle(tool)
            ? { title: presentationTitle(tool) }
            : {}),
          ...(message ? { detail: presentationDetail(message) } : {}),
        },
      },
      reason: message ?? null,
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    };
    try {
      const result = await requestRuntime(
        "interaction/request",
        {
          providerThreadId: session.providerThreadId,
          threadId: session.bbThreadId,
          turnId: active.providerTurnId,
          payload,
        },
        { signal: active.abortController.signal },
      );
      const decision = result?.resolution?.decision;
      const reply =
        session.active === active
          ? approvalPermissionReply(decision)
          : "reject";
      await this.replyPermission(sessionId, requestId, reply);
    } catch {
      await this.replyPermission(sessionId, requestId, "reject").catch(
        () => {},
      );
    }
  }

  private async replyPermission(
    sessionId: string,
    requestId: string,
    decision: OpenCodePermissionReply,
  ) {
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify(permissionReplyBody(decision)),
      },
    );
  }

  private async questionForm(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
  ): Promise<RecordValue | undefined> {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (session.active !== active || !active.opened.has(callId))
        return undefined;
      const result = await this.request(
        `/api/session/${encodeURIComponent(session.providerThreadId)}/form`,
      ).catch(() => undefined);
      const forms = (Array.isArray(result?.data) ? result.data : []).map(
        inputRecord,
      );
      const match = forms.find((form) => {
        const metadata = inputRecord(form.metadata);
        const tool = inputRecord(metadata.tool);
        return tool.id === callId;
      });
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return undefined;
  }

  async cancelQuestionForm(session: SessionState, formId: string) {
    await this.request(
      `/api/session/${encodeURIComponent(session.providerThreadId)}/form/${encodeURIComponent(formId)}`,
      { method: "DELETE" },
    ).catch(() => {});
  }

  private closeQuestion(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    status: "completed" | "failed",
    text: string,
  ) {
    const item = active.opened.get(callId) ?? {
      type: "tool",
      tool: "question",
      args: {},
    };
    if (status === "completed") item.result = text;
    else item.error = text;
    active.opened.delete(callId);
    active.openQuestions.delete(callId);
    active.settledTools.add(callId);
    this.emitTimeline(session.bbThreadId, [
      {
        kind: "item.close",
        key: itemKey(callId, "tool"),
        status,
        ...(status === "completed" ? { resultText: text } : {}),
        item,
        providerTurnId: active.providerTurnId,
      },
    ]);
  }

  async handleQuestion(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
  ) {
    const form = await this.questionForm(session, active, callId);
    if (session.active !== active || !active.opened.has(callId)) return;
    if (!form) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question went unanswered (no prompt received)",
      );
      return;
    }
    const formId = stringValue(form.id);
    if (!formId) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question did not include a form ID",
      );
      return;
    }
    active.openQuestions.set(callId, formId);
    const fields = askableFields(form);
    if (!fields.length) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question had no prompts",
      );
      return;
    }
    let resolution: RecordValue | undefined;
    try {
      const result = await requestRuntime(
        "interaction/request",
        {
          providerThreadId: session.providerThreadId,
          threadId: session.bbThreadId,
          turnId: active.providerTurnId,
          payload: { kind: "user_question", questions: fields.map(bbQuestion) },
        },
        { signal: active.abortController.signal },
      );
      resolution = result?.resolution;
    } catch {
      resolution = undefined;
    }
    if (session.active !== active || !active.opened.has(callId)) return;
    const reply = formReply(
      fields,
      resolution?.kind === "user_answer" ? resolution.answers : undefined,
    );
    if (!reply) {
      await this.cancelQuestionForm(session, formId);
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "Question dismissed",
      );
      return;
    }
    try {
      await this.request(
        `/api/session/${encodeURIComponent(session.providerThreadId)}/form/${encodeURIComponent(formId)}/reply`,
        { method: "POST", body: JSON.stringify({ answer: reply.answer }) },
      );
    } catch (error) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        errorMessage(error),
      );
      return;
    }
    this.closeQuestion(session, active, callId, "completed", reply.summary);
  }
}
