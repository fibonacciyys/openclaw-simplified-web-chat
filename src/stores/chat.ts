// Chat store: per-session transcript, streaming state, send/abort/history.
// Event handling mirrors ui/src/ui/controllers/chat.ts (handleChatEvent).
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  extractText,
  isSilentReply,
  shouldHideHistoryMessage,
} from "../lib/extract-text";
import type {
  ChatEventPayload,
  ChatHistoryResult,
  ContentBlock,
  TranscriptMessage,
} from "../lib/types";
import { useConnectionStore } from "./connection";

function asTranscriptMessage(message: unknown): TranscriptMessage | null {
  if (!message || typeof message !== "object") return null;
  return message as TranscriptMessage;
}

function isAssistantSilent(message: unknown): boolean {
  return isSilentReply(extractText(message));
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

function synthesizeAssistant(text: string): TranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }] as ContentBlock[],
    timestamp: Date.now(),
  };
}

// Resolves the streaming chat text from a v4 `chat` delta event.
// Mirrors ui/src/ui/controllers/chat.ts resolveDeltaChatStreamText: the server
// may send an incremental `deltaText` chunk, a cumulative `message` snapshot,
// or a full-content refresh (`replace: true`).
function resolveDeltaChatStreamText(
  currentStream: string | null,
  payload: ChatEventPayload,
): string | null {
  const snapshot = payload.message == null ? null : extractText(payload.message);
  if (typeof payload.deltaText === "string") {
    if (payload.replace === true) {
      return payload.deltaText;
    }
    if (currentStream === null) {
      return typeof snapshot === "string" ? snapshot : payload.deltaText;
    }
    if (typeof snapshot === "string") {
      const prefixLength = snapshot.length - payload.deltaText.length;
      if (
        prefixLength !== currentStream.length ||
        snapshot.slice(0, prefixLength) !== currentStream
      ) {
        return snapshot;
      }
    }
    return `${currentStream}${payload.deltaText}`;
  }
  return typeof snapshot === "string" ? snapshot : null;
}

const SESSION_KEY_STORAGE = "openclaw-webchat-session-v1";

function readPersistedSessionKey(): string {
  try {
    const raw = localStorage.getItem(SESSION_KEY_STORAGE);
    if (raw && raw.trim()) return raw;
  } catch {
    // ignore
  }
  return "main";
}

export const useChatStore = defineStore("chat", () => {
  const sessionKey = ref(readPersistedSessionKey());
  const messages = ref<TranscriptMessage[]>([]);
  const chatStream = ref<string | null>(null);
  const chatRunId = ref<string | null>(null);
  const chatSending = ref(false);
  const lastError = ref<string | null>(null);
  const currentSessionId = ref<string | undefined>(undefined);

  const isBusy = computed(() => chatSending.value || chatRunId.value !== null);

  async function loadHistory(): Promise<void> {
    const c = useConnectionStore().getClient();
    if (!c) return;
    try {
      const res = await c.request<ChatHistoryResult>("chat.history", {
        sessionKey: sessionKey.value,
        limit: 200,
      });
      const visible = (res.messages ?? []).filter((m) => !shouldHideHistoryMessage(m));
      messages.value = visible;
      currentSessionId.value = res.sessionId;
      chatStream.value = null;
      chatRunId.value = null;
      chatSending.value = false;
    } catch (err) {
      lastError.value = errorMessage(err);
    }
  }

  async function setSession(key: string): Promise<void> {
    sessionKey.value = key;
    try {
      localStorage.setItem(SESSION_KEY_STORAGE, key);
    } catch {
      // ignore
    }
    chatRunId.value = null;
    chatStream.value = null;
    chatSending.value = false;
    lastError.value = null;
    messages.value = [];
    await loadHistory();
  }

  async function send(text: string): Promise<void> {
    const c = useConnectionStore().getClient();
    if (!c) {
      lastError.value = "not connected";
      return;
    }
    const message = text.trim();
    if (!message || isBusy.value) return;
    // Optimistic user message so the UI updates immediately.
    const userMessage: TranscriptMessage = {
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    messages.value = [...messages.value, userMessage];
    const runId = crypto.randomUUID();
    chatRunId.value = runId;
    chatStream.value = "";
    chatSending.value = true;
    lastError.value = null;
    try {
      await c.request("chat.send", {
        sessionKey: sessionKey.value,
        message,
        deliver: false,
        idempotencyKey: runId,
        ...(currentSessionId.value ? { sessionId: currentSessionId.value } : {}),
      });
      // Ack received. The assistant reply streams in via `chat` events.
    } catch (err) {
      chatSending.value = false;
      chatRunId.value = null;
      chatStream.value = null;
      const msg = errorMessage(err);
      lastError.value = msg;
      messages.value = [
        ...messages.value,
        synthesizeAssistant(`_send failed: ${msg}_`),
      ];
    }
  }

  async function abort(): Promise<void> {
    const c = useConnectionStore().getClient();
    if (!c) return;
    try {
      await c.request("chat.abort", {
        sessionKey: sessionKey.value,
        ...(chatRunId.value ? { runId: chatRunId.value } : {}),
      });
    } catch (err) {
      lastError.value = errorMessage(err);
    }
  }

  // Drives live updates during a run (delta/final/aborted/error).
  function handleChatEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const p = payload as ChatEventPayload;
    const applies =
      p.sessionKey === sessionKey.value ||
      (typeof p.runId === "string" && p.runId === chatRunId.value);

    if (!applies) {
      // Cross-run final (e.g. sub-agent announce): append the final message.
      if (p.state === "final" && p.runId !== chatRunId.value) {
        const msg = asTranscriptMessage(p.message);
        if (msg && !isAssistantSilent(msg)) {
          messages.value = [...messages.value, msg];
        }
      }
      return;
    }

    if (p.state === "delta") {
      const next = resolveDeltaChatStreamText(chatStream.value, p);
      if (next && !isSilentReply(next)) chatStream.value = next;
      return;
    }

    if (p.state === "final") {
      const finalMessage = asTranscriptMessage(p.message);
      if (finalMessage && !isAssistantSilent(finalMessage)) {
        messages.value = [...messages.value, finalMessage];
      } else if (chatStream.value && chatStream.value.trim() && !isSilentReply(chatStream.value)) {
        messages.value = [...messages.value, synthesizeAssistant(chatStream.value)];
      }
      chatStream.value = null;
      chatRunId.value = null;
      chatSending.value = false;
      return;
    }

    if (p.state === "aborted") {
      if (chatStream.value && chatStream.value.trim()) {
        messages.value = [
          ...messages.value,
          synthesizeAssistant(`${chatStream.value}\n\n_(aborted)_`),
        ];
      }
      chatStream.value = null;
      chatRunId.value = null;
      chatSending.value = false;
      return;
    }

    if (p.state === "error") {
      chatStream.value = null;
      chatRunId.value = null;
      chatSending.value = false;
      lastError.value = p.errorMessage ?? "chat error";
    }
  }

  // session.message events: reload history to stay in sync, but only when no
  // run is active (otherwise we would clobber the live stream).
  async function handleSessionMessage(payload: unknown): Promise<void> {
    if (chatRunId.value) return;
    const p = payload as { sessionKey?: string } | undefined;
    if (p && typeof p.sessionKey === "string" && p.sessionKey !== sessionKey.value) return;
    await loadHistory();
  }

  return {
    sessionKey,
    messages,
    chatStream,
    chatRunId,
    chatSending,
    lastError,
    isBusy,
    loadHistory,
    setSession,
    send,
    abort,
    handleChatEvent,
    handleSessionMessage,
  };
});
