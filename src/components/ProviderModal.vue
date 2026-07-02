<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  REDACTED_SENTINEL,
  useProvidersStore,
  type ProviderEntry,
} from "../stores/providers";

const providers = useProvidersStore();

const newId = ref("");
const newBaseUrl = ref("");
const newApiKey = ref("");
const newAuth = ref("api-key");
const newApi = ref("openai-completions");
const newModels = ref("");

const defaultModelInput = ref("");

const availableModels = computed(() => {
  const out: string[] = [];
  for (const [providerId, entry] of Object.entries(providers.providers)) {
    for (const m of entry.models) {
      if (m.id) out.push(`${providerId}/${m.id}`);
    }
  }
  return out.sort();
});

const defaultModelDirty = computed(
  () => defaultModelInput.value.trim() !== providers.defaultModel,
);

function isRedacted(key: string | undefined): boolean {
  return key === REDACTED_SENTINEL;
}

function maskApiKey(key: string | undefined): string {
  if (!key) return "";
  if (isRedacted(key)) return "•••••••• (redacted)";
  return "••••••••";
}

function close(): void {
  providers.hide();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && providers.open) {
    event.stopPropagation();
    close();
  }
}

function stopPropagation(event: Event): void {
  event.stopPropagation();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});

// Keep the default-model input in sync with the store after each load.
watch(
  () => providers.defaultModel,
  (value) => {
    defaultModelInput.value = value;
  },
);

function resetNewForm(): void {
  newId.value = "";
  newBaseUrl.value = "";
  newApiKey.value = "";
  newAuth.value = "api-key";
  newApi.value = "openai-completions";
  newModels.value = "";
}

async function onAdd(): Promise<void> {
  const models = newModels.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ id: line, name: line }));
  const entry: ProviderEntry = {
    models,
    api: newApi.value,
    ...(newBaseUrl.value.trim() ? { baseUrl: newBaseUrl.value.trim() } : {}),
    ...(newApiKey.value.trim() ? { apiKey: newApiKey.value.trim() } : {}),
    ...(newAuth.value ? { auth: newAuth.value } : {}),
  };
  await providers.addProvider(newId.value, entry);
  if (!providers.error) resetNewForm();
}

async function onDelete(id: string): Promise<void> {
  if (!confirm(`Delete provider "${id}"? This will patch the gateway config.`)) return;
  await providers.deleteProvider(id);
}

async function onSaveDefaultModel(): Promise<void> {
  await providers.setDefaultModel(defaultModelInput.value);
}
</script>

<template>
  <div v-if="providers.open" class="modal-overlay" @click="close">
    <div class="modal" @click="stopPropagation">
      <header class="modal-header">
        <h2 class="modal-title">Provider Settings</h2>
        <button class="modal-close" @click="close" aria-label="Close">×</button>
      </header>

      <div class="modal-body">
        <div v-if="providers.error" class="modal-error">{{ providers.error }}</div>
        <div v-if="providers.loading" class="modal-hint">Loading config…</div>

        <section class="modal-section">
          <h3 class="modal-section-title">Default Model</h3>
          <div class="default-model-row">
            <input
              class="input"
              v-model="defaultModelInput"
              :placeholder="providers.defaultModel || 'provider/model-id'"
              list="available-models"
              :disabled="providers.saving"
            />
            <datalist id="available-models">
              <option v-for="m in availableModels" :key="m" :value="m" />
            </datalist>
            <button
              class="btn-primary"
              :disabled="providers.saving || !defaultModelDirty"
              @click="onSaveDefaultModel"
            >
              Save
            </button>
          </div>
          <p class="modal-help">
            Current default: <code>{{ providers.defaultModel || "(none)" }}</code>. Use the format
            <code>provider/model-id</code>.
          </p>
        </section>

        <section class="modal-section">
          <h3 class="modal-section-title">Providers</h3>
          <div v-if="providers.providerIds.length === 0 && !providers.loading" class="modal-empty">
            No providers configured.
          </div>
          <div
            v-for="id in providers.providerIds"
            :key="id"
            class="provider-card"
          >
            <div class="provider-card-head">
              <span class="provider-id">{{ id }}</span>
              <button
                class="btn-danger-sm"
                :disabled="providers.saving"
                @click="onDelete(id)"
              >
                Delete
              </button>
            </div>
            <dl class="provider-meta">
              <div class="provider-meta-row">
                <dt>baseUrl</dt>
                <dd>{{ providers.providers[id]?.baseUrl || "(default)" }}</dd>
              </div>
              <div class="provider-meta-row">
                <dt>apiKey</dt>
                <dd>{{ maskApiKey(providers.providers[id]?.apiKey) }}</dd>
              </div>
              <div class="provider-meta-row" v-if="providers.providers[id]?.api">
                <dt>api</dt>
                <dd>{{ providers.providers[id]?.api }}</dd>
              </div>
              <div class="provider-meta-row" v-if="providers.providers[id]?.agentRuntime?.id">
                <dt>runtime</dt>
                <dd>{{ providers.providers[id]?.agentRuntime?.id }}</dd>
              </div>
            </dl>
            <div v-if="providers.providers[id]?.models.length" class="provider-models">
              <span
                v-for="m in providers.providers[id]?.models"
                :key="m.id"
                class="provider-model-tag"
                >{{ m.id }}</span
              >
            </div>
            <div v-else class="provider-models-empty">(no models declared)</div>
          </div>
        </section>

        <section class="modal-section">
          <h3 class="modal-section-title">Add Provider</h3>
          <div class="form-grid">
            <label class="form-label">
              <span>Provider ID *</span>
              <input
                class="input"
                v-model="newId"
                placeholder="e.g. openai, my-local-llm"
                :disabled="providers.saving"
              />
            </label>
            <label class="form-label">
              <span>Base URL</span>
              <input
                class="input"
                v-model="newBaseUrl"
                placeholder="https://api.example.com/v1"
                :disabled="providers.saving"
              />
            </label>
            <label class="form-label">
              <span>API Key</span>
              <input
                class="input"
                v-model="newApiKey"
                type="password"
                placeholder="sk-…"
                :disabled="providers.saving"
              />
            </label>
            <label class="form-label">
              <span>API protocol</span>
              <select class="input" v-model="newApi" :disabled="providers.saving" title="Determines which SDK/protocol the runtime uses for chat requests">
                <option value="openai-completions">openai-completions</option>
                <option value="openai-responses">openai-responses</option>
                <option value="openai-chatgpt-responses">openai-chatgpt-responses</option>
                <option value="anthropic-messages">anthropic-messages</option>
                <option value="azure-openai-responses">azure-openai-responses</option>
                <option value="google-generative-ai">google-generative-ai</option>
                <option value="google-vertex">google-vertex</option>
                <option value="ollama">ollama</option>
                <option value="bedrock-converse-stream">bedrock-converse-stream</option>
                <option value="github-copilot">github-copilot</option>
              </select>
            </label>
            <label class="form-label">
              <span>Auth</span>
              <select class="input" v-model="newAuth" :disabled="providers.saving">
                <option value="api-key">api-key</option>
                <option value="oauth">oauth</option>
                <option value="token">token</option>
                <option value="aws-sdk">aws-sdk</option>
              </select>
            </label>
            <label class="form-label form-label-full">
              <span>Models (one id per line)</span>
              <textarea
                class="input form-textarea"
                v-model="newModels"
                placeholder="gpt-5.4&#10;gpt-5.5"
                rows="3"
                :disabled="providers.saving"
              ></textarea>
            </label>
          </div>
          <div class="form-actions">
            <button
              class="btn-primary"
              :disabled="providers.saving || !newId.trim()"
              @click="onAdd"
            >
              {{ providers.saving ? "Saving…" : "Add Provider" }}
            </button>
          </div>
        </section>
      </div>

      <footer class="modal-footer">
        <button class="btn-secondary" @click="close">Close</button>
      </footer>
    </div>
  </div>
</template>
