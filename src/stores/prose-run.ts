// Prose run lifecycle store.
//
// Two paths coexist for getting the .prose program into the workspace and
// reading back run state:
//  - PRIMARY (same-machine + Chromium): the File System Access API. The
//    workspace store holds a user-granted directory handle; this store writes
//    the .prose file DIRECTLY (verbatim, no agent in the loop) and reads
//    `.prose/runs/<id>/state.md` DIRECTLY for structured per-block status +
//    a runs list. This bypasses the gateway's curated `agents.files.*` RPC
//    entirely (which can't read state.md or write arbitrary .prose — see
//    src/gateway/server-methods/agents.ts:103,128).
//  - FALLBACK (no FS Access): delegate the file write to the agent via a chat
//    message (write+run), and rely on the VM narration / sub-session chat
//    events for progress (no structured per-block status).
//
// Real-time narration + spawned sub-session chat events are always captured
// via GatewayClient.addEventListener (the gateway broadcasts them —
// src/gateway/server-chat.ts:896-900), independent of which file path is used.
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { useConnectionStore } from "./connection";
import { useChatStore } from "./chat";
import { useSessionsStore } from "./sessions";
import { useProseStore } from "./prose";
import { useWorkspaceStore, PROSE_DIR, stripProseDirPrefix } from "./workspace";
import type { ChatEventPayload } from "../lib/types";
import type { ProseNodeData } from "../lib/prose-types";
import { parseStateMd, mapStateToNodeStatus, summarizeRunState, type ProseNodeStatus, type ProseRunState as ParsedState } from "../lib/prose-state-parse";
import { serializeProseWithLineMap } from "../lib/prose-serialize";

export type ProseRunState = "idle" | "running" | "done" | "error";

export interface SubSessionStream {
  sessionKey: string;
  spawnedBy?: string;
  agentId?: string;
  text: string;
  state: "delta" | "final" | "aborted" | "error" | "unknown";
  updatedAt: number;
}

export interface RunHistoryEntry {
  runId: string;
  modifiedMs: number;
  summary: string;
  state: ParsedState | null;
}

export const useProseRunStore = defineStore("prose-run", () => {
  const connection = useConnectionStore();
  const chat = useChatStore();
  const sessions = useSessionsStore();
  const prose = useProseStore();
  const workspace = useWorkspaceStore();

  const runState = ref<ProseRunState>("idle");
  const runError = ref<string | null>(null);
  const lastFileName = ref<string | null>(null);
  // The session the run lives in. startRun creates a fresh session so the
  // /prose run (and its VM narration + spawned sub-agents) doesn't pollute an
  // existing conversation; continueRun reuses it so the resumption appears in
  // the same transcript.
  const runSessionKey = ref<string | null>(null);
  // In-memory marker for the session key that the NEXT newly-discovered runId
  // (from polling) should be bound to. Set at start time when we know the
  // session key but the VM hasn't created the run dir yet; consumed and
  // cleared by the polling loop when it sees a new runId, which then writes
  // the binding to .prose/runs/sessions.json for persistence across reloads.
  const pendingSessionForNewRun = ref<string | null>(null);
  // The active run id (under .prose/runs/), discovered by polling the newest
  // run dir after /prose run starts.
  const activeRunId = ref<string | null>(null);
  // Parsed state.md of the active run (updated by polling).
  const activeRunState = ref<ParsedState | null>(null);
  // Per-node status derived from state.md + the serialized program's line map,
  // for canvas coloring (running/done/idle). Recomputed whenever the active run
  // state changes or a run is selected.
  const nodeStatus = ref<Record<string, ProseNodeStatus>>({});
  const mainStream = ref<string>("");
  const subSessions = ref<Map<string, SubSessionStream>>(new Map());
  const runsHistory = ref<RunHistoryEntry[]>([]);

  // Save-only status, kept separate from runState so saving a file doesn't
  // disturb the run lifecycle. Idle unless the user clicks Save.
  const saveState = ref<"idle" | "saving" | "done" | "error">("idle");
  const saveError = ref<string | null>(null);

  // Draft + viewing state for the left runs sidebar. The in-progress editor
  // program is the "draft"; selecting a past run loads its program into the
  // canvas (replacing the draft), and selecting the draft restores it. This
  // mirrors how chat's session sidebar swaps the transcript. The same
  // stash/restore applies to the file-name input so selecting a run shows
  // its program's name and going back to the draft restores the user's
  // in-progress name.
  const draftNodes = ref<ProseNodeData[] | null>(null);
  const draftFileName = ref<string | null>(null);
  const viewingRunId = ref<string | null>(null);
  const isViewingRun = computed(() => viewingRunId.value !== null);

  let unregister: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const subSessionList = computed(() =>
    [...subSessions.value.values()].sort((a, b) => a.updatedAt - b.updatedAt),
  );
  const activeSummary = computed(() => summarizeRunState(activeRunState.value));

  function errorMessage(err: unknown): string {
    if (err && typeof err === "object" && "message" in err) {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === "string" && msg.trim()) return msg;
    }
    return err instanceof Error ? err.message : String(err);
  }

  // --- Event listener: capture main run state + sub-session streams ---
  function onEvent(evt: { event?: string; payload?: unknown }): void {
    if (evt.event !== "chat") return;
    const p = evt.payload as ChatEventPayload | undefined;
    if (!p || typeof p !== "object") return;
    const mainKey = chat.sessionKey;
    if (p.sessionKey === mainKey) {
      handleMain(p);
      return;
    }
    if (p.spawnedBy === mainKey) {
      handleSub(p);
    }
  }

  function handleMain(p: ChatEventPayload): void {
    if (p.state === "delta") {
      const chunk = typeof p.deltaText === "string" ? p.deltaText : "";
      if (chunk) mainStream.value = (mainStream.value || "") + chunk;
      runState.value = "running";
      return;
    }
    if (p.state === "final") {
      runState.value = "done";
      return;
    }
    if (p.state === "aborted") {
      runState.value = "idle";
      return;
    }
    if (p.state === "error") {
      runState.value = "error";
      runError.value = p.errorMessage ?? "run failed";
    }
  }

  function handleSub(p: ChatEventPayload): void {
    const key = p.sessionKey;
    if (!key) return;
    const prev = subSessions.value.get(key);
    const chunk = typeof p.deltaText === "string" ? p.deltaText : "";
    const next: SubSessionStream = {
      sessionKey: key,
      spawnedBy: p.spawnedBy,
      agentId: p.agentId,
      text: (prev?.text ?? "") + chunk,
      state: p.state ?? "unknown",
      updatedAt: Date.now(),
    };
    const map = new Map(subSessions.value);
    map.set(key, next);
    subSessions.value = map;
  }

  function registerListener(): void {
    if (unregister) return;
    const c = connection.getClient();
    if (!c) return;
    unregister = c.addEventListener(onEvent);
  }
  function unregisterListener(): void {
    if (unregister) {
      unregister();
      unregister = null;
    }
  }

  function reset(): void {
    runState.value = "idle";
    runError.value = null;
    mainStream.value = "";
    subSessions.value = new Map();
    activeRunId.value = null;
    activeRunState.value = null;
    nodeStatus.value = {};
  }

  /** Recompute per-node canvas coloring from the active run's state.md mapped
   *  against the CURRENT editor program's line layout. Call after loading a
   *  run's program (so prose.nodes reflects that run) and after each poll. */
  function recomputeNodeStatus(): void {
    if (!activeRunState.value) {
      nodeStatus.value = {};
      return;
    }
    const { markdown, lineMap } = serializeProseWithLineMap(prose.nodes);
    nodeStatus.value = mapStateToNodeStatus(activeRunState.value, lineMap, markdown);
  }

  function startPolling(): void {
    stopPolling();
    // Poll .prose/runs/ for the newest dir, then read its state.md. The VM
    // creates the run dir shortly after /prose run starts; we discover it by
    // newest mtime. Poll every 1.5s while the run is active.
    pollTimer = setInterval(async () => {
      if (!workspace.connected) return;
      const runs = await workspace.listRuns();
      // Refresh the history list on every poll.
      await refreshHistory(runs);
      // Track the newest run (created after this run started) as active.
      const newest = runs[0];
      if (newest) {
        // When a new runId appears AND we have a pending session key from
        // start time (before the VM had created the run dir), persist the
        // binding to .prose/runs/sessions.json so it survives reloads and
        // can be restored by selectRun / continueFromHistory.
        if (
          pendingSessionForNewRun.value &&
          newest.name !== activeRunId.value &&
          newest.name !== viewingRunId.value
        ) {
          await workspace.setRunSession(newest.name, pendingSessionForNewRun.value);
          pendingSessionForNewRun.value = null;
        }
        activeRunId.value = newest.name;
        const md = await workspace.readNested([".prose", "runs", newest.name, "state.md"]);
        if (md) activeRunState.value = parseStateMd(md);
        recomputeNodeStatus();
      }
      // Stop polling once the run finished and state.md hasn't changed.
      if (runState.value === "done" || runState.value === "error") {
        stopPolling();
      }
    }, 1500);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refreshHistory(runs?: { name: string; modifiedMs: number }[]): Promise<void> {
    if (!workspace.connected) {
      runsHistory.value = [];
      return;
    }
    const list = runs ?? (await workspace.listRuns());
    const entries: RunHistoryEntry[] = [];
    for (const r of list.slice(0, 25)) {
      const md = await workspace.readNested([".prose", "runs", r.name, "state.md"]);
      const state = md ? parseStateMd(md) : null;
      entries.push({ runId: r.name, modifiedMs: r.modifiedMs, summary: summarizeRunState(state), state });
    }
    runsHistory.value = entries;
  }

  async function launch(fileName: string, mode: "start" | "continue"): Promise<void> {
    runError.value = null;
    const c = connection.getClient();
    if (!c) {
      runError.value = "Not connected to the gateway.";
      return;
    }
    if (mode === "start" && prose.issues.some((i) => i.level === "error")) {
      runError.value = "Fix validation errors first.";
      return;
    }
    if (!fileName.trim()) {
      runError.value = "Enter the .prose file name.";
      runState.value = "error";
      return;
    }
    reset();
    registerListener();
    try {
      // Start: create a fresh session so the run doesn't pollute an existing
      // conversation. Continue: reuse the run's session so the resumption
      // appears in the same transcript.
      if (mode === "start") {
        const key = await sessions.create();
        if (!key) {
          runError.value = sessions.error ?? "Could not create a session.";
          runState.value = "error";
          return;
        }
        await chat.setSession(key);
        runSessionKey.value = key;
        // Mark this session as pending for the next runId that polling
        // discovers. The VM creates the run dir asynchronously after
        // /prose run starts; when polling sees a new runId, it writes the
        // runId→sessionKey binding to .prose/runs/sessions.json.
        pendingSessionForNewRun.value = key;
      } else if (runSessionKey.value) {
        await chat.setSession(runSessionKey.value);
      }

      runState.value = "running";
      lastFileName.value = fileName;

      // Write the .prose program into the workspace's `prose/` subdirectory
      // (created on demand) so user programs don't litter the workspace root.
      // The path sent to the VM (`/prose run prose/<name>`) must match so it
      // finds the file at the same location. state.md then records the full
      // `prose/<name>` path, which selectRun strips back to the bare name.
      const fullPath = `${PROSE_DIR}/${fileName}`;

      // Write the .prose program to the workspace. Prefer the File System
      // Access API (direct, verbatim) when the workspace is connected; fall
      // back to asking the agent to write it (Chromium required for the
      // direct path — see fs-access.ts).
      let msg: string;
      if (mode === "start") {
        const written = workspace.connected && (await workspace.writeNested([PROSE_DIR, fileName], prose.prose));
        if (written) {
          msg = `/prose run ${fullPath}`;
        } else {
          // Fallback: delegate the write to the agent via chat. The control
          // UI can't write arbitrary workspace files without FS Access, but
          // the agent can via its `write` tool.
          msg =
            `用 write 工具把下面 \`\`\`prose 代码块里的内容原样写入文件 \`${fullPath}\`` +
            `（一字不改，不要加解释），写完后运行 \`/prose run ${fullPath}\`。\n\n\`\`\`prose\n${prose.prose}\n\`\`\``;
        }
      } else {
        // Continue: the file already exists under prose/; just re-run. The
        // VM resumes from .prose/runs/<id>/state.md (filesystem backend)
        // automatically.
        msg = `/prose run ${fullPath}`;
      }
      await chat.send(msg);

      // Begin polling state.md (only meaningful with FS Access, but harmless
      // otherwise — listRuns returns [] when not connected).
      if (workspace.connected) startPolling();
    } catch (err) {
      runState.value = "error";
      runError.value = errorMessage(err);
    }
  }

  /** Write the .prose program to the workspace's prose/ subdirectory without
   *  running it. Requires a connected workspace (File System Access API) for a
   *  direct browser write; without it the user should use Run in chat, which
   *  can delegate the write to the agent. */
  async function saveProse(fileName: string): Promise<void> {
    saveError.value = null;
    if (!fileName.trim()) {
      saveState.value = "error";
      saveError.value = "Enter the .prose file name.";
      return;
    }
    if (!workspace.connected) {
      saveState.value = "error";
      saveError.value = "Connect the workspace first to save files.";
      return;
    }
    saveState.value = "saving";
    try {
      const ok = await workspace.writeNested([PROSE_DIR, fileName], prose.prose);
      if (!ok) {
        saveState.value = "error";
        saveError.value = "Write failed.";
        return;
      }
      saveState.value = "done";
      lastFileName.value = fileName;
      setTimeout(() => {
        if (saveState.value === "done") saveState.value = "idle";
      }, 1500);
    } catch (err) {
      saveState.value = "error";
      saveError.value = errorMessage(err);
    }
  }

  async function startRun(fileName: string): Promise<void> {
    return launch(fileName, "start");
  }
  async function continueRun(fileName: string): Promise<void> {
    return launch(fileName, "continue");
  }
  /** Continue a past run from the history list (by run id / session). */
  async function continueFromHistory(runId: string, fileName: string): Promise<void> {
    lastFileName.value = fileName;
    activeRunId.value = runId;
    // Restore the run↔session binding from the sidecar index so the
    // resumption is sent to the run's original chat session, not whatever
    // runSessionKey happens to point at right now.
    const boundSession = await workspace.getSessionForRun(runId);
    if (boundSession) runSessionKey.value = boundSession;
    // Re-send /prose run to the run's session if we still have it.
    if (runSessionKey.value) {
      await chat.setSession(runSessionKey.value);
    }
    await launch(fileName, "continue");
  }

  function stop(): void {
    unregisterListener();
    stopPolling();
    runState.value = "idle";
  }

  /** Refresh the runs list on demand (called when the Run tab opens). */
  async function refresh(): Promise<void> {
    await refreshHistory();
  }

  /**
   * Select a past run from the left sidebar: load its `program.prose` into the
   * canvas (replacing the editor) + show its `state.md` as the active run.
   * The current editor program AND file-name input are stashed as a draft the
   * first time a run is viewed, restored by `selectDraft`.
   */
  async function selectRun(runId: string): Promise<void> {
    if (!workspace.connected) return;
    // Stash the current edit as the draft the first time we view a run.
    if (!viewingRunId.value) {
      draftNodes.value = prose.nodes.map((n) => ({ ...n }));
      draftFileName.value = lastFileName.value;
    }
    const program = await workspace.readNested([".prose", "runs", runId, "program.prose"]);
    if (program) prose.loadProse(program);
    const md = await workspace.readNested([".prose", "runs", runId, "state.md"]);
    activeRunState.value = md ? parseStateMd(md) : null;
    activeRunId.value = runId;
    viewingRunId.value = runId;
    // Restore the run↔session binding from the sidecar index so "Continue"
    // sends /prose run to the run's original chat session (not the latest
    // run's session). If the binding isn't recorded (e.g. run started from
    // another client), leave runSessionKey unchanged.
    const boundSession = await workspace.getSessionForRun(runId);
    if (boundSession) runSessionKey.value = boundSession;
    // state.md records the full workspace-relative path (e.g.
    // `prose/myprog.prose`); strip the `prose/` prefix so the file-name input
    // shows the bare user-typed name.
    const progName = stripProseDirPrefix(activeRunState.value?.program);
    if (progName) lastFileName.value = progName;
    // The loaded program IS this run's program; map state.md line ranges to
    // the editor nodes for canvas coloring.
    recomputeNodeStatus();
  }

  /** Switch back to the in-progress editor draft (leave run-viewing mode). */
  function selectDraft(): void {
    if (!viewingRunId.value) return;
    if (draftNodes.value) prose.setNodes(draftNodes.value);
    if (draftFileName.value !== null) lastFileName.value = draftFileName.value;
    viewingRunId.value = null;
    activeRunId.value = null;
    activeRunState.value = null;
    nodeStatus.value = {};
  }

  /**
   * Delete a past run's directory (`.prose/runs/<id>/`) from the workspace.
   * If the deleted run is the one currently being viewed, switch back to the
   * in-progress draft first so the canvas doesn't show a now-missing program.
   * Also removes the run↔session binding from `.prose/runs/sessions.json`
   * (so the sidecar index doesn't accumulate stale entries). If the bound
   * chat session is the current `runSessionKey`, clears it so the next
   * Continue doesn't try to reuse a session that's now orphaned.
   *
   * Returns true on success, false if the workspace isn't connected, the
   * browser doesn't support `removeEntry`, or the directory is missing.
   */
  async function deleteRun(runId: string): Promise<boolean> {
    if (!workspace.connected) {
      runError.value = "连接 workspace 才能删除 run。";
      return false;
    }
    if (viewingRunId.value === runId) {
      selectDraft();
    }
    const ok = await workspace.deleteNested([".prose", "runs", runId]);
    if (!ok) {
      runError.value = `删除 run ${runId} 失败（目录不存在或浏览器不支持 removeEntry）。`;
      return false;
    }
    // Drop the binding from the sidecar index. If this run's session is the
    // one we currently point at, clear runSessionKey so Continue doesn't
    // reuse an orphaned session.
    const boundSession = await workspace.getSessionForRun(runId);
    await workspace.removeRunSession(runId);
    if (boundSession && boundSession === runSessionKey.value) {
      runSessionKey.value = null;
      pendingSessionForNewRun.value = null;
    }
    runError.value = null;
    await refreshHistory();
    return true;
  }

  return {
    runState,
    runError,
    lastFileName,
    runSessionKey,
    activeRunId,
    activeRunState,
    activeSummary,
    nodeStatus,
    mainStream,
    subSessions,
    subSessionList,
    runsHistory,
    draftNodes,
    draftFileName,
    viewingRunId,
    isViewingRun,
    saveState,
    saveError,
    saveProse,
    startRun,
    continueRun,
    continueFromHistory,
    stop,
    refresh,
    selectRun,
    selectDraft,
    deleteRun,
  };
});
