<script setup lang="ts">
// Collapsible tool card, modeled on the OpenClaw control UI tool card
// (ui/src/ui/chat/tool-cards.ts renderToolCard). Collapsed shows a one-line
// summary (icon + label + detail + truncated preview); expanded shows the
// full input/output in scrollable code blocks so long output stays bounded.
import { computed, ref } from "vue";
import { formatToolDetail, resolveToolDisplay } from "../lib/tool-display";
import { getTruncatedPreview, isToolCardError, type ToolCard } from "../lib/tool-cards";

const props = defineProps<{ card: ToolCard }>();
const expanded = ref(false);

const display = computed(() => resolveToolDisplay({ name: props.card.name, args: props.card.args }));
const detail = computed(() => formatToolDetail(display.value));
const isError = computed(() => isToolCardError(props.card));
const hasInput = computed(() => Boolean(props.card.inputText?.trim()));
const hasOutput = computed(() => Boolean(props.card.outputText?.trim()));
const preview = computed(() =>
  hasOutput.value ? getTruncatedPreview(props.card.outputText ?? "") : "",
);
const summaryLabel = computed(() => {
  // Collapsed line: "Bash" or "Bash with `ls -la`".
  const base = display.value.label;
  return detail.value ? `${base} ${detail.value}` : base;
});
</script>

<template>
  <div class="tool-card" :class="{ 'tool-card--error': isError, 'tool-card--open': expanded }">
    <button
      class="tool-card__summary"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="tool-card__icon">{{ display.icon }}</span>
      <span class="tool-card__label">{{ summaryLabel }}</span>
      <span v-if="isError" class="tool-card__badge">Error</span>
      <span v-else-if="hasOutput" class="tool-card__preview">{{ preview }}</span>
      <span class="tool-card__chevron" :class="{ 'is-open': expanded }">▾</span>
    </button>
    <div v-if="expanded" class="tool-card__body">
      <div v-if="hasInput" class="tool-card__block">
        <div class="tool-card__block-label">Tool input</div>
        <pre class="tool-card__block-content"><code>{{ card.inputText }}</code></pre>
      </div>
      <div v-if="hasOutput" class="tool-card__block">
        <div class="tool-card__block-label">
          {{ isError ? "Tool error" : "Tool output" }}
        </div>
        <pre class="tool-card__block-content"><code>{{ card.outputText }}</code></pre>
      </div>
      <div v-if="!hasInput && !hasOutput" class="tool-card__empty">
        {{ isError ? "Failed — no output." : "Completed — no output." }}
      </div>
    </div>
  </div>
</template>
