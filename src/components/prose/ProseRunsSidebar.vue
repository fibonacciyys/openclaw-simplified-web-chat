<script setup lang="ts">
import { useProseRunStore } from "../../stores/prose-run";
import { useWorkspaceStore, stripProseDirPrefix } from "../../stores/workspace";

// Left sidebar listing past Prose runs (read from .prose/runs/ via the File
// System Access API). Mirrors the chat SessionSidebar: click a run to load
// its program into the canvas; click "当前编辑" to restore the in-progress
// draft; click the × on a run to delete it.
const run = useProseRunStore();
const workspace = useWorkspaceStore();

function shortId(runId: string): string {
  // runId is {YYYYMMDD}-{HHMMSS}-{rand6}; show the time portion.
  const parts = runId.split("-");
  return parts.length >= 2 ? `${parts[0]!.slice(4)}/${parts[1]!.slice(0, 2)}:${parts[1]!.slice(2, 4)}` : runId;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return `${Math.round(hr / 24)}天前`;
}

async function onDeleteRun(ev: Event, runId: string, label: string): Promise<void> {
  // Stop propagation so clicking × doesn't also select the run.
  ev.stopPropagation();
  ev.preventDefault();
  const progName = label || shortId(runId);
  if (!window.confirm(`删除 run "${progName}"？\n\n这会删掉 .prose/runs/${runId}/ 整个目录（包括 state.md、program.prose 等运行态文件），不可恢复。`)) {
    return;
  }
  await run.deleteRun(runId);
}
</script>

<template>
  <aside class="sidebar prose-runs-sidebar">
    <button
      class="sidebar-item prose-runs-draft"
      :class="{ active: !run.isViewingRun }"
      @click="run.selectDraft()"
    >
      <div class="sidebar-item-title">✏️ 当前编辑</div>
      <div class="sidebar-item-meta">
        <span>{{ run.isViewingRun ? "查看 run 时不可用" : "正在编辑" }}</span>
      </div>
    </button>
    <div v-if="!workspace.connected" class="sidebar-empty prose-runs-empty">
      连接 workspace 后显示运行历史。
    </div>
    <div v-else class="sidebar-list">
      <div
        v-for="r in run.runsHistory"
        :key="r.runId"
        class="sidebar-item prose-runs-item"
        :class="{ active: run.viewingRunId === r.runId }"
        @click="run.selectRun(r.runId)"
      >
        <div class="sidebar-item-title">{{ stripProseDirPrefix(r.state?.program) || shortId(r.runId) }}</div>
        <div class="sidebar-item-meta">
          <span class="prose-runs-summary" :data-state="r.summary">{{ r.summary }}</span>
          <span v-if="r.modifiedMs">{{ relativeTime(r.modifiedMs) }}</span>
        </div>
        <button
          class="sidebar-item-delete"
          title="删除此 run"
          @click="onDeleteRun($event, r.runId, stripProseDirPrefix(r.state?.program) ?? '')"
        >×</button>
      </div>
      <div v-if="run.runsHistory.length === 0" class="sidebar-empty">还没有 run。</div>
    </div>
    <div v-if="run.runError" class="sidebar-empty prose-runs-empty">{{ run.runError }}</div>
  </aside>
</template>
