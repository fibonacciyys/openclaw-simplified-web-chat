// Thinking-level resolution for the chat picker.
//
// Ports the control UI logic in ui/src/ui/chat/session-controls.ts
// (resolveThinkingLevelOptions + resolveChatThinkingSelectState) and
// ui/src/ui/thinking.ts / thinking-labels.ts, trimmed to the surfaces this
// client renders. The gateway sends per-row `thinkingLevels`, `thinkingOptions`,
// `thinkingDefault`, and the persisted `thinkingLevel` override; this module
// turns them into the option list and bound value for a <select>.
import type {
  ModelCatalogEntry,
  SessionRow,
  SessionsDefaults,
  ThinkingLevelOption,
} from "./types";

// Canonical thinking level ids (docs/tools/thinking.md).
const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

/** Lowercase + collapse whitespace/underscores/hyphens for tolerant matching. */
function normalizeLowercaseStringOrEmpty(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Map freeform thinking strings to canonical ids. Mirrors ui/src/ui/thinking.ts. */
export function normalizeThinkLevel(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const key = normalizeLowercaseStringOrEmpty(raw);
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") return "adaptive";
  if (collapsed === "max") return "max";
  if (collapsed === "xhigh" || collapsed === "extrahigh") return "xhigh";
  if (key === "off" || key === "none") return "off";
  if (["on", "enable", "enabled"].includes(key)) return "low";
  if (["min", "minimal"].includes(key)) return "minimal";
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) return "low";
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest"].includes(key)) {
    return "high";
  }
  if (key === "think") return "minimal";
  return undefined;
}

/** Normalize a picker option value to its canonical id, or the lowercased raw. */
export function normalizeThinkingOptionValue(raw: string): string {
  return normalizeThinkLevel(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}

/** Base 5 levels used when the gateway sent no per-model profile. */
export function listThinkingLevelLabels(): readonly string[] {
  return BASE_THINKING_LEVELS;
}

/** Resolve the default level for a model from the catalog's reasoning flag. */
export function resolveThinkingDefaultForModel(params: {
  provider: string | null | undefined;
  model: string | null | undefined;
  catalog?: readonly ModelCatalogEntry[];
}): string {
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  return candidate?.reasoning ? "low" : "off";
}

function formatThinkingLevelDisplayLabel(value: string): string {
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (["on", "enable", "enabled"].includes(raw)) return "On";
  const normalized = normalizeThinkingOptionValue(value);
  switch (normalized) {
    case "adaptive":
      return "Adaptive";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

/** Label for the first picker option: the clear-override / inherited choice. */
export function formatInheritedThinkingLabel(effectiveLevel: string | null | undefined): string {
  const normalized = effectiveLevel ? normalizeThinkingOptionValue(effectiveLevel) : "off";
  return `Inherited: ${formatThinkingLevelDisplayLabel(normalized)}`;
}

/** Label for an explicit override option. */
export function formatThinkingOverrideLabel(value: string, label?: string | null): string {
  const normalized = normalizeThinkingOptionValue(value);
  if (!normalized || normalized === "off") return "Off";
  return formatThinkingLevelDisplayLabel(label?.trim() || normalized);
}

function isOffThinkingOption(value: string | null | undefined): boolean {
  return normalizeThinkingOptionValue(value ?? "") === "off";
}

function isOffOnlyThinkingLevels(levels: readonly ThinkingLevelOption[]): boolean {
  return levels.every((level) => isOffThinkingOption(level.id || level.label));
}

/** True when the session row's model matches the configured defaults. */
export function sessionModelMatchesDefaults(
  session: Pick<SessionRow, "model" | "modelProvider"> | null | undefined,
  defaults: SessionsDefaults | null | undefined,
): boolean {
  return (
    (!session?.modelProvider || session.modelProvider === defaults?.modelProvider) &&
    (!session?.model || session.model === defaults?.model)
  );
}

export type ThinkingSelectOption = {
  value: string;
  label: string;
};

export type ThinkingSelectState = {
  // Bound <select> value. "" means inherited (no per-session override).
  currentValue: string;
  // First option is always the clear-override "Inherited: ..." choice.
  options: ThinkingSelectOption[];
  defaultLabel: string;
};

/**
 * Resolve the level list for the picker. Returns [] when the selected model
 * is non-reasoning and only exposes an off level — in that case the picker
 * shows only the inherited default. Mirrors resolveThinkingLevelOptions.
 */
function resolveThinkingLevelOptions(params: {
  activeRow: SessionRow | undefined;
  defaults: SessionsDefaults | null | undefined;
  provider: string | null;
  model: string | null;
  catalog: readonly ModelCatalogEntry[];
}): ThinkingLevelOption[] {
  const { activeRow, defaults, provider, model, catalog } = params;
  const modelMatchesDefaults = sessionModelMatchesDefaults(activeRow, defaults);
  const catalogEntry =
    provider && model
      ? catalog.find((entry) => entry.provider === provider && entry.id === model)
      : undefined;

  const explicitLevels =
    (activeRow?.thinkingLevels?.length ? activeRow.thinkingLevels : null) ??
    (modelMatchesDefaults && defaults?.thinkingLevels?.length
      ? defaults.thinkingLevels
      : null);
  if (explicitLevels) {
    // Non-reasoning model whose only level is off: hide the picker body.
    if (catalogEntry?.reasoning === false && isOffOnlyThinkingLevels(explicitLevels)) {
      return [];
    }
    return explicitLevels;
  }

  const explicitLabels =
    (activeRow?.thinkingOptions?.length ? activeRow.thinkingOptions : null) ??
    (modelMatchesDefaults && defaults?.thinkingOptions?.length
      ? defaults.thinkingOptions
      : null);
  if (catalogEntry?.reasoning === false) {
    if (!explicitLabels || explicitLabels.every(isOffThinkingOption)) {
      return [];
    }
  }

  const labels = explicitLabels ?? listThinkingLevelLabels();
  return labels.map((label) => ({
    id: normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label),
    label,
  }));
}

function pushUniqueTrimmedOption(
  options: ThinkingSelectOption[],
  seen: Set<string>,
  value: string,
  labelForValue: (trimmed: string) => string,
): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const key = normalizeLowercaseStringOrEmpty(trimmed);
  if (seen.has(key)) return;
  seen.add(key);
  options.push({ value: trimmed, label: labelForValue(trimmed) });
}

function buildThinkingOptions(
  levels: readonly ThinkingLevelOption[],
  currentOverride: string,
): ThinkingSelectOption[] {
  const seen = new Set<string>();
  const options: ThinkingSelectOption[] = [];
  const addOption = (value: string, label?: string) => {
    const normalizedValue = normalizeThinkingOptionValue(value);
    pushUniqueTrimmedOption(options, seen, normalizedValue, () =>
      formatThinkingOverrideLabel(normalizedValue, label),
    );
  };
  for (const level of levels) {
    addOption(level.id, level.label);
  }
  if (currentOverride) {
    addOption(currentOverride);
  }
  return options;
}

/**
 * Resolve the full picker state for the active session. Mirrors
 * resolveChatThinkingSelectState in the control UI.
 */
export function resolveThinkingSelectState(params: {
  activeRow: SessionRow | undefined;
  defaults: SessionsDefaults | null | undefined;
  provider: string | null;
  model: string | null;
  catalog: readonly ModelCatalogEntry[];
  // Optimistic override cache from the store (string = set, null = cleared).
  override: string | null | undefined;
}): ThinkingSelectState {
  const { activeRow, defaults, provider, model, catalog, override } = params;
  const levels = resolveThinkingLevelOptions({
    activeRow,
    defaults,
    provider,
    model,
    catalog,
  });

  // Persisted override from the authoritative session row, or the optimistic
  // override cache while a sessions.patch is in flight.
  const persisted = activeRow?.thinkingLevel;
  const fromRow =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const fromOverride =
    override === null ? "" : override ? (normalizeThinkLevel(override) ?? override) : "";
  const currentOverride = fromOverride || fromRow;

  const defaultFromSessionDefaults =
    (!activeRow || sessionModelMatchesDefaults(activeRow, defaults)) && defaults?.thinkingDefault
      ? defaults.thinkingDefault
      : undefined;
  const defaultLevel =
    activeRow?.thinkingDefault ??
    defaultFromSessionDefaults ??
    resolveThinkingDefaultForModel({ provider, model, catalog });

  // When the model exposes no levels (non-reasoning off-only), collapse an
  // explicit off override back to "" so the picker shows the inherited default.
  const effectiveOverride =
    levels.length === 0 && currentOverride === "off" ? "" : currentOverride;

  return {
    currentValue: effectiveOverride,
    defaultLabel: formatInheritedThinkingLabel(defaultLevel),
    options: buildThinkingOptions(levels, effectiveOverride),
  };
}
