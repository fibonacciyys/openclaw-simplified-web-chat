<script setup lang="ts">
import { computed } from "vue";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { extractMessageMarkdown } from "../lib/extract-text";
import type { TranscriptMessage } from "../lib/types";

const props = defineProps<{ message: TranscriptMessage; streaming?: boolean }>();

const isUser = computed(() => (props.message.role ?? "").toLowerCase() === "user");
const roleLabel = computed(() => (isUser.value ? "You" : "Assistant"));
const html = computed(() => {
  const markdown = extractMessageMarkdown(props.message) ?? "";
  return toSanitizedMarkdownHtml(markdown);
});
</script>

<template>
  <div class="msg" :class="isUser ? 'msg-user' : 'msg-assistant'">
    <div class="msg-role">{{ roleLabel }}</div>
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify allowlist -->
    <div class="msg-text" v-html="html"></div>
    <span v-if="streaming" class="msg-cursor">▋</span>
  </div>
</template>
