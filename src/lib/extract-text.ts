// Extracts renderable text from a transcript message.
// Mirrors the control UI flow: assistant text prefers `final_answer`-phase
// text blocks; other roles read raw text content. See
// ui/src/ui/chat/message-extract.ts and src/shared/chat-message-content.ts.
import type { ContentBlock, TranscriptMessage } from "./types";

type Block = ContentBlock;

function toBlocks(content: TranscriptMessage["content"]): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content as Block[];
  return [];
}

function parsePhase(signature: unknown): string | null {
  if (typeof signature !== "string" || !signature) return null;
  try {
    const value = JSON.parse(signature) as { phase?: unknown };
    return typeof value.phase === "string" ? value.phase : null;
  } catch {
    return null;
  }
}

function textBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => b && b.type === "text" && typeof b.text === "string");
}

function extractRawText(message: TranscriptMessage): string | null {
  const blocks = toBlocks(message.content);
  const joined = textBlocks(blocks)
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  if (joined) return joined;
  if (typeof message.text === "string" && message.text.trim()) return message.text;
  return null;
}

function extractAssistantText(message: TranscriptMessage): string | null {
  const blocks = toBlocks(message.content);
  const texts = textBlocks(blocks);
  const finalAnswer = texts.filter((b) => parsePhase(b.textSignature) === "final_answer");
  const chosen = finalAnswer.length > 0 ? finalAnswer : texts;
  const joined = chosen
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  return joined || extractRawText(message);
}

// Used for streaming deltas (returns the cumulative partial text).
export function extractText(message: unknown): string | null {
  const m = message as TranscriptMessage;
  if (!m || typeof m !== "object") return null;
  const role = typeof m.role === "string" ? m.role : "";
  const raw = role === "assistant" ? extractAssistantText(m) : extractRawText(m);
  return raw && raw.trim() ? raw : null;
}

// Used for final/history messages (markdown string to render).
export function extractMessageMarkdown(message: unknown): string | null {
  return extractText(message);
}

export function isSilentReply(text: string | null): boolean {
  const trimmed = (text ?? "").trim().toLowerCase();
  return trimmed === "" || trimmed === "no_reply";
}

// Hide silent assistant replies and empty user messages from history, matching
// the control UI's shouldHideHistoryMessage behavior (simplified).
export function shouldHideHistoryMessage(message: unknown): boolean {
  const m = message as TranscriptMessage;
  if (!m || typeof m !== "object") return false;
  const role = (typeof m.role === "string" ? m.role : "").toLowerCase();
  const text = extractText(m);
  if (role === "assistant" && isSilentReply(text)) return true;
  if (role === "user" && !text) return true;
  return false;
}
