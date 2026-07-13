// Thinking store: per-session thinking-level selection via sessions.patch.
//
// Mirrors the control UI (ui/src/ui/chat/session-controls.ts +
// ui/src/ui/views/chat.ts thinking picker): picking a level writes the session
// override immediately via `sessions.patch { thinkingLevel }`, with no need to
// wait for the next send. The first picker option is always the clear-override
// "Inherited: <level>" choice; `null` clears the override so the session falls
// back to the configured/provider default.
//
// This client connects with the Control UI identity
// (src/lib/gateway-client.ts CLIENT_ID = "openclaw-control-ui"), which the
// gateway's webchat session-mutation guard exempts via
// `client.id === CONTROL_UI` (src/gateway/server-methods/sessions.ts:335
// rejectWebchatSessionMutation), so thinking patches go through the same
// exempt path as model patches.
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { resolveThinkingSelectState } from "../lib/thinking";
import type { SessionsPatchResult } from "../lib/types";
import { useChatStore } from "./chat";
import { useConnectionStore } from "./connection";
import { useModelsStore } from "./models";
import { useSessionsStore } from "./sessions";

// Sentinel value used by the <select> option that clears the per-session
// thinking override so the session falls back to the inherited default.
const DEFAULT_THINKING_VALUE = "";

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

export const useThinkingStore = defineStore("thinking", () => {
  const switching = ref(false);
  const error = ref<string | null>(null);
  // Optimistic per-session override: string = set, null = cleared to inherited.
  const overrides = ref<Record<string, string | null>>({});

  function client() {
    const c = useConnectionStore().getClient();
    if (!c) throw new Error("gateway not connected");
    return c;
  }

  // The active session row + defaults, scoped to the current session key.
  // Reused by the resolver to derive the per-model thinking profile.
  const activeRow = computed(() => {
    const chat = useChatStore();
    const sessions = useSessionsStore();
    return sessions.sessions.find((s) => s.key === chat.sessionKey);
  });

  // The (provider, model) the gateway used to compute the row's thinking
  // profile. We read the authoritative row rather than the models store's
  // optimistic override, so the thinking picker only re-levels once the
  // refreshed row arrives (matches the control UI behavior).
  const targetModel = computed<{ provider: string | null; model: string | null }>(() => {
    const sessions = useSessionsStore();
    const row = activeRow.value;
    return {
      provider: row?.modelProvider ?? sessions.defaults?.modelProvider ?? null,
      model: row?.model ?? sessions.defaults?.model ?? null,
    };
  });

  const selectState = computed(() => {
    const chat = useChatStore();
    const sessions = useSessionsStore();
    const models = useModelsStore();
    const key = chat.sessionKey;
    const override = key in overrides.value ? overrides.value[key] : undefined;
    return resolveThinkingSelectState({
      activeRow: activeRow.value,
      defaults: sessions.defaults,
      provider: targetModel.value.provider,
      model: targetModel.value.model,
      catalog: models.catalog,
      override,
    });
  });

  const currentValue = computed(() => selectState.value.currentValue);
  const options = computed(() => selectState.value.options);
  const defaultLabel = computed(() => selectState.value.defaultLabel);
  const isInherited = computed(() => currentValue.value === DEFAULT_THINKING_VALUE);

  async function setThinking(next: string): Promise<void> {
    const chat = useChatStore();
    const sessions = useSessionsStore();
    const key = chat.sessionKey;
    const requested = next.trim();
    // Clearing to inherited: send null so the server drops the override.
    const patchLevel = requested === DEFAULT_THINKING_VALUE ? null : requested;
    const prev = overrides.value[key];
    // Write the override cache immediately so the picker stays in sync during
    // the RPC round-trip.
    overrides.value = { ...overrides.value, [key]: patchLevel };
    switching.value = true;
    error.value = null;
    try {
      await client().request<SessionsPatchResult>("sessions.patch", {
        key,
        thinkingLevel: patchLevel,
      });
      // Refresh the session index so the row's authoritative thinkingLevel
      // field drives the picker, then drop the now-redundant override.
      await sessions.load();
      const nextOverrides = { ...overrides.value };
      delete nextOverrides[key];
      overrides.value = nextOverrides;
    } catch (err) {
      // Roll back so the picker reflects the actual server state.
      const rollback = { ...overrides.value };
      if (prev === undefined) {
        delete rollback[key];
      } else {
        rollback[key] = prev;
      }
      overrides.value = rollback;
      error.value = `Failed to set thinking level: ${errorMessage(err)}`;
    } finally {
      switching.value = false;
    }
  }

  return {
    switching,
    error,
    currentValue,
    options,
    defaultLabel,
    isInherited,
    setThinking,
  };
});
