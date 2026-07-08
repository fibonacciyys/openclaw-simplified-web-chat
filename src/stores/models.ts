// Models store: per-session model selection.
//
// Mirrors the control UI flow (ui/src/ui/chat/session-controls.ts
// switchChatModel + ui/src/ui/controllers/models.ts loadModels):
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
    return row?.model ?? sessions.defaults?.model ?? DEFAULT_MODEL_VALUE;
  });

  const isDefault = computed(
    () => currentModelValue.value === DEFAULT_MODEL_VALUE,
  );

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
      const next2 = { ...overrides.value };
      delete next2[key];
      overrides.value = next2;
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
