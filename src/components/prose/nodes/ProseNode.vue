<script setup lang="ts">
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import type { ProseNodeKind } from "../../../lib/prose-types";
import type { ProseLayoutNodeData } from "../../../lib/prose-layout";

// Custom node for the Prose tree canvas. The 13 kinds share a single
// Handle layout (input at top, output at bottom) so containment edges from
// parent→child all attach at the same anchor. The kind only changes the
// header icon, accent color (via .prose-node--<kind>), and subtitle text.
//
// Subtitle carries the most useful single-line summary of each kind so the
// canvas reads without opening the Inspector: discretion text on if/elif,
// the agent model on agent, the session prompt snippet on session, etc.

const props = defineProps<{
  data: ProseLayoutNodeData;
  selected?: boolean;
}>();

const node = computed(() => props.data.prose);
const kind = computed<ProseNodeKind>(() => props.data.kind);
const status = computed(() => props.data.status);

// Truncate long strings so node boxes stay a uniform width.
function clip(s: string | undefined, max = 48): string {
  if (!s) return "";
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

// Primary label = the bound name (for agent/session/input/output/assign) or
// the kind itself for anonymous constructs (if/elif/else/parallel/loop/choice).
const label = computed(() => {
  const n = node.value;
  if (n.name && n.name.trim()) return n.name;
  if (n.kind === "use" && n.useAs) return n.useAs;
  if (n.kind === "option" && n.optionLabel) return n.optionLabel;
  return n.kind;
});

const subtitle = computed(() => {
  const n = node.value;
  switch (kind.value) {
    case "use":
      return n.useSource ? `use ${n.useSource}${n.useAs ? ` as ${n.useAs}` : ""}` : "(no source)";
    case "agent": {
      const parts: string[] = [];
      if (n.agentModel) parts.push(`model: ${n.agentModel}`);
      if (n.agentSkills && n.agentSkills.length > 0) parts.push(`skills: ${n.agentSkills.join(",")}`);
      if (n.agentPrompt) parts.push(clip(n.agentPrompt));
      return parts.length > 0 ? parts.join(" · ") : "(no prompt)";
    }
    case "input":
      if (n.inputDiscretion?.text) return `if ${clip(n.inputDiscretion.text)}`;
      return n.inputPrompt ? clip(n.inputPrompt) : "(no prompt)";
    case "output":
      return n.outputExpr ? `= ${clip(n.outputExpr)}` : "(no expr)";
    case "assign":
      return n.assignExpr ? `= ${clip(n.assignExpr)}` : "(no expr)";
    case "session": {
      if (n.sessionAgent) {
        const over = n.sessionPromptOverride ? ` · ${clip(n.sessionPromptOverride)}` : "";
        return `agent: ${n.sessionAgent}${over}`;
      }
      return n.sessionPrompt ? clip(n.sessionPrompt) : "(no prompt)";
    }
    case "if":
    case "elif":
      return n.ifDiscretion?.text ? `if ${clip(n.ifDiscretion.text)}` : "(no condition)";
    case "else":
      return "fallback";
    case "choice":
      return n.choiceDiscretion?.text ? `pick ${clip(n.choiceDiscretion.text)}` : "(no discretion)";
    case "option":
      return n.optionLabel ? clip(n.optionLabel) : "(no label)";
    case "parallel": {
      const join = n.parallelJoin ?? "all";
      return `join: ${join}`;
    }
    case "loop": {
      const k = n.loopKind ?? "until";
      const cond = n.loopDiscretion?.text ? ` ${clip(n.loopDiscretion.text)}` : "";
      const max = n.loopMax != null ? ` (max ${n.loopMax})` : "";
      return `${k}${cond}${max}`;
    }
    default:
      return kind.value;
  }
});

// Header icon per kind. Geometric Unicode symbols (matching WfNode style).
const icon = computed<string>(() => {
  switch (kind.value) {
    case "use":
      return "\u25CE"; // ◎
    case "agent":
      return "\u25C8"; // ◈
    case "input":
      return "\u270E"; // ✎
    case "output":
      return "\u25B7"; // ▷
    case "session":
      return "\u2709"; // ✉
    case "assign":
      return "="; // =
    case "if":
      return "?"; // ?
    case "elif":
      return "\u21B3"; // ↳
    case "else":
      return "\u2198"; // ↘
    case "choice":
      return "\u2295"; // ⊕
    case "option":
      return "\u25CC"; // ◌
    case "parallel":
      return "\u2225"; // ∥
    case "loop":
      return "\u21BB"; // ↻
    default:
      return "\u25B7";
  }
});
</script>

<template>
  <div
    class="prose-node"
    :class="[
      `prose-node--${kind}`,
      {
        'is-selected': selected,
        'is-running': status === 'running',
        'is-done': status === 'done',
      },
    ]"
  >
    <Handle type="target" :position="Position.Top" class="prose-handle prose-handle--in" />
    <div class="prose-node__head">
      <span class="prose-node__icon">{{ icon }}</span>
      <span class="prose-node__kind">{{ kind }}</span>
    </div>
    <div class="prose-node__title" :title="label">{{ label }}</div>
    <div class="prose-node__sub" :title="subtitle">{{ subtitle }}</div>
    <Handle type="source" :position="Position.Bottom" class="prose-handle prose-handle--out" />
  </div>
</template>
