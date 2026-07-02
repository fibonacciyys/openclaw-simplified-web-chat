// Tool card extraction + output truncation, ported from the OpenClaw control
// UI (ui/src/ui/chat/tool-cards.ts + ui/src/ui/chat/tool-helpers.ts).
// Pairs tool_use and tool_result blocks by id so the chat can render one
// collapsible card per call instead of a raw output dump.
import type { TranscriptMessage } from "./types";

// Mirrors ui/src/ui/chat/constants.ts. Collapsed previews stay tiny so a long
// tool output never blows up the message bubble.
const PREVIEW_MAX_LINES = 2;
const PREVIEW_MAX_CHARS = 100;

export type ToolCard = {
  id: string;
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
  isError?: boolean;
};

function toBlocks(content: TranscriptMessage["content"]): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object");
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function serializeToolInput(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    if (typeof args === "number" || typeof args === "boolean" || typeof args === "bigint")
      return String(args);
    return Object.prototype.toString.call(args);
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    const parts = item.content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

function readToolErrorFlag(value: Record<string, unknown>): boolean | undefined {
  const raw = value.isError ?? value.is_error;
  return typeof raw === "boolean" ? raw : undefined;
}

function resolveToolCardId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
  index: number,
  prefix: string,
): string {
  const explicitId =
    (typeof item.id === "string" && item.id.trim()) ||
    (typeof item.toolCallId === "string" && item.toolCallId.trim()) ||
    (typeof item.tool_call_id === "string" && item.tool_call_id.trim()) ||
    (typeof item.callId === "string" && item.callId.trim()) ||
    (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
    (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) ||
    "";
  if (explicitId) return `${prefix}:${explicitId}`;
  const name =
    (typeof item.name === "string" && item.name.trim()) ||
    (typeof message.toolName === "string" && message.toolName.trim()) ||
    (typeof message.tool_name === "string" && message.tool_name.trim()) ||
    "tool";
  return `${prefix}:${name}:${index}`;
}

function isToolCallKind(kind: string, item: Record<string, unknown>): boolean {
  return (
    ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
    (typeof item.name === "string" &&
      (item.arguments != null || item.args != null || item.input != null))
  );
}

function findFirstUnmatchedCard(
  cards: ToolCard[],
  id: string,
  name: string,
  matched: WeakSet<ToolCard>,
): ToolCard | undefined {
  let nameOnlyCandidate: ToolCard | undefined;
  for (const card of cards) {
    if (card.id === id) return card;
    if (!nameOnlyCandidate && card.name === name && card.outputText === undefined && !matched.has(card)) {
      nameOnlyCandidate = card;
    }
  }
  return nameOnlyCandidate;
}

// A message is a "tool message" when its role is tool-like OR it carries a
// top-level tool-call id. Mirrors the control UI's isToolResult gate
// (ui/src/ui/chat/grouped-render.ts: isToolResult). Shared by MessageItem
// (suppress raw output bubble) and groupToolActivities (merge consecutive
// tool messages into one activity card).
export function isToolMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;
  if (!m || typeof m !== "object") return false;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  return (
    role === "tool" ||
    role === "tool_result" ||
    role === "toolresult" ||
    role === "function" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string"
  );
}

// Extract ordered tool cards from a transcript message. tool_use blocks start a
// card; matching tool_result blocks (by id or name) attach the output. Stand-
// alone tool messages (role: tool_result/tool/function) become output-only
// cards. Mirrors ui/src/ui/chat/tool-cards.ts extractToolCards.
export function extractToolCards(message: unknown, prefix = "tool"): ToolCard[] {
  const m = message as Record<string, unknown>;
  if (!m || typeof m !== "object") return [];
  const content = toBlocks(m.content as TranscriptMessage["content"]);
  const messageIsError = readToolErrorFlag(m);
  const cards: ToolCard[] = [];
  const matched = new WeakSet<ToolCard>();

  for (let index = 0; index < content.length; index += 1) {
    const item = content[index] ?? {};
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();

    if (isToolCallKind(kind, item)) {
      const args = coerceArgs(item.arguments ?? item.args ?? item.input);
      cards.push({
        id: resolveToolCardId(item, m, index, prefix),
        name: typeof item.name === "string" ? item.name : "tool",
        args,
        inputText: serializeToolInput(args),
      });
      continue;
    }

    if (kind === "toolresult" || kind === "tool_result") {
      const name = typeof item.name === "string" ? item.name : "tool";
      const cardId = resolveToolCardId(item, m, index, prefix);
      const existing = findFirstUnmatchedCard(cards, cardId, name, matched);
      const text = extractToolText(item);
      const isError = readToolErrorFlag(item) ?? messageIsError;
      if (existing) {
        matched.add(existing);
        existing.outputText = text;
        if (isError !== undefined) existing.isError = isError;
        continue;
      }
      cards.push({
        id: cardId,
        name,
        outputText: text,
        ...(isError !== undefined ? { isError } : {}),
      });
    }
  }

  const standaloneTool =
    isToolMessage(m) ||
    typeof m.toolName === "string" ||
    typeof m.tool_name === "string";
  if (standaloneTool && cards.length === 0) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = typeof m.text === "string" && m.text.trim() ? m.text : extractToolText(m);
    cards.push({
      id: resolveToolCardId({}, m, 0, prefix),
      name,
      outputText: text,
      ...(messageIsError !== undefined ? { isError: messageIsError } : {}),
    });
  }

  return cards;
}

// Truncate tool output to a tiny collapsed preview (first N lines, then first
// N chars). Mirrors ui/src/ui/chat/tool-helpers.ts getTruncatedPreview.
export function getTruncatedPreview(text: string): string {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return `${preview.slice(0, PREVIEW_MAX_CHARS)}…`;
  }
  return lines.length < allLines.length ? `${preview}…` : preview;
}

const TOOL_NOT_FOUND_PATTERN = /^tool not found\.?$/i;
const TOOL_ERROR_STATUSES = new Set(["error", "failed", "timeout"]);

// Best-effort error detection for tool output, mirrors isToolErrorOutput.
export function isToolErrorOutput(outputText: string | undefined): boolean {
  if (!outputText) return false;
  const trimmed = outputText.trim();
  if (!trimmed) return false;
  if (TOOL_NOT_FOUND_PATTERN.test(trimmed)) return true;
  if (trimmed.length > 20_000) return false;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const obj = asRecord(parsed);
  if (!obj) return false;
  const explicit = readToolErrorFlag(obj);
  if (explicit !== undefined) return explicit;
  if ("error" in obj) {
    const value = obj.error;
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "boolean") return value;
    if (value && typeof value === "object") return true;
  }
  if (typeof obj.status === "string" && TOOL_ERROR_STATUSES.has(obj.status.trim().toLowerCase()))
    return true;
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function isToolCardError(card: ToolCard): boolean {
  if (card.isError !== undefined) return card.isError;
  return isToolErrorOutput(card.outputText);
}
