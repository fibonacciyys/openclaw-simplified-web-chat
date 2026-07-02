<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useChatStore } from "../stores/chat";
import { groupToolActivities } from "../lib/group-messages";
import MessageItem from "./MessageItem.vue";
import ToolActivityGroup from "./ToolActivityGroup.vue";
import Composer from "./Composer.vue";

const chat = useChatStore();
const scrollEl = ref<HTMLElement | null>(null);

const items = computed(() => groupToolActivities(chat.messages));

const streamMessage = computed(() => ({
  role: "assistant",
  content: chat.chatStream ?? "",
  timestamp: Date.now(),
}));

const hasStream = computed(() => chat.chatStream !== null);

function scrollToBottom() {
  void nextTick(() => {
    const el = scrollEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => chat.messages.length, scrollToBottom);
watch(() => chat.chatStream, scrollToBottom);
watch(() => chat.sessionKey, scrollToBottom);
</script>

<template>
  <div class="chat">
    <header class="chat-header">
      <span class="chat-title" :title="chat.sessionKey">{{ chat.sessionKey }}</span>
      <span v-if="chat.isBusy" class="chat-busy">working…</span>
    </header>
    <div class="messages" ref="scrollEl">
      <div v-if="chat.messages.length === 0 && !hasStream" class="messages-empty">
        Send a message to start the conversation.
      </div>
      <template v-for="item in items" :key="item.key">
        <div v-if="item.kind === 'tool-activity'" class="msg msg-assistant">
          <ToolActivityGroup :messages="item.messages" />
        </div>
        <MessageItem v-else :message="item.message" />
      </template>
      <MessageItem v-if="hasStream" :message="streamMessage" :streaming="true" />
    </div>
    <Composer />
    <div v-if="chat.lastError" class="chat-error">{{ chat.lastError }}</div>
  </div>
</template>
