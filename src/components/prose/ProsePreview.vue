<script setup lang="ts">
import { computed, ref } from "vue";
import { useProseStore } from "../../stores/prose";

// Live `.prose` Markdown preview of the serialized program, plus import
// (paste/file) and export (download). The markdown is computed from the store
// tree, so it updates on every edit. Validation issues surface inline.
const store = useProseStore();
const prose = computed(() => store.prose);
const issues = computed(() => store.issues);
const copied = ref(false);

function copy(): void {
  navigator.clipboard.writeText(prose.value).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 1200);
  });
}

function download(): void {
  const content = prose.value;
  if (!content.trim()) return;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "program.prose";
  a.style.display = "none";
  // Some browsers refuse to trigger a download from a detached anchor, so
  // attach it to the DOM for the click and remove it right after. Defer
  // revokeObjectURL so the download has time to start.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function onFile(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    store.loadProse(text);
    input.value = "";
  });
}

function onPaste(ev: Event): void {
  const ta = ev.target as HTMLTextAreaElement;
  if (ta.value.trim()) store.loadProse(ta.value);
}
</script>

<template>
  <div class="prose-yaml">
    <div class="prose-yaml__bar">
      <button class="btn-secondary btn-sm" @click="copy">{{ copied ? "Copied" : "Copy" }}</button>
      <button class="btn-secondary btn-sm" @click="download">Download .prose</button>
      <label class="btn-secondary btn-sm prose-file-btn">
        Import file&hellip;
        <input type="file" accept=".prose,.md,.txt" @change="onFile" hidden />
      </label>
    </div>
    <pre class="prose-yaml__code">{{ prose }}</pre>
    <div v-if="issues.length > 0" class="prose-yaml__issues">
      <div v-for="(issue, i) in issues" :key="i" class="wf-issue" :data-level="issue.level">
        <span class="wf-issue__level">{{ issue.level }}</span>
        <span class="wf-issue__msg">{{ issue.message }}</span>
      </div>
    </div>
    <details class="prose-yaml__paste">
      <summary>Paste existing .prose program</summary>
      <textarea class="input form-textarea" rows="8" placeholder="agent researcher:..." @change="onPaste"></textarea>
    </details>
    <div class="prose-yaml__hint">
      Save the file into your workspace, then send <code>/prose run program.prose</code> in Chat.
      The OpenProse VM agent reads the program and executes it; <code>if&nbsp;**...**</code> branches are decided by the agent at run time.
    </div>
  </div>
</template>
