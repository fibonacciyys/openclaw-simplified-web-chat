<script setup lang="ts">
// Collapsible "Activity: N tools" card that merges a run of consecutive tool
// messages into one summary, modeled on the control UI's activity group
// (ui/src/ui/chat/grouped-render.ts renderMessageGroup, normalizedRole==="tool"
// && group.messages.length > 1). Collapsed shows a one-line summary + tool
// label preview; expanded shows each tool card. Auto-expands when any card
// errored, matching the control UI default.
import { computed, ref } from "vue";
import { extractToolCards, isToolCardError, type ToolCard as ToolCardData } from "../lib/tool-cards";
import { resolveToolDisplay } from "../lib/tool-display";
import type { TranscriptMessage } from "../lib/types";
import ToolCard from "./ToolCard.vue";

const props = defineProps<{ messages: TranscriptMessage[] }>();

const cards = computed<ToolCardData[]>(() => props.messages.flatMap((m) => extractToolCards(m)));
const toolCount = computed(() => cards.value.length || props.messages.length);
const labels = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const card of cards.value) {
    const label = resolveToolDisplay({ name: card.name, args: card.args }).label;
    if (label && !seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
});
const preview = computed(() => {
  const n = labels.value.length;
  if (n === 0) return "Tool output";
  return n <= 3 ? labels.value.join(", ") : `${labels.value.slice(0, 2).join(", ")} +${n - 2} more`;
});
const hasError = computed(() => cards.value.some((c) => isToolCardError(c)));
// Auto-expand on error, matching the control UI's activityExpanded default.
const expanded = ref(hasError.value);
</script>

<template>
  <div
    class="tool-activity"
    :class="{ 'tool-activity--open': expanded, 'tool-activity--error': hasError }"
  >
    <button
      class="tool-activity__summary"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="tool-activity__icon">⚙️</span>
      <span class="tool-activity__label"
        >Activity: {{ toolCount }} tool{{ toolCount === 1 ? "" : "s" }}</span
      >
      <span class="tool-activity__preview">{{ preview }}</span>
      <span v-if="hasError" class="tool-activity__badge">Error</span>
      <span class="tool-activity__chevron" :class="{ 'is-open': expanded }">▾</span>
    </button>
    <div v-if="expanded" class="tool-activity__body">
      <ToolCard v-for="(card, i) in cards" :key="i" :card="card" />
    </div>
  </div>
</template>
