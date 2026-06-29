<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useConnectionStore } from "./stores/connection";
import ConnectionBar from "./components/ConnectionBar.vue";
import SessionSidebar from "./components/SessionSidebar.vue";
import ChatView from "./components/ChatView.vue";

const connection = useConnectionStore();
const connected = computed(() => connection.status === "connected");

onMounted(() => {
  // Auto-connect with persisted/URL-hash settings. If the gateway requires a
  // token and none is configured, the connect fails and the bar shows the error.
  connection.connect();
});
</script>

<template>
  <div class="app">
    <ConnectionBar />
    <div v-if="connected" class="app-body">
      <SessionSidebar />
      <main class="app-main">
        <ChatView />
      </main>
    </div>
    <div v-else class="app-empty">
      <p>Connect to the OpenClaw gateway to start chatting.</p>
      <p v-if="connection.lastError" class="app-empty-error">{{ connection.lastError }}</p>
    </div>
  </div>
</template>
