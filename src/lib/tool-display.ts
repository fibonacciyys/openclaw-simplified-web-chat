// Compact tool-call display, ported from the OpenClaw control UI
// (ui/src/ui/tool-display.ts + src/agents/tool-display-common.ts).
// Summarizes a tool name + args into a short label/detail line so the chat
// renders a collapsed tool card instead of dumping raw output.
//
// Config (tool-display.json) is mirrored verbatim from
// apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json so
// every shipped tool keeps its emoji/title/detailKeys. The web-chat is a
// standalone client outside the workspace, so the JSON is copied rather than
// imported across package boundaries.
import CONFIG from "./tool-display.json";

type ToolDisplayActionSpec = {
  label?: string;
  detailKeys?: string[];
};

type SharedToolDisplaySpec = {
  emoji?: string;
  title?: string;
  label?: string;
  detailKeys?: string[];
  actions?: Record<string, ToolDisplayActionSpec>;
};

type SharedToolDisplayConfig = {
  version?: number;
  fallback?: SharedToolDisplaySpec;
  tools?: Record<string, SharedToolDisplaySpec>;
};

const CFG = CONFIG as SharedToolDisplayConfig;
const FALLBACK_DETAIL_KEYS = CFG.fallback?.detailKeys ?? [];
const TOOL_MAP = CFG.tools ?? {};

export type ToolDisplay = {
  name: string;
  icon: string; // emoji
  title: string;
  label: string;
  verb?: string;
  detail?: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  const s = normalizeOptionalString(value);
  return s ? s.toLowerCase() : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeToolName(name?: string): string {
  return (name ?? "tool").trim() || "tool";
}

export function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, " ").trim();
  if (!cleaned) return "Tool";
  const parts: string[] = [];
  for (const part of cleaned.split(/\s+/)) {
    parts.push(
      part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`,
    );
  }
  return parts.join(" ");
}

function normalizeVerb(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? trimmed.replace(/_/g, " ") : undefined;
}

function resolveActionArg(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  return normalizeOptionalString(record.action);
}

type CoerceOpts = {
  includeFalse?: boolean;
  includeZero?: boolean;
  maxStringChars?: number;
  maxArrayEntries?: number;
};

function coerceDisplayValue(value: unknown, opts: CoerceOpts = {}): string | undefined {
  const maxStringChars = opts.maxStringChars ?? 160;
  const maxArrayEntries = opts.maxArrayEntries ?? 3;
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const rawLine = normalizeOptionalString(trimmed.split(/\r?\n/)[0]) ?? "";
    if (!rawLine) return undefined;
    if (rawLine.length > maxStringChars) {
      const half = Math.floor((maxStringChars - 1) / 2);
      return `${rawLine.slice(0, half)}…${rawLine.slice(-(maxStringChars - 1 - half))}`;
    }
    return rawLine;
  }
  if (typeof value === "boolean") {
    if (!value && !opts.includeFalse) return undefined;
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    if (value === 0 && !opts.includeZero) return undefined;
    return String(value);
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    let count = 0;
    for (const item of value) {
      const display = coerceDisplayValue(item, opts);
      if (!display) continue;
      count += 1;
      if (values.length < maxArrayEntries) values.push(display);
    }
    if (count === 0) return undefined;
    const preview = values.join(", ");
    return count > maxArrayEntries ? `${preview}…` : preview;
  }
  return undefined;
}

function lookupValueByPath(args: unknown, path: string): unknown {
  let current: unknown = args;
  for (const segment of path.split(".")) {
    if (!segment) return undefined;
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function resolvePathArg(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  for (const candidate of [record.path, record.file_path, record.filePath]) {
    const s = normalizeOptionalString(candidate);
    if (s) return s;
  }
  return undefined;
}

function resolveReadDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  const path = resolvePathArg(record);
  if (!path) return undefined;
  const offsetRaw = finiteNumber(record.offset);
  const limitRaw = finiteNumber(record.limit);
  const offset = offsetRaw !== undefined ? Math.max(1, Math.floor(offsetRaw)) : undefined;
  const limit = limitRaw !== undefined ? Math.max(1, Math.floor(limitRaw)) : undefined;
  if (offset !== undefined && limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `${unit} ${offset}-${offset + limit - 1} from ${path}`;
  }
  if (offset !== undefined) return `from line ${offset} in ${path}`;
  if (limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `first ${limit} ${unit} of ${path}`;
  }
  return `from ${path}`;
}

function resolveWriteDetail(toolKey: string, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  const path = resolvePathArg(record) ?? normalizeOptionalString(record.url);
  if (!path) return undefined;
  if (toolKey === "attach") return `from ${path}`;
  const destinationPrefix = toolKey === "edit" ? "in" : "to";
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.newText === "string"
        ? record.newText
        : typeof record.new_string === "string"
          ? record.new_string
          : undefined;
  if (content && content.length > 0) return `${destinationPrefix} ${path} (${content.length} chars)`;
  return `${destinationPrefix} ${path}`;
}

function collectWebSearchQueries(record: Record<string, unknown>): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const s = normalizeOptionalString(value);
    if (s && !seen.has(s)) {
      seen.add(s);
      queries.push(s);
    }
  };
  add(record.query);
  add(record.q);
  add(record.search);
  add(record.input);
  add(record.objective);
  for (const key of ["search_query", "image_query", "queries", "search_queries"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string") {
        add(entry);
        continue;
      }
      const r = asRecord(entry);
      if (!r) continue;
      add(r.query);
      add(r.q);
      add(r.search);
    }
  }
  return queries;
}

function resolveWebSearchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  const queries = collectWebSearchQueries(record);
  if (queries.length === 0) return undefined;
  const displayed = queries.slice(0, 3).map((q) => `"${q}"`);
  const queryText =
    queries.length > displayed.length ? `${displayed.join(", ")}…` : displayed.join(", ");
  const countRaw =
    finiteNumber(record.count) ??
    finiteNumber(record.max_results) ??
    finiteNumber(record.num_results) ??
    finiteNumber(record.limit) ??
    finiteNumber(record.top_k);
  const count = countRaw !== undefined && countRaw > 0 ? Math.floor(countRaw) : undefined;
  return count !== undefined ? `for ${queryText} (top ${count})` : `for ${queryText}`;
}

function resolveWebFetchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  const url = normalizeOptionalString(record.url);
  if (!url) return undefined;
  const mode = normalizeOptionalString(record.extractMode);
  const maxCharsRaw = finiteNumber(record.maxChars);
  const maxChars = maxCharsRaw !== undefined && maxCharsRaw > 0 ? Math.floor(maxCharsRaw) : undefined;
  let suffix = "";
  if (mode) suffix = `mode ${mode}`;
  if (maxChars !== undefined) suffix = suffix ? `${suffix}, max ${maxChars} chars` : `max ${maxChars} chars`;
  return suffix ? `from ${url} (${suffix})` : `from ${url}`;
}

function resolveActionSpec(
  spec: SharedToolDisplaySpec | undefined,
  action: string | undefined,
): ToolDisplayActionSpec | undefined {
  if (!spec || !action) return undefined;
  return spec.actions?.[action];
}

function resolveDetailFromKeys(
  args: unknown,
  keys: string[],
  coerce?: CoerceOpts,
): string | undefined {
  for (const key of keys) {
    const display = coerceDisplayValue(lookupValueByPath(args, key), coerce);
    if (display) return display;
  }
  return undefined;
}

function resolveToolVerbAndDetail(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  action?: string;
  spec?: SharedToolDisplaySpec;
}): { verb?: string; detail?: string } {
  const actionSpec = resolveActionSpec(params.spec, params.action);
  const fallbackVerb =
    params.toolKey === "web_search"
      ? "search"
      : params.toolKey === "web_fetch"
        ? "fetch"
        : params.toolKey.replace(/_/g, " ").replace(/\./g, " ");
  const verb = normalizeVerb(actionSpec?.label ?? params.action ?? fallbackVerb);

  let detail: string | undefined;
  if (params.toolKey === "read") detail = resolveReadDetail(params.args);
  if (!detail && (params.toolKey === "write" || params.toolKey === "edit" || params.toolKey === "attach"))
    detail = resolveWriteDetail(params.toolKey, params.args);
  if (!detail && params.toolKey === "web_search") detail = resolveWebSearchDetail(params.args);
  if (!detail && params.toolKey === "web_fetch") detail = resolveWebFetchDetail(params.args);

  const detailKeys = actionSpec?.detailKeys ?? params.spec?.detailKeys ?? FALLBACK_DETAIL_KEYS;
  if (!detail && detailKeys.length > 0) {
    detail = resolveDetailFromKeys(params.args, detailKeys, { includeFalse: true, includeZero: true });
  }
  if (!detail && params.meta) detail = params.meta;
  return { verb, detail };
}

function shortenHomeInString(input: string): string {
  if (!input) return input;
  // Browser-safe home shortening (mirrors ui/src/ui/tool-display.ts).
  const patterns = [
    { re: /^\/Users\/[^/]+(\/|$)/, replacement: "~$1" },
    { re: /^\/home\/[^/]+(\/|$)/, replacement: "~$1" },
    { re: /^C:\\Users\\[^\\]+(\\|$)/i, replacement: "~$1" },
  ];
  for (const p of patterns) {
    if (p.re.test(input)) return input.replace(p.re, p.replacement);
  }
  return input;
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = normalizeLowercaseStringOrEmpty(name);
  const spec = TOOL_MAP[key];
  const icon = spec?.emoji ?? CFG.fallback?.emoji ?? "🧩";
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? title;
  const { verb, detail } = resolveToolVerbAndDetail({
    toolKey: key,
    args: params.args,
    meta: params.meta,
    action: resolveActionArg(params.args),
    spec,
  });
  return {
    name,
    icon,
    title,
    label,
    verb,
    detail: detail ? shortenHomeInString(detail) : detail,
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  const detail = display.detail;
  if (!detail) return undefined;
  const normalized = detail.includes(" · ")
    ? detail
        .split(" · ")
        .map((p) => p.trim())
        .filter(Boolean)
        .join(", ")
    : detail;
  return normalized ? `with ${normalized}` : undefined;
}
