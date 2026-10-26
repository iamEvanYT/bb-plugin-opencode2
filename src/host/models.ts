import { AGENT_OPTION_ID, DEFAULT_AGENT } from "../settings-contract.ts";
import {
  inputRecord,
  stringValue,
  type ModelRef,
  type OpenCodeRecord,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

function parseModel(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  const hash = value.indexOf("#", slash + 1);
  return {
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1, hash === -1 ? undefined : hash),
    ...(hash === -1 ? {} : { variant: value.slice(hash + 1) }),
  };
}

/**
 * BB sends the selected model as `options.model` (`provider/model[#variant]`)
 * and the selected reasoning effort as `options.reasoningLevel` (`low`,
 * `high`, ...). OpenCode has no separate reasoning field: reasoning effort is
 * a named model variant (`provider/model#variant`). Combine both BB fields
 * into a single OpenCode `Model.Ref` so the effort picker actually reaches
 * the OpenCode thread. An explicit `reasoningLevel` wins over a `#variant`
 * suffix because it reflects the current picker state.
 */
export function modelRefFromOptions(options: unknown): ModelRef | undefined {
  const opts = inputRecord(options);
  const parsed = parseModel(opts.model);
  if (!parsed || !parsed.providerID || !parsed.id) return undefined;
  const level = stringValue(opts.reasoningLevel);
  const variant = level || parsed.variant;
  return {
    providerID: parsed.providerID,
    id: parsed.id,
    ...(variant ? { variant } : {}),
  };
}

/**
 * `POST /api/session/{id}/model` switches the model used by subsequent turns.
 * The prompt endpoint itself accepts no model, so per-turn model or reasoning
 * changes must go through this endpoint before prompting.
 */
export function modelId(model: ModelRef): string {
  return `${model.providerID}/${model.id}`;
}

export function assertModelEnabled(
  model: ModelRef | undefined,
  enabledModels: ReadonlySet<string> | null,
): void {
  if (model && enabledModels !== null && !enabledModels.has(modelId(model))) {
    throw new Error(`OpenCode model is disabled: ${modelId(model)}`);
  }
}

export function modelSwitchRequest(sessionId: string, model: ModelRef) {
  return {
    path: `/api/session/${encodeURIComponent(sessionId)}/model`,
    init: { method: "POST", body: JSON.stringify({ model }) },
  };
}

export function sameModelRef(
  a: ModelRef | undefined,
  b: ModelRef | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.providerID === b.providerID &&
    a.id === b.id &&
    (a.variant ?? undefined) === (b.variant ?? undefined)
  );
}

/**
 * Resolve the model ref for a turn: a full `options.model` wins, otherwise a
 * lone `reasoningLevel` reuses the session's stored base model with the new
 * variant so mid-thread effort changes still reach OpenCode.
 */
export function turnModelRef(
  session: { model?: { providerID: string; id: string; variant?: string } },
  options: unknown,
): ModelRef | undefined {
  const direct = modelRefFromOptions(options);
  if (direct) return direct;
  const opts = inputRecord(options);
  const level = stringValue(opts.reasoningLevel);
  if (level && session.model) {
    return {
      providerID: session.model.providerID,
      id: session.model.id,
      variant: level,
    };
  }
  return undefined;
}

const BB_REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

// OpenCode variant IDs that are not BB levels but mean the same thing. They
// only apply when the model has no variant with the BB level's own name.
const VARIANT_ALIASES: Record<string, (typeof BB_REASONING_LEVELS)[number]> = {
  minimal: "low",
  thinking: "high",
};

export type ModelCatalogEntry = {
  id: string;
  /** BB reasoning level -> OpenCode variant ID, in OpenCode's order. */
  variants: Map<string, string>;
  contextWindow: number | null;
};

export function modelCatalogEntry(model: RecordValue): ModelCatalogEntry {
  const providerId = stringValue(model.providerID) ?? "unknown";
  const id = `${providerId}/${stringValue(model.id) ?? "unknown"}`;
  const variantIds = (Array.isArray(model.variants) ? model.variants : [])
    .map((value: unknown) => stringValue(inputRecord(value).id))
    .filter((value: string | undefined): value is string => !!value);
  const variants = new Map<string, string>();
  for (const variant of variantIds) {
    if ((BB_REASONING_LEVELS as readonly string[]).includes(variant))
      variants.set(variant, variant);
  }
  for (const variant of variantIds) {
    const level = VARIANT_ALIASES[variant];
    if (level && !variants.has(level)) variants.set(level, variant);
  }
  const ordered = new Map(
    BB_REASONING_LEVELS.filter((level) => variants.has(level)).map(
      (level) => [level, variants.get(level)!] as const,
    ),
  );
  const context = inputRecord(model.limit).context;
  return {
    id,
    variants: ordered,
    contextWindow:
      typeof context === "number" && Number.isFinite(context) && context > 0
        ? context
        : null,
  };
}

/**
 * Translate BB's reasoning level on a model ref into the model's actual
 * OpenCode variant. A level the model does not offer is dropped rather than
 * sent, so variant-less models run on their default settings.
 */
export function resolveModelVariant(
  model: ModelRef,
  entry: ModelCatalogEntry | undefined,
): ModelRef {
  if (!entry || !model.variant) return model;
  const variant = entry.variants.get(model.variant);
  return {
    providerID: model.providerID,
    id: model.id,
    ...(variant ? { variant } : {}),
  };
}

/**
 * BB's native per-model session option for choosing OpenCode's primary agent.
 * It is the only way to pick `build` or `plan`, since the provider does not
 * offer BB's own plan mode.
 */
export function agentSessionOption(
  agents: readonly { id: string; description?: string }[],
  current?: string,
) {
  if (agents.length === 0) return undefined;
  const ids = agents.map((agent) => agent.id);
  return {
    type: "select" as const,
    id: AGENT_OPTION_ID,
    label: "Agent",
    description: "OpenCode primary agent",
    value:
      current !== undefined && ids.includes(current)
        ? current
        : ids.includes(DEFAULT_AGENT)
          ? DEFAULT_AGENT
          : ids[0],
    values: agents.map((agent) => ({
      id: agent.id,
      label: agent.id,
      ...(agent.description ? { description: agent.description } : {}),
    })),
  };
}

export function mapModel(
  model: RecordValue,
  isDefault: boolean,
  sessionOptions: readonly NonNullable<
    ReturnType<typeof agentSessionOption>
  >[] = [],
) {
  const entry = modelCatalogEntry(model);
  const providerId = stringValue(model.providerID) ?? "unknown";
  const levels = [...entry.variants.keys()].map((level) => ({
    reasoningEffort: level,
    description: entry.variants.get(level) ?? level,
  }));
  const medium = levels.find((level) => level.reasoningEffort === "medium");
  return {
    id: entry.id,
    model: entry.id,
    displayName: stringValue(model.name) ?? entry.id,
    routeProviderId: providerId,
    description: `OpenCode provider ${providerId}`,
    // BB needs at least one level. A model without variants advertises one
    // placeholder that resolveModelVariant never forwards to OpenCode.
    supportedReasoningEfforts: levels.length
      ? levels
      : [{ reasoningEffort: "medium", description: "Default" }],
    defaultReasoningEffort: (medium ?? levels[0])?.reasoningEffort ?? "medium",
    ...(sessionOptions.length > 0 ? { sessionOptions } : {}),
    isDefault,
  };
}
