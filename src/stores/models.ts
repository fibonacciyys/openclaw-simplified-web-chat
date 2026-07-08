// Models store: per-session model selection for webchat clients.
//
// The gateway forbids webchat clients from calling sessions.patch
// (src/gateway/server-methods/sessions.ts rejectWebchatSessionMutation —
// "webchat clients cannot patch sessions; use chat.send for session-scoped
// updates"). Only the control UI is exempt. So this client changes the
// per-session model by sending the `/model <id>` slash command through
// chat.send; the gateway interprets it as a native slash command
// (src/auto-reply/reply/get-reply-native-slash-fast-path.ts), persists the
// selection server-side, replies with a confirmation, and emits
// sessions.changed (which the sessions store already reloads on).
//
// Catalog source: models.list { view: "configured" } (mirrors
// ui/src/ui/controllers/models.ts). Current model source: the session row's
// `model` from sessions.list, falling back to `defaults.model`.
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type { ModelCatalogEntry, ModelsListResult } from "../lib/types";
import { useChatStore } from "./chat";
import { useConnectionStore } from "./connection";
import { useSessionsStore } from "./sessions";

// Sentinel value used by the <select> option that maps to "use the configured
// default model". The `/model` slash command has no clear-override syntax, so
// "Default" is implemented by setting the session model to `defaults.model`.
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
    const row = sessions.sessions.find((s) => s.key === chat.sessionKey);
    const dm = sessions.defaults?.model ?? null;
    const model = row?.model ?? dm ?? DEFAULT_MODEL_VALUE;
    // Treat an explicit override equal to the default as "default" so the
    // picker shows "Default" after `/model <default>` (matches the control
    // UI's sessionModelMatchesDefaults intent).
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

  // Build the `/model` command text for a picker value. Returns null when the
  // requested action is a no-op (e.g. "Default" with no configured default).
  function buildModelCommand(next: string): string | null {
    const sessions = useSessionsStore();
    const requested = next.trim();
    if (!requested) {
      const dm = sessions.defaults?.model;
      return dm ? `/model ${dm}` : null;
    }
    return `/model ${requested}`;
  }

  // Resolves once the chat store's active run goes idle. chat.send resolves
  // on the ack, but the `/model` command run continues until its `final`
  // chat event; the picker stays disabled until then so the reloaded session
  // row (after sessions.changed) drives the new value.
  function waitForRunIdle(): Promise<void> {
    const chat = useChatStore();
    return new Promise((resolve) => {
      if (!chat.isBusy) {
        resolve();
        return;
      }
      const stop = watch(
        () => chat.isBusy,
        (busy) => {
          if (!busy) {
            stop();
            resolve();
          }
        },
      );
    });
  }

  async function setModel(next: string): Promise<void> {
    const chat = useChatStore();
    const cmd = buildModelCommand(next);
    if (!cmd) return;
    if (chat.isBusy) {
      // The gateway won't run a second concurrent turn; don't even try.
      error.value = "Cannot switch model while a run is active";
      return;
    }
    switching.value = true;
    error.value = null;
    try {
      await chat.send(cmd);
      await waitForRunIdle();
      // The /model run is done server-side, but its sessions.changed may fire
      // before the model is persisted (or not at all for this command path),
      // leaving the cached session row stale. Force-refresh so the picker
      // reflects the new model immediately instead of waiting for the next
      // session mutation.
      await useSessionsStore().load();
    } catch (err) {
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
