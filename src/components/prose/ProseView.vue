<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useProseStore } from "../../stores/prose";
import { useProseRunStore } from "../../stores/prose-run";
import { useConnectionStore } from "../../stores/connection";
import { useWorkspaceStore } from "../../stores/workspace";
import { bundledProseExamples } from "../../data/prose-examples";
import ProseInspector from "./ProseInspector.vue";
import ProsePreview from "./ProsePreview.vue";
import ProseRunsSidebar from "./ProseRunsSidebar.vue";
import ProseCanvas from "./ProseCanvas.vue";
import type { ProseNodeKind } from "../../lib/prose-types";

const emit = defineEmits<{ (e: "run-in-chat"): void }>();

const store = useProseStore();
const run = useProseRunStore();
const connection = useConnectionStore();
const workspace = useWorkspaceStore();
const tab = ref<"inspect" | "prose" | "run">("inspect");

// Restore the workspace directory handle (if previously granted) so reads
// of .prose/runs/<id>/state.md resume without re-prompting. Bundled examples
// need no workspace connection — they're inlined at build time.
onMounted(async () => {
  await workspace.restore();
  if (workspace.connected) await run.refresh();
});

// Delete the selected node on the Delete key. Ignored while focus is in an
// input/textarea/contenteditable so the key edits text instead of nodes.
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Delete") return;
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return;
  const id = store.selectedNodeId;
  if (!id) return;
  e.preventDefault();
  store.removeNode(id);
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

function add(kind: ProseNodeKind): void {
  store.addNode(kind);
  tab.value = "inspect";
}

function newProgram(): void {
  store.clear();
  store.addNode("agent");
}

// --- Examples (each builds a complete .prose program) ---

function seedIncidentTriage(): void {
  // use skill -> agent -> session -> if/elif/else (NL-judged) -> output.
  store.clear();
  const use = store.addNode("use");
  store.updateNodeData(use.id, { id: "use1", useSource: "incident-research", useAs: "research" });

  const analyst = store.addNode("agent");
  store.updateNodeData(analyst.id, {
    id: "agent1",
    name: "analyst",
    agentPrompt: "你分析事件并推荐严重级别。",
    agentSkills: ["research"],
  });

  const input = store.addNode("input");
  store.updateNodeData(input.id, { id: "input1", name: "incident_id", inputPrompt: "请输入事件 id" });

  const analysis = store.addNode("session");
  store.updateNodeData(analysis.id, {
    id: "session1",
    name: "analysis",
    sessionAgent: "analyst",
    sessionPromptOverride: "分析事件 ${incident_id} 并推荐严重级别。",
  });

  const ifNode = store.addNode("if");
  store.updateNodeData(ifNode.id, {
    id: "if1",
    ifDiscretion: { text: "事件严重，需要确定性上线审批", variant: "strong" },
  });
  const thenSession = addToBodySession(ifNode.id, "verdict", "通过 lobster 工具运行 critical-rollout 流水线。");

  const elifNode = store.addElif(ifNode.id)!;
  store.updateNodeData(elifNode.id, {
    id: "elif1",
    ifDiscretion: { text: "事件是常规问题", variant: "strong" },
  });
  const elifSession = addToBodySession(elifNode.id, "verdict", "通过 lobster 工具运行 routine-fix 流水线。");

  const elseNode = store.addElse(ifNode.id)!;
  const elseLog = addToBodySession(elseNode.id, "", "记录并关闭该事件。");
  void thenSession;
  void elifSession;
  void elseLog;

  const out = store.addNode("output");
  store.updateNodeData(out.id, { id: "output1", name: "verdict", outputExpr: "verdict" });
}

/** Helper: add a `name = session "prompt"` statement to a group's body. */
function addToBodySession(groupId: string, name: string, prompt: string) {
  const s = store.addToBody(groupId, "session")!;
  store.updateNodeData(s.id, { name: name || undefined, sessionPrompt: prompt });
  return s;
}

function seedOsDetect(): void {
  // Prose counterpart to the Lobster os-detect example. The branch condition
  // is a natural-language discretion (`if **检测到的平台是 win32**`) that the
  // VM agent evaluates semantically from the `os` session's output — NOT a
  // deterministic string equality like Lobster's `$detect.json.os eq`.
  //
  // The Windows branch asks for SSH credentials via `input` BEFORE connecting
  // (Prose `input name: "prompt"` pauses execution and waits for the user).
  store.clear();
  const runner = store.addNode("agent");
  store.updateNodeData(runner.id, {
    id: "agent1",
    name: "runner",
    agentPrompt: "你运行 shell 命令并简洁报告输出。",
  });

  const os = store.addNode("session");
  store.updateNodeData(os.id, {
    id: "session1",
    name: "os",
    sessionAgent: "runner",
    sessionPromptOverride: "检测本机系统。运行 `node -e \"console.log(process.platform)\"` 并报告平台（linux/win32/darwin）。",
  });

  const ifNode = store.addNode("if");
  store.updateNodeData(ifNode.id, {
    id: "if1",
    ifDiscretion: { text: "检测到的平台是 linux", variant: "strong" },
  });
  // Linux branch: view os-release locally.
  addToBodySession(ifNode.id, "result", "本地运行 `cat /etc/os-release` 并报告其内容。");

  const elifNode = store.addElif(ifNode.id)!;
  store.updateNodeData(elifNode.id, {
    id: "elif1",
    ifDiscretion: { text: "检测到的平台是 win32（Windows）", variant: "strong" },
  });
  // Windows branch: ask for host + credentials, then SSH.
  // NOTE: putting the password in the session prompt exposes it to the LLM —
  // this is illustrative; in production use SSH keys or a secret store.
  const host = store.addToBody(elifNode.id, "input")!;
  store.updateNodeData(host.id, { id: "input1", name: "ssh_host", inputPrompt: "请输入远程服务器 IP" });
  const acc = store.addToBody(elifNode.id, "input")!;
  store.updateNodeData(acc.id, { id: "input2", name: "ssh_account", inputPrompt: "请输入远程服务器账号" });
  const pwd = store.addToBody(elifNode.id, "input")!;
  store.updateNodeData(pwd.id, { id: "input3", name: "ssh_password", inputPrompt: "请输入远程服务器密码" });
  addToBodySession(
    elifNode.id,
    "result",
    "用账号 ${ssh_account} 和密码 ${ssh_password} 通过 SSH 连接 ${ssh_host}，运行 `cat /etc/os-release`，报告其内容。",
  );

  const elseNode = store.addElse(ifNode.id)!;
  addToBodySession(elseNode.id, "result", "报告该平台不受支持。");

  const out = store.addNode("output");
  store.updateNodeData(out.id, { id: "output1", name: "result", outputExpr: "result" });
}

function seedParallelResearch(): void {
  // Two research sessions run concurrently (parallel:), then a synthesizer
  // merges their outputs. Demonstrates Prose's `parallel:` + agent handoff.
  store.clear();
  const researcher = store.addNode("agent");
  store.updateNodeData(researcher.id, {
    id: "agent1",
    name: "researcher",
    agentPrompt: "你研究某个主题并返回简洁结论。",
  });
  const synthesizer = store.addNode("agent");
  store.updateNodeData(synthesizer.id, {
    id: "agent2",
    name: "synthesizer",
    agentPrompt: "你将多份研究输出合并为一份报告。",
  });

  const par = store.addNode("parallel");
  store.updateNodeData(par.id, { id: "parallel1", parallelJoin: "all" });
  const a = store.addBranch(par.id, "session")!;
  store.updateNodeData(a.id, {
    id: "session1",
    branchName: "a",
    sessionAgent: "researcher",
    sessionPromptOverride: "研究主题 A：OpenClaw 的历史。",
  });
  const b = store.addBranch(par.id, "session")!;
  store.updateNodeData(b.id, {
    id: "session2",
    branchName: "b",
    sessionAgent: "researcher",
    sessionPromptOverride: "研究主题 B：Lobster 运行时如何执行流水线。",
  });

  const report = store.addNode("session");
  store.updateNodeData(report.id, {
    id: "session3",
    name: "report",
    sessionAgent: "synthesizer",
    sessionPromptOverride: "将这些发现综合成一份报告。研究 A：${a}。研究 B：${b}。",
  });

  const out = store.addNode("output");
  store.updateNodeData(out.id, { id: "output1", name: "report", outputExpr: "report" });
}

const examples: { value: string; label: string; seed: () => void }[] = [
  { value: "incident-triage", label: "事件分拣 (if/elif/else + skill)", seed: seedIncidentTriage },
  { value: "os-detect", label: "OS 检测 → 分支 (NL 判断)", seed: seedOsDetect },
  { value: "parallel-research", label: "并行研究 + 综合", seed: seedParallelResearch },
];

// Bundled OpenProse example programs (shipped with web-chat). Loaded at build
// time via Vite's `import.meta.glob` from `src/data/prose-examples/`, so they
// work with no File System Access permission — important because the on-disk
// path (`~/.openclaw/plugin-skills/prose/examples/`) is a symlink target
// under `AppData\Roaming\npm\node_modules\`, which Chrome's Windows file
// picker refuses to grant access to ("contains system files").
const bundledExamples = bundledProseExamples;

function onExample(ev: Event): void {
  const sel = ev.target as HTMLSelectElement;
  const value = sel.value;
  sel.value = "";
  if (!value) return;

  // Builtin (hardcoded) examples use `builtin:<value>` and seed the canvas
  // programmatically (no .prose text parsing).
  if (value.startsWith("builtin:")) {
    const id = value.slice("builtin:".length);
    const ex = examples.find((e) => e.value === id);
    if (ex) {
      ex.seed();
      tab.value = "inspect";
    }
    return;
  }

  // Bundled .prose examples use `file:<label>` and parse the inlined source
  // text directly into the canvas.
  if (value.startsWith("file:")) {
    const label = value.slice("file:".length);
    const ex = bundledExamples.find((e) => e.label === label);
    if (ex) {
      store.clear();
      store.loadProse(ex.content);
      tab.value = "inspect";
    }
  }
}

const fileName = ref("program.prose");

// When a .prose file is imported via the Preview tab, adopt its name so the
// Run/Save targets match the file the user just opened.
function onImported(name: string): void {
  fileName.value = name;
}

// Sync the file-name input from the run store when a run is selected (or
// restored as draft) so the displayed name matches the selected history
// record. The user can still override the value before launching a new run;
// their edit is preserved until lastFileName changes again.
watch(
  () => run.lastFileName,
  (next) => {
    if (next) fileName.value = next;
  },
);

async function connectWorkspace(): Promise<void> {
  if (await workspace.connect()) {
    await run.refresh();
  }
}

async function disconnectWorkspace(): Promise<void> {
  await workspace.disconnect();
}

async function startRun(): Promise<void> {
  await run.startRun(fileName.value.trim() || "program.prose");
  if (run.runState !== "error") emit("run-in-chat");
}

async function continueRun(): Promise<void> {
  await run.continueRun(fileName.value.trim() || run.lastFileName || "program.prose");
  if (run.runState !== "error") emit("run-in-chat");
}

async function saveProse(): Promise<void> {
  await run.saveProse(fileName.value.trim() || "program.prose");
}

function stop(): void {
  run.stop();
}
</script>

<template>
  <div class="prose-view">
    <div class="wf-toolbar">
      <div class="wf-toolbar__left">
        <span class="wf-name-field"><strong>Prose program</strong></span>
      </div>
      <div class="wf-toolbar__right">
        <button class="btn-secondary btn-sm" @click="add('use')">+ use</button>
        <button class="btn-secondary btn-sm" @click="add('agent')">+ agent</button>
        <button class="btn-secondary btn-sm" @click="add('input')">+ input</button>
        <button class="btn-secondary btn-sm" @click="add('session')">+ session</button>
        <button class="btn-secondary btn-sm" @click="add('assign')">+ assign</button>
        <button class="btn-secondary btn-sm" @click="add('output')">+ output</button>
        <span class="wf-toolbar__sep" />
        <button class="btn-secondary btn-sm" @click="add('if')">+ if</button>
        <button class="btn-secondary btn-sm" @click="add('choice')">+ choice</button>
        <button class="btn-secondary btn-sm" @click="add('parallel')">+ parallel</button>
        <button class="btn-secondary btn-sm" @click="add('loop')">+ loop</button>
        <span class="wf-toolbar__sep" />
        <select class="input wf-example-select" @change="onExample" title="Load an example">
          <option value="">Examples…</option>
          <optgroup label="内置">
            <option v-for="ex in examples" :key="ex.value" :value="`builtin:${ex.value}`">{{ ex.label }}</option>
          </optgroup>
          <optgroup v-if="bundledExamples.length > 0" label="OpenProse 示例">
            <option v-for="ex in bundledExamples" :key="ex.label" :value="`file:${ex.label}`">{{ ex.label }}</option>
          </optgroup>
        </select>
        <button class="btn-secondary btn-sm" @click="newProgram">New</button>
      </div>
    </div>

    <div class="wf-body">
      <ProseRunsSidebar />
      <div class="wf-canvas-wrap">
        <ProseCanvas />
      </div>
      <aside class="wf-side">
        <div class="wf-tabs">
          <button class="wf-tab" :class="{ active: tab === 'inspect' }" @click="tab = 'inspect'">Inspect</button>
          <button class="wf-tab" :class="{ active: tab === 'prose' }" @click="tab = 'prose'">.prose</button>
          <button class="wf-tab" :class="{ active: tab === 'run' }" @click="tab = 'run'">Run</button>
        </div>
        <div class="wf-tab-body">
          <ProseInspector v-show="tab === 'inspect'" />
          <ProsePreview v-show="tab === 'prose'" @imported="onImported" />
          <div v-show="tab === 'run'" class="prose-run-panel">
            <!-- Workspace connection (File System Access API): lets the browser
                 write the .prose file directly + read .prose/runs/<id>/state.md
                 for structured per-block status. Chromium only. -->
            <div class="prose-workspace-bar">
              <button v-if="!workspace.connected" class="btn-secondary btn-sm" :disabled="!workspace.supported" @click="connectWorkspace" :title="workspace.supported ? '授权浏览器读写 agent workspace 目录（用于运行历史和逐块状态）' : '仅 Chrome/Edge 支持 File System Access API'">
                {{ workspace.supported ? "连接 workspace" : "浏览器不支持" }}
              </button>
              <span v-else class="prose-workspace-connected">
                ✓ workspace {{ workspace.handleName }} 已连接
                <button class="btn-secondary btn-sm" @click="disconnectWorkspace">断开</button>
              </span>
              <button v-if="workspace.connected" class="btn-secondary btn-sm" @click="run.refresh()">刷新运行历史</button>
              <span v-if="workspace.error" class="wf-run__error prose-workspace-err">{{ workspace.error }}</span>
            </div>

            <div class="prose-yaml__hint">
              <span v-if="workspace.connected">
                已连接 workspace：<strong>Run in chat</strong> 会把 <code>prose/{{ fileName || "program.prose" }}</code> 写入 workspace 的 <code>prose/</code> 子目录（浏览器直写，不经 agent），再发 <code>/prose run</code>。运行历史和逐块状态从 <code>.prose/runs/&lt;id&gt;/state.md</code> 直读。
              </span>
              <span v-else>
                <strong>Run in chat</strong> 会新建会话，让 agent 用 <code>write</code> 工具把程序写入 <code>prose/</code> 子目录再跑。连接 workspace（Chrome/Edge）后可直写文件 + 看逐块状态。
              </span>
            </div>
            <label class="form-label">
              <span>文件名（保存到 workspace 的 prose/ 子目录）</span>
              <input class="input" v-model="fileName" :disabled="run.runState === 'running'" />
            </label>
            <div class="prose-run__actions">
              <button class="btn-secondary" :disabled="!workspace.connected || run.saveState === 'saving'" @click="saveProse" :title="workspace.connected ? '把程序写入 workspace 的 prose/ 子目录（不运行）' : '连接 workspace 后才能保存'">
                {{ run.saveState === 'saving' ? 'Saving...' : run.saveState === 'done' ? 'Saved ✓' : 'Save' }}
              </button>
              <button class="btn-primary" :disabled="run.runState === 'running' || connection.status !== 'connected'" @click="startRun">
                {{ run.runState === 'running' ? 'Running...' : 'Run in chat' }}
              </button>
              <button class="btn-secondary" :disabled="run.runState === 'running' || connection.status !== 'connected'" @click="continueRun" title="Re-send /prose run; the VM resumes from .prose/runs/<id>/state.md (filesystem backend)">
                Continue
              </button>
              <button v-if="run.runState === 'running'" class="btn-stop" @click="stop">Stop watching</button>
            </div>

            <div class="prose-run__status" :data-status="run.runState">
              <span class="prose-run__dot" />
              <span>{{ run.runState }}</span>
              <span v-if="run.lastFileName" class="prose-run__file">{{ run.lastFileName }}</span>
              <span v-if="run.activeRunId" class="prose-run__file">run {{ run.activeRunId }}</span>
              <span v-if="run.activeSummary" class="prose-run__file">{{ run.activeSummary }}</span>
            </div>

            <div v-if="run.runError" class="wf-run__error">{{ run.runError }}</div>
            <div v-if="run.saveError" class="wf-run__error">{{ run.saveError }}</div>

            <!-- Active run's parsed state.md (structured per-block status). -->
            <div v-if="run.activeRunState" class="prose-run__section">
              <div class="prose-inspector__sub">活跃 run 逐块状态（state.md）</div>
              <div v-for="(c, i) in run.activeRunState.constructs" :key="i" class="prose-construct">
                <div class="prose-construct__title">{{ c.title }}<span v-if="c.lines" class="prose-construct__lines"> (lines {{ c.lines }})</span></div>
                <div v-for="(it, j) in c.items" :key="j" class="prose-construct__item">
                  <span class="prose-construct__label">{{ it.label }}</span>
                  <span class="prose-construct__status" :data-state="it.status">{{ it.status }}</span>
                </div>
              </div>
              <div v-if="run.activeRunState.executingMarker" class="prose-construct__exec">{{ run.activeRunState.executingMarker }}</div>
            </div>

            <!-- Live VM narration (the main session's freeform progress text).
                 Hidden when viewing a past run: narration isn't persisted on
                 disk, so showing the latest run's content under an older run
                 would be misleading. The state.md constructs panel above
                 covers past runs; this panel is for the in-progress / latest
                 run only. -->
            <div v-if="run.mainStream && !run.isViewingRun" class="prose-run__section">
              <div class="prose-inspector__sub">VM narration</div>
              <pre class="prose-run__stream">{{ run.mainStream }}</pre>
            </div>

            <!-- Spawned sub-session streams (real-time per-sub-agent output).
                 Same hide-when-viewing-past-run rule as VM narration: sub-
                 session streams aren't persisted per-run on disk. -->
            <div v-if="run.subSessionList.length > 0 && !run.isViewingRun" class="prose-run__section">
              <div class="prose-inspector__sub">Sub-agents ({{ run.subSessionList.length }})</div>
              <div v-for="s in run.subSessionList" :key="s.sessionKey" class="prose-subsession">
                <div class="prose-subsession__head">
                  <span class="prose-subsession__state" :data-state="s.state">{{ s.state }}</span>
                  <span class="prose-subsession__key">{{ s.agentId ?? s.sessionKey }}</span>
                </div>
                <pre class="prose-run__stream prose-run__stream--sub">{{ s.text || '(waiting...)' }}</pre>
              </div>
            </div>

            <!-- Run history now lives in the left sidebar; the right panel
                 shows the SELECTED run's per-block status + narration. -->

            <div class="prose-yaml__hint">
              <strong>Continue</strong> 重发 <code>/prose run prose/&lt;file&gt;</code>；OpenProse VM 从 <code>.prose/runs/&lt;id&gt;/state.md</code>（filesystem 后端）恢复。连接 workspace 后，左侧 sidebar 列出历史 run，点切换即加载该 run 的程序到画布。
            </div>

            <details class="prose-yaml__paste">
              <summary>Manual: download + run（未连接 workspace 时）</summary>
              <ol class="prose-run-steps">
                <li>在 <em>.prose</em> 标签页点 <strong>Download .prose</strong>。</li>
                <li>存进 agent workspace 的 <code>prose/</code> 子目录（需先创建该目录）。</li>
                <li>在 Chat 发 <code>/prose run prose/{{ fileName || 'program.prose' }}</code>。</li>
              </ol>
            </details>
            <div class="prose-yaml__hint">
              启用插件：<code>openclaw plugins enable open-prose</code> + <code>openclaw gateway restart</code>。浏览器需 Chrome/Edge 才能连接 workspace（File System Access API）。
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
