<script setup lang="ts">
import { computed } from "vue";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { extractMessageMarkdown } from "../lib/extract-text";
import { extractToolCards, isToolMessage } from "../lib/tool-cards";
import type { TranscriptMessage } from "../lib/types";
import ToolCard from "./ToolCard.vue";

const props = defineProps<{ message: TranscriptMessage; streaming?: boolean }>();

const isUser = computed(() => (props.message.role ?? "").toLowerCase() === "user");
const roleLabel = computed(() => (isUser.value ? "You" : "Assistant"));
const toolCards = computed(() => extractToolCards(props.message));
// Mirrors the control UI's isToolResult gate (grouped-render.ts: isToolResult):
// a tool message is role tool/tool_result/toolresult/function OR carries a
// top-level toolCallId/tool_call_id. Tool-result messages render as cards and
// their raw output must not also flood the text bubble.
const isToolMsg = computed(() => isToolMessage(props.message));
const hasOutputCards = computed(() =>
  toolCards.value.some((c) => typeof c.outputText === "string" && c.outputText.trim()),
);
const suppressText = computed(() => isToolMsg.value || hasOutputCards.value);
const html = computed(() => {
  // Tool-result messages render as cards; suppress the raw output text bubble
  // so a long tool result never floods the message stream.
  if (suppressText.value) return "";
  const markdown = extractMessageMarkdown(props.message) ?? "";
  return toSanitizedMarkdownHtml(markdown);
});
const showText = computed(() => Boolean(html.value) || isUser.value);
</script>

<template>
  <div class="msg" :class="isUser ? 'msg-user' : 'msg-assistant'">
    <div class="msg-role">{{ roleLabel }}</div>
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify allowlist -->
    <div v-if="showText" class="msg-text" v-html="html"></div>
    <ToolCard v-for="card in toolCards" :key="card.id" :card="card" />
    <span v-if="streaming" class="msg-cursor">▋</span>
  </div>
</template>
