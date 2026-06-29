<script setup lang="ts">
import { ref } from "vue";
import { useChatStore } from "../stores/chat";

const chat = useChatStore();
const draft = ref("");

async function submit() {
  if (!draft.value.trim() || chat.isBusy) return;
  const text = draft.value;
  draft.value = "";
  await chat.send(text);
}

async function stop() {
  await chat.abort();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <div class="composer">
    <textarea
      class="composer-input"
      v-model="draft"
      @keydown="onKeydown"
      placeholder="Send a message…  (Enter to send, Shift+Enter for newline)"
      rows="1"
    ></textarea>
    <button v-if="!chat.isBusy" class="btn-primary" :disabled="!draft.trim()" @click="submit">
      Send
    </button>
    <button v-else class="btn-stop" @click="stop">Stop</button>
  </div>
</template>
