// Models store: per-session model selection via sessions.patch.
//
// This client connects with the Control UI identity (src/lib/gateway-client.ts
// CLIENT_ID = "openclaw-control-ui"), which the gateway's webchat
// session-mutation guard exempts via `client.id === CONTROL_UI`
// (src/gateway/server-methods/sessions.ts:335 rejectWebchatSessionMutation).
// So per-session model changes use sessions.patch directly — the same path as
// the control UI (ui/src/ui/chat/session-controls.ts switchChatModel) — with no
// /model slash command and no transcript pollution.
//
//   - models.list { view: "configured" } returns the configured model catalog.
//   - sessions.list echoes per-session `model` + `defaults.model`.
//   - sessions.patch { key, model } sets (string) or clears (null) the
//     per-session model override; clearing falls back to the default.
//
// The select stays in sync via an optimistic per-session override cache that
// is rolled back on RPC failure and dropped once sessions.list refreshes the
// authoritative row.
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { ModelCatalogEntry, ModelsListResult, SessionsPatchResult } from "../lib/types";
import { useChatStore } from "./chat";
import { useConnectionStore } from "./connection";
import { useSessionsStore } from "./sessions";

// Sentinel value used by the <select> option that clears the per-session
// override so the session falls back to the configured default model.
const DEFAULT_MODEL_VALUE = "";

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

export const useModelsStore = defineStore("models", () => {
  const catalog = ref<ModelCatalogEntry[]>([]);
  const loading = ref(false);
  const switching = ref(false);
  const error = ref<string | null>(null);
  // Optimistic per-session override: string = set, null = cleared to default.
  const overrides = ref<Record<string, string | null>>({});

  function client() {
    const c = useConnectionStore().getClient();
    if (!c) throw new Error("gateway not connected");
    return c;
  }

  async function loadCatalog(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await client().request<ModelsListResult>("models.list", {
        view: "configured",
      });
      catalog.value = res?.models ?? [];
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      loading.value = false;
    }
  }

  const currentModelValue = computed<string>(() => {
    const chat = useChatStore();
    const sessions = useSessionsStore();
    const key = chat.sessionKey;
    if (key in overrides.value) {
      const override = overrides.value[key];
      return override ?? DEFAULT_MODEL_VALUE;
    }
    const row = sessions.sessions.find((s) => s.key === key);
    const dm = sessions.defaults?.model ?? null;
    const model = row?.model ?? dm ?? DEFAULT_MODEL_VALUE;
    // Treat an explicit override equal to the default as "Default" so the
    // picker shows "Default" whether the override is cleared (null) or set to
    // the default ref (matches the control UI's sessionModelMatchesDefaults).
    return dm && model === dm ? DEFAULT_MODEL_VALUE : model;
  });

  const isDefault = computed(() => currentModelValue.value === DEFAULT_MODEL_VALUE);

  // Select <option> list: a "Default" entry first, then catalog entries. The
  // current model is appended when it is not the default and not in the
  // catalog (e.g. a provider-qualified ref the server resolved to).
  const options = computed<{ value: string; label: string }[]>(() => {
    const out: { value: string; label: string }[] = [
      { value: DEFAULT_MODEL_VALUE, label: defaultLabel() },
    ];
    const seen = new Set<string>([DEFAULT_MODEL_VALUE]);
    for (const entry of catalog.value) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push({ value: entry.id, label: formatModelLabel(entry) });
    }
    const current = currentModelValue.value;
    if (current && !seen.has(current)) {
      out.push({ value: current, label: current });
    }
    return out;
  });

  function defaultLabel(): string {
    const sessions = useSessionsStore();
    const dm = sessions.defaults?.model;
    return dm ? `Default (${dm})` : "Default model";
  }

  function formatModelLabel(entry: ModelCatalogEntry): string {
    return entry.name && entry.name !== entry.id
      ? `${entry.name} (${entry.id})`
      : entry.id;
  }

  async function setModel(next: string): Promise<void> {
    const chat = useChatStore();
    const sessions = useSessionsStore();
    const key = chat.sessionKey;
    const requested = next.trim();
    // Clearing to default: send null so the server drops the override.
    const patchModel = requested === DEFAULT_MODEL_VALUE ? null : requested;
    const prev = overrides.value[key];
    // Write the override cache immediately so the picker stays in sync during
    // the RPC round-trip.
    overrides.value = { ...overrides.value, [key]: patchModel };
    switching.value = true;
    error.value = null;
    try {
      await client().request<SessionsPatchResult>("sessions.patch", {
        key,
        model: patchModel,
      });
      // Refresh the session index so the row's authoritative model field
      // drives the select, then drop the now-redundant optimistic override.
      await sessions.load();
      const nextOverrides = { ...overrides.value };
      delete nextOverrides[key];
      overrides.value = nextOverrides;
    } catch (err) {
      // Roll back so the select reflects the actual server model.
      const rollback = { ...overrides.value };
      if (prev === undefined) {
        delete rollback[key];
      } else {
        rollback[key] = prev;
      }
      overrides.value = rollback;
      error.value = `Failed to set model: ${errorMessage(err)}`;
    } finally {
      switching.value = false;
    }
  }

  return {
    catalog,
    loading,
    switching,
    error,
    options,
    currentModelValue,
    isDefault,
    loadCatalog,
    setModel,
  };
});
