<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useConnectionStore } from "./stores/connection";
import ConnectionBar from "./components/ConnectionBar.vue";
import SessionSidebar from "./components/SessionSidebar.vue";
import ChatView from "./components/ChatView.vue";
import ProseView from "./components/prose/ProseView.vue";
import ProviderModal from "./components/ProviderModal.vue";

const connection = useConnectionStore();
const connected = computed(() => connection.status === "connected");

// View switch between chat and the OpenProse (markdown tree) editor. The
// hash route toggles: `#prose`. The Prose editor models agent-decided
// `if **...**` branching.
type ViewId = "chat" | "prose";
const view = ref<ViewId>(readViewFromHash());

function readViewFromHash(): ViewId {
  const hash = window.location.hash;
  if (hash.includes("prose")) return "prose";
  return "chat";
}

function setView(next: ViewId): void {
  view.value = next;
  const href = window.location.href.replace(/#.*$/, "");
  window.history.replaceState(null, "", next === "chat" ? href : `${href}#${next}`);
}

window.addEventListener("hashchange", () => {
  view.value = readViewFromHash();
});

onMounted(() => {
  // Auto-connect with persisted/URL-hash settings. If the gateway requires a
  // token and none is configured, the connect fails and the bar shows the error.
  connection.connect();
});
</script>

<template>
  <div class="app">
    <ConnectionBar />
    <nav v-if="connected" class="view-switch">
      <button class="view-switch__btn" :class="{ active: view === 'chat' }" @click="setView('chat')">Chat</button>
      <button class="view-switch__btn" :class="{ active: view === 'prose' }" @click="setView('prose')">Prose</button>
    </nav>
    <div v-if="connected" class="app-body">
      <SessionSidebar v-if="view === 'chat'" />
      <main class="app-main">
        <ChatView v-if="view === 'chat'" />
        <ProseView v-else @run-in-chat="setView('chat')" />
      </main>
    </div>
    <div v-else class="app-empty">
      <p>Connect to the OpenClaw gateway to start chatting.</p>
      <p v-if="connection.lastError" class="app-empty-error">{{ connection.lastError }}</p>
    </div>
    <ProviderModal />
  </div>
</template>
