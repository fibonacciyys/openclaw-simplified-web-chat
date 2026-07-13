<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useChatStore } from "../stores/chat";
import { useModelsStore } from "../stores/models";
import { useThinkingStore } from "../stores/thinking";
import { groupToolActivities } from "../lib/group-messages";
import MessageItem from "./MessageItem.vue";
import ToolActivityGroup from "./ToolActivityGroup.vue";
import Composer from "./Composer.vue";

const chat = useChatStore();
const models = useModelsStore();
const thinking = useThinkingStore();
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

async function onModelChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  await models.setModel(value);
}

async function onThinkingChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  await thinking.setThinking(value);
}
</script>

<template>
  <div class="chat">
    <header class="chat-header">
      <span class="chat-title" :title="chat.sessionKey">{{ chat.sessionKey }}</span>
      <div class="chat-header-right">
        <label class="chat-select" :title="models.isDefault ? 'Using default model' : 'Per-session model'">
          <span class="chat-select-label">Model</span>
          <select
            class="chat-select-input"
            :value="models.currentModelValue"
            :disabled="models.switching || models.options.length <= 1"
            @change="onModelChange"
          >
            <option v-for="opt in models.options" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
        <label
          class="chat-select thinking-select"
          :title="thinking.isInherited ? 'Using inherited thinking level' : 'Per-session thinking level'"
        >
          <span class="chat-select-label">Thinking</span>
          <select
            class="chat-select-input"
            :value="thinking.currentValue"
            :disabled="thinking.switching || thinking.options.length === 0"
            @change="onThinkingChange"
          >
            <option :value="''">{{ thinking.defaultLabel }}</option>
            <option v-for="opt in thinking.options" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
        <span v-if="chat.isBusy" class="chat-busy">working…</span>
      </div>
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
    <div v-if="models.error" class="chat-error">{{ models.error }}</div>
    <div v-else-if="thinking.error" class="chat-error">{{ thinking.error }}</div>
    <div v-else-if="chat.lastError" class="chat-error">{{ chat.lastError }}</div>
  </div>
</template>
