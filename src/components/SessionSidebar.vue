<script setup lang="ts">
import { computed } from "vue";
import { useSessionsStore } from "../stores/sessions";
import { useChatStore } from "../stores/chat";
import { useWorkspaceStore } from "../stores/workspace";

const sessions = useSessionsStore();
const chat = useChatStore();
const workspace = useWorkspaceStore();

const currentKey = computed(() => chat.sessionKey);

// Reactive forward map (sessionKey → runId) from the workspace store. Auto-
// updates when a new run is started (writes via setRunSession) or a session
// is deleted (removeRunSessionForSession). Empty when the workspace isn't
// connected. Used to show a "prose" badge next to sessions that have a bound
// prose run.
const proseBindings = computed(() => workspace.runSessionBindings);

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

async function onDeleteSession(ev: Event, key: string): Promise<void> {
  // Stop propagation so clicking × doesn't also select the session.
  ev.stopPropagation();
  ev.preventDefault();
  const title = titleFor(key);
  if (!window.confirm(`删除会话 "${title}"？\n\n这会删除该会话的记录和聊天记录，不可恢复。`)) {
    return;
  }
  await sessions.del(key);
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
        <div class="sidebar-item-title">
          <span>{{ titleFor(s.key) }}</span>
          <span v-if="proseBindings[s.key]" class="sidebar-item-badge" title="该会话绑定了一个 prose run">prose</span>
        </div>
        <div class="sidebar-item-meta">
          <span>{{ relativeTime(s.updatedAt) }}</span>
          <span v-if="s.hasActiveRun" class="dot">●</span>
        </div>
        <button
          class="sidebar-item-delete"
          title="删除此会话"
          @click="onDeleteSession($event, s.key)"
        >×</button>
      </div>
      <div v-if="sessions.sessions.length === 0" class="sidebar-empty">
        No sessions yet.
      </div>
    </div>
  </aside>
</template>
