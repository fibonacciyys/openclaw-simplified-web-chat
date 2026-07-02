// Providers store: read/write OpenClaw model providers and the default model
// via the gateway `config.get` / `config.patch` RPC methods.
//
// Config patch semantics (RFC 7396 merge patch, see src/config/merge-patch.ts):
//   - A null value deletes a key (used for provider removal).
//   - A redacted apiKey sentinel ("__OPENCLAW_REDACTED__") is restored server-side
//     by `restoreRedactedValues`, so it is safe to echo back unchanged.
//   - New providers carry a real apiKey and are left untouched by restoration.
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useConnectionStore } from "./connection";

export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

export type ProviderModel = {
  id: string;
  name?: string;
};

export type ProviderEntry = {
  baseUrl?: string;
  apiKey?: string;
  auth?: string;
  api?: string;
  agentRuntime?: { id?: string };
  models: ProviderModel[];
};

export type ConfigSnapshotShape = {
  hash?: string;
  config?: {
    models?: {
      providers?: Record<string, unknown>;
    };
    agents?: {
      defaults?: {
        model?: unknown;
      };
    };
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asProviderEntry(raw: unknown): ProviderEntry {
  if (!isPlainObject(raw)) return { models: [] };
  const models = Array.isArray(raw.models) ? raw.models.map(asProviderModel) : [];
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    auth: typeof raw.auth === "string" ? raw.auth : undefined,
    api: typeof raw.api === "string" ? raw.api : undefined,
    agentRuntime: isPlainObject(raw.agentRuntime)
      ? { id: typeof raw.agentRuntime.id === "string" ? raw.agentRuntime.id : undefined }
      : undefined,
    models,
  };
}

function asProviderModel(raw: unknown): ProviderModel {
  if (!isPlainObject(raw) || typeof raw.id !== "string") {
    return { id: "" };
  }
  return { id: raw.id, name: typeof raw.name === "string" ? raw.name : undefined };
}

function resolveDefaultModelString(value: unknown): string {
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.primary === "string") return value.primary;
  return "";
}

export const useProvidersStore = defineStore("providers", () => {
  const open = ref(false);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const providers = ref<Record<string, ProviderEntry>>({});
  const defaultModel = ref("");
  const baseHash = ref<string | undefined>(undefined);

  const providerIds = computed(() => Object.keys(providers.value).sort());

  function client() {
    const c = useConnectionStore().getClient();
    if (!c) throw new Error("gateway not connected");
    return c;
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const snap = await client().request<ConfigSnapshotShape>("config.get", {});
      const config = snap?.config ?? {};
      const rawProviders = config.models?.providers ?? {};
      const next: Record<string, ProviderEntry> = {};
      if (isPlainObject(rawProviders)) {
        for (const [id, raw] of Object.entries(rawProviders)) {
          next[id] = asProviderEntry(raw);
        }
      }
      providers.value = next;
      defaultModel.value = resolveDefaultModelString(config.agents?.defaults?.model);
      baseHash.value = snap?.hash;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function buildPatch(patch: Record<string, unknown>): string {
    return JSON.stringify(patch);
  }

  async function patchConfig(patch: Record<string, unknown>): Promise<void> {
    saving.value = true;
    error.value = null;
    try {
      await client().request("config.patch", {
        raw: buildPatch(patch),
        ...(baseHash.value ? { baseHash: baseHash.value } : {}),
      });
      await load();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      saving.value = false;
    }
  }

  async function addProvider(id: string, entry: ProviderEntry): Promise<void> {
    const trimmedId = id.trim();
    if (!trimmedId) {
      error.value = "provider id is required";
      return;
    }
    if (providers.value[trimmedId]) {
      error.value = `provider "${trimmedId}" already exists`;
      return;
    }
    const providerPayload: Record<string, unknown> = {};
    if (entry.baseUrl) providerPayload.baseUrl = entry.baseUrl;
    if (entry.apiKey) providerPayload.apiKey = entry.apiKey;
    if (entry.auth) providerPayload.auth = entry.auth;
    if (entry.api) providerPayload.api = entry.api;
    if (entry.agentRuntime?.id) providerPayload.agentRuntime = { id: entry.agentRuntime.id };
    providerPayload.models = entry.models.filter((m) => m.id.trim()).map((m) => ({
      id: m.id.trim(),
      ...(m.name ? { name: m.name } : {}),
    }));
    await patchConfig({ models: { providers: { [trimmedId]: providerPayload } } });
  }

  async function deleteProvider(id: string): Promise<void> {
    // null in merge-patch semantics deletes the key.
    await patchConfig({ models: { providers: { [id]: null } } });
  }

  async function setDefaultModel(model: string): Promise<void> {
    const trimmed = model.trim();
    await patchConfig({ agents: { defaults: { model: trimmed || null } } });
  }

  function show(): void {
    open.value = true;
    void load();
  }

  function hide(): void {
    open.value = false;
  }

  return {
    open,
    loading,
    saving,
    error,
    providers,
    defaultModel,
    baseHash,
    providerIds,
    load,
    addProvider,
    deleteProvider,
    setDefaultModel,
    show,
    hide,
  };
});
