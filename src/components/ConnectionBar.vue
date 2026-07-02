<script setup lang="ts">
import { computed } from "vue";
import { useConnectionStore } from "../stores/connection";
import { useProvidersStore } from "../stores/providers";

const connection = useConnectionStore();
const providers = useProvidersStore();
const statusText = computed(() => {
  switch (connection.status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Disconnected";
    default:
      return "Disconnected";
  }
});
const canConnect = computed(
  () => connection.url.trim().length > 0 && connection.status !== "connecting",
);
</script>

<template>
  <header class="bar">
    <div class="bar-brand">OpenClaw Web Chat</div>
    <div class="bar-fields">
      <input
        class="input"
        v-model="connection.url"
        placeholder="ws://127.0.0.1:18789"
        :disabled="connection.status === 'connected'"
      />
      <input
        class="input"
        v-model="connection.token"
        placeholder="token (shared gateway token)"
        type="password"
        :disabled="connection.status === 'connected'"
      />
    </div>
    <div class="bar-actions">
      <span class="status" :data-status="connection.status">{{ statusText }}</span>
      <button
        v-if="connection.status === 'connected'"
        class="btn-secondary"
        @click="providers.show()"
      >
        Providers
      </button>
      <button
        v-if="connection.status !== 'connected'"
        class="btn-primary"
        :disabled="!canConnect"
        @click="connection.connect()"
      >
        Connect
      </button>
      <button v-else class="btn-secondary" @click="connection.disconnect()">Disconnect</button>
    </div>
  </header>
</template>
