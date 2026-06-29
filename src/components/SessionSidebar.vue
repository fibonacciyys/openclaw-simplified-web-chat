<script setup lang="ts">
import { computed } from "vue";
import { useSessionsStore } from "../stores/sessions";
import { useChatStore } from "../stores/chat";

const sessions = useSessionsStore();
const chat = useChatStore();

const currentKey = computed(() => chat.sessionKey);

function titleFor(key: string): string {
  const row = sessions.sessions.find((s) => s.key === key);
  return row?.label || row?.derivedTitle || row?.displayName || key;
}

function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

async function newChat() {
  const key = await sessions.create();
  if (key) await sessions.select(key);
}

async function select(key: string) {
  await sessions.select(key);
}
</script>

<template>
  <aside class="sidebar">
    <button class="btn-primary sidebar-new" @click="newChat">+ New chat</button>
    <div class="sidebar-list">
      <div
        v-for="s in sessions.sessions"
        :key="s.key"
        class="sidebar-item"
        :class="{ active: s.key === currentKey }"
        @click="select(s.key)"
      >
        <div class="sidebar-item-title">{{ titleFor(s.key) }}</div>
        <div class="sidebar-item-meta">
          <span>{{ relativeTime(s.updatedAt) }}</span>
          <span v-if="s.hasActiveRun" class="dot">●</span>
        </div>
      </div>
      <div v-if="sessions.sessions.length === 0" class="sidebar-empty">
        No sessions yet.
      </div>
    </div>
  </aside>
</template>
