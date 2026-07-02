// Group consecutive tool messages into a single "tool activity" so the chat
// renders one collapsed "Activity: N tools" card instead of N separate tool
// bubbles. Ported from ui/src/ui/chat/build-chat-items.ts groupMessages,
// scoped to tool merging: user/assistant messages stay per-item (the web-chat
// is single-user, so the control UI's sender-label split does not apply).
import type { TranscriptMessage } from "./types";
import { isToolMessage } from "./tool-cards";

export type ChatViewItem =
  | { kind: "message"; message: TranscriptMessage; key: string }
  | { kind: "tool-activity"; messages: TranscriptMessage[]; key: string };

// Walk the transcript and collapse runs of consecutive tool messages into
// tool-activity items. A lone tool message stays a single "message" item so it
// renders exactly like before (one tool card); only runs of 2+ merge.
export function groupToolActivities(messages: TranscriptMessage[]): ChatViewItem[] {
  const result: ChatViewItem[] = [];
  let buffer: TranscriptMessage[] = [];
  let index = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      result.push({ kind: "message", message: buffer[0]!, key: `m${index}` });
    } else {
      result.push({ kind: "tool-activity", messages: [...buffer], key: `a${index}` });
    }
    index += 1;
    buffer = [];
  };

  for (const message of messages) {
    if (isToolMessage(message)) {
      buffer.push(message);
    } else {
      flush();
      result.push({ kind: "message", message, key: `m${index}` });
      index += 1;
    }
  }
  flush();
  return result;
}
