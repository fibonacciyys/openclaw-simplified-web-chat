// Workspace connection store: holds the File System Access API directory
// handle for the gateway workspace (same-machine, Chromium-only). When
// connected, the prose-run store writes the .prose program directly and reads
// `.prose/runs/<id>/state.md` directly — bypassing the gateway's curated
// `agents.files.*` RPC entirely.
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  ensurePermission,
  forgetWorkspace,
  isFileSystemAccessSupported,
  pickWorkspace,
  readNestedFileText,
  readRootFileText,
  restoreWorkspace,
  writeRootFile,
  writeNestedFile,
  listDirs,
  deleteNestedPath,
  type WorkspaceDirHandle,
} from "../lib/fs-access";

/** Workspace subdirectory that holds user-authored `.prose` source programs.
 *  Keeps Prose programs separate from other workspace contents (reports/,
 *  eval-cases/, etc.) and from the VM runtime state in `.prose/runs/`. */
export const PROSE_DIR = "prose";

/** Strip the `prose/` subfolder prefix from a workspace-relative file path
 *  recorded in state.md, so the UI shows the bare user-typed name. Returns
 *  null for empty/null input. */
export function stripProseDirPrefix(name: string | undefined | null): string | null {
  if (!name) return null;
  const prefix = `${PROSE_DIR}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const supported = ref<boolean>(isFileSystemAccessSupported());
  const handle = ref<WorkspaceDirHandle | null>(null);
  const connected = computed(() => handle.value !== null);
  const handleName = computed(() => handle.value?.name ?? "");
  const error = ref<string | null>(null);

  /** Restore a persisted handle on startup (does not re-prompt). Also
   *  pre-populates the run↔session cache so the chat sidebar can render
   *  prose badges without an extra file read on first render. */
  async function restore(): Promise<void> {
    if (!supported.value) return;
    const h = await restoreWorkspace();
    if (h) handle.value = h;
    // Best-effort cache population; non-fatal if the file is missing/invalid.
    try {
      await rebuildRunSessionCache();
    } catch {
      // ignore — caches stay empty, will be rebuilt on first write
    }
  }

  /** Prompt the user to pick the workspace root with read+write. */
  async function connect(): Promise<boolean> {
    if (!supported.value) {
      error.value = "File System Access API is only supported in Chrome/Edge.";
      return false;
    }
    try {
      const h = await pickWorkspace();
      if (!h) return false;
      handle.value = h;
      error.value = null;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Ensure the handle is permitted for readwrite; re-prompts if needed. */
  async function ensureWrite(): Promise<boolean> {
    if (!handle.value) return false;
    const ok = await ensurePermission(handle.value, "readwrite");
    if (!ok) error.value = "Workspace write permission denied.";
    return ok;
  }

  async function disconnect(): Promise<void> {
    await forgetWorkspace();
    handle.value = null;
  }

  async function writeFile(name: string, content: string): Promise<boolean> {
    if (!handle.value) return false;
    if (!(await ensureWrite())) return false;
    try {
      await writeRootFile(handle.value, name, content);
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Write a file at a nested path (segments from root), creating
   *  intermediate directories as needed. Used to write `.prose` programs
   *  under the `prose/` subdirectory. */
  async function writeNested(path: string[], content: string): Promise<boolean> {
    if (!handle.value) return false;
    if (!(await ensureWrite())) return false;
    try {
      await writeNestedFile(handle.value, path, content);
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  async function readFile(name: string): Promise<string | null> {
    if (!handle.value) return null;
    return readRootFileText(handle.value, name);
  }

  async function readNested(path: string[]): Promise<string | null> {
    if (!handle.value) return null;
    return readNestedFileText(handle.value, path);
  }

  async function listRuns(): Promise<{ name: string; modifiedMs: number }[]> {
    if (!handle.value) return [];
    try {
      const dirs = await listDirs(handle.value, [".prose", "runs"]);
      return [...dirs].sort((a, b) => b.modifiedMs - a.modifiedMs);
    } catch {
      return [];
    }
  }

  /** Recursively delete a file or directory at a nested path. Used to remove
   *  a past Prose run dir under `.prose/runs/<id>/`. Returns true on success. */
  async function deleteNested(path: string[]): Promise<boolean> {
    if (!handle.value) return false;
    if (!(await ensureWrite())) return false;
    try {
      return await deleteNestedPath(handle.value, path);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  // --- Run↔session mapping persistence ---
  //
  // Web-chat maintains its own index file at `.prose/runs/sessions.json` that
  // maps each chat session key to the prose run id (a `.prose/runs/<id>/`
  // directory created by the VM) that was launched in that session. The VM
  // owns `state.md` (per-run execution state) and doesn't record the chat
  // session there, so without this sidecar file the binding is lost on reload
  // or when switching runs.
  //
  // File format (sessionKey-indexed so the chat sidebar can do O(1) "does
  // this session have a prose run?" lookups): `{ "<sessionKey>": "<runId>" }`.
  //
  // Two reactive refs mirror the file in memory so both directions are O(1)
  // without re-reading the file:
  //   - `runSessionBindings` (forward, sessionKey → runId) — exposed for the
  //     chat sidebar to render a "prose" badge reactively.
  //   - `runSessionReverse` (reverse, runId → sessionKey) — used internally
  //     by `getSessionForRun` so prose `selectRun` can restore `runSessionKey`
  //     without iterating.
  //
  // The file lives alongside the run dirs but `listDirs` skips files, so it
  // doesn't pollute the runs history sidebar. Old format (`{ runId: sessionKey }`,
  // from the previous version of this code) is auto-migrated on first read:
  // any key matching the runId pattern (YYYYMMDD-HHMMSS-rand) is swapped and
  // the file is rewritten in the new format.
  const RUN_SESSION_MAP_PATH = [".prose", "runs", "sessions.json"];
  const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9]+$/i;

  const runSessionBindings = ref<Record<string, string>>({});
  const runSessionReverse = ref<Record<string, string>>({});
  let runSessionCachePopulated = false;

  /** Read the sidecar file, populate both reactive caches, auto-migrate old
   *  `{ runId: sessionKey }` format if detected. Safe to call repeatedly;
   *  subsequent calls re-read fresh from disk (cheap, small file). */
  async function rebuildRunSessionCache(): Promise<void> {
    const forward: Record<string, string> = {};
    const reverse: Record<string, string> = {};
    if (handle.value) {
      const text = await readNestedFileText(handle.value, RUN_SESSION_MAP_PATH);
      if (text) {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            let needsMigration = false;
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof v !== "string") continue;
              if (RUN_ID_PATTERN.test(k)) {
                // Old format: k is runId, v is sessionKey → swap.
                forward[v] = k;
                reverse[k] = v;
                needsMigration = true;
              } else {
                // New format: k is sessionKey, v is runId → keep.
                forward[k] = v;
                reverse[v] = k;
              }
            }
            if (needsMigration && (await ensurePermission(handle.value, "readwrite"))) {
              try {
                await writeNestedFile(handle.value, RUN_SESSION_MAP_PATH, `${JSON.stringify(forward, null, 2)}\n`);
              } catch {
                // migration write failed — non-fatal, cache is still correct
              }
            }
          }
        } catch {
          // invalid JSON — leave caches empty so we self-heal on next write
        }
      }
    }
    runSessionBindings.value = forward;
    runSessionReverse.value = reverse;
    runSessionCachePopulated = true;
  }

  async function ensureRunSessionCachePopulated(): Promise<void> {
    if (runSessionCachePopulated) return;
    await rebuildRunSessionCache();
  }

  /** Write the forward map to disk and rebuild both reactive caches. Assumes
   *  the caller has write permission already. */
  async function writeRunSessionMapAndRebuild(map: Record<string, string>): Promise<boolean> {
    if (!handle.value) return false;
    try {
      await writeNestedFile(handle.value, RUN_SESSION_MAP_PATH, `${JSON.stringify(map, null, 2)}\n`);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
    const reverse: Record<string, string> = {};
    for (const [sessionKey, runId] of Object.entries(map)) {
      reverse[runId] = sessionKey;
    }
    runSessionBindings.value = map;
    runSessionReverse.value = reverse;
    runSessionCachePopulated = true;
    return true;
  }

  /** Look up the runId bound to a chat session key (forward lookup, used by
   *  the chat sidebar). Returns null if not bound. */
  async function getRunForSession(sessionKey: string): Promise<string | null> {
    await ensureRunSessionCachePopulated();
    return runSessionBindings.value[sessionKey] ?? null;
  }

  /** Look up the chat session key bound to a run id (reverse lookup, used by
   *  prose `selectRun` / `continueFromHistory` to restore `runSessionKey`).
   *  Returns null if not bound. */
  async function getSessionForRun(runId: string): Promise<string | null> {
    await ensureRunSessionCachePopulated();
    return runSessionReverse.value[runId] ?? null;
  }

  /** Bind a run id to a chat session key. If the runId was previously bound
   *  to a different session, the old binding is dropped first (each runId
   *  appears at most once in the index). */
  async function setRunSession(runId: string, sessionKey: string): Promise<void> {
    await ensureRunSessionCachePopulated();
    const next: Record<string, string> = { ...runSessionBindings.value };
    // Drop any existing binding pointing at this runId (under a different
    // sessionKey) to keep the "each runId appears at most once" invariant.
    const existingSession = runSessionReverse.value[runId];
    if (existingSession && existingSession !== sessionKey) {
      delete next[existingSession];
    }
    if (next[sessionKey] === runId) return;
    next[sessionKey] = runId;
    await writeRunSessionMapAndRebuild(next);
  }

  /** Remove the binding for a run id (used when deleting a run). No-op if
   *  the runId isn't bound. Uses the reverse cache to find the sessionKey
   *  without iterating the forward map. */
  async function removeRunSession(runId: string): Promise<void> {
    await ensureRunSessionCachePopulated();
    const sessionKey = runSessionReverse.value[runId];
    if (!sessionKey) return;
    const next = { ...runSessionBindings.value };
    delete next[sessionKey];
    await writeRunSessionMapAndRebuild(next);
  }

  /** Remove the binding for a session key (used when deleting a chat session).
   *  Returns the runId that was bound (so callers can clear stale
   *  `runSessionKey` refs), or null if the session wasn't bound. */
  async function removeRunSessionForSession(sessionKey: string): Promise<string | null> {
    await ensureRunSessionCachePopulated();
    const runId = runSessionBindings.value[sessionKey];
    if (!runId) return null;
    const next = { ...runSessionBindings.value };
    delete next[sessionKey];
    await writeRunSessionMapAndRebuild(next);
    return runId;
  }

  return {
    supported,
    connected,
    handleName,
    error,
    runSessionBindings,
    restore,
    connect,
    ensureWrite,
    disconnect,
    writeFile,
    writeNested,
    readFile,
    readNested,
    listRuns,
    deleteNested,
    getRunForSession,
    getSessionForRun,
    setRunSession,
    removeRunSession,
    removeRunSessionForSession,
  };
});
