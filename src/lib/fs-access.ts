// File System Access API helpers (Chromium-only). When OpenClaw and web-chat
// run on the same machine, the browser can read/write the gateway workspace
// directly via a user-granted directory handle — bypassing the gateway's
// curated `agents.files.*` RPC (which can't read `.prose/runs/<id>/state.md`
// or write arbitrary `.prose` files).
//
// Browser support: Chrome/Edge. Firefox partial, Safari none. The caller
// checks `isFileSystemAccessSupported()` before offering the "connect
// workspace" UI.
//
// The handle is persisted in IndexedDB (structured-cloneable) so it survives
// reloads; on reload we re-request permission (browsers require re-grant for
// write, reads usually persist silently).

const DB_NAME = "openclaw-webchat";
const STORE = "fs-handles";
const HANDLE_KEY = "workspace-root";

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

// Minimal type shims — `showDirectoryPicker` and the readwrite permission
// APIs are in modern @types/dom but not all TS lib versions.
type PermissionMode = "read" | "readwrite";

interface FsDirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<FsHandle>;
  entries(): AsyncIterableIterator<[string, FsHandle]>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  /** Remove a child file or directory. `recursive` is required to remove a
   *  non-empty directory (matches the FS Access API spec). */
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
  queryPermission?(opts: { mode: PermissionMode }): Promise<PermissionState>;
  requestPermission?(opts: { mode: PermissionMode }): Promise<PermissionState>;
}

interface FsFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<{ name: string; lastModified: number; size: number; text(): Promise<string> }>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FsWritable>;
}

interface FsWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

type FsHandle = FsDirHandle | FsFileHandle;

interface ShowDirectoryPickerOpts {
  id?: string;
  mode?: PermissionMode;
}

declare global {
  interface Window {
    showDirectoryPicker?(opts?: ShowDirectoryPickerOpts): Promise<FsDirHandle>;
  }
}

// --- IndexedDB handle persistence ---

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(handle: FsDirHandle, key: string = HANDLE_KEY): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(key: string = HANDLE_KEY): Promise<FsDirHandle | null> {
  const db = await openDb();
  const result = await new Promise<FsDirHandle | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as FsDirHandle | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// --- Public API ---

/** Prompt the user to pick the workspace root with read+write access. */
export async function pickWorkspace(): Promise<FsDirHandle | null> {
  if (!window.showDirectoryPicker) return null;
  const handle = await window.showDirectoryPicker({ id: "openclaw-workspace", mode: "readwrite" });
  await idbPut(handle, HANDLE_KEY);
  return handle;
}

/** Restore a previously-persisted handle (or null). */
export async function restoreWorkspace(): Promise<FsDirHandle | null> {
  return idbGet(HANDLE_KEY);
}

/** Ensure the handle has the requested permission; returns true if granted. */
export async function ensurePermission(handle: FsDirHandle, mode: PermissionMode = "readwrite"): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  const current = await handle.queryPermission({ mode });
  if (current === "granted") return true;
  const requested = await handle.requestPermission({ mode });
  return requested === "granted";
}

export async function forgetWorkspace(): Promise<void> {
  await idbDelete(HANDLE_KEY);
}

export type WorkspaceDirHandle = FsDirHandle;

/** Write a file (verbatim) at the workspace root. */
export async function writeRootFile(handle: FsDirHandle, name: string, content: string): Promise<void> {
  const fileHandle = await handle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

/** Read a file at the workspace root. Returns null if missing. */
export async function readRootFileText(handle: FsDirHandle, name: string): Promise<string | null> {
  try {
    const fileHandle = await handle.getFileHandle(name);
    const file = await fileHandle.getFile();
    return file.text();
  } catch {
    return null;
  }
}

/** Write a file at a nested path (segments from root), creating intermediate
 *  directories as needed. The last segment is the file name; earlier segments
 *  are directories (created with create:true if missing). */
export async function writeNestedFile(handle: FsDirHandle, path: string[], content: string): Promise<void> {
  if (path.length === 0) return;
  let dir = handle;
  for (let i = 0; i < path.length - 1; i++) {
    dir = await dir.getDirectoryHandle(path[i]!, { create: true });
  }
  const fileHandle = await dir.getFileHandle(path[path.length - 1]!, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export interface RunDirEntry {
  name: string;
  /** ISO mtime of the run dir, for "newest first" ordering. */
  modifiedMs: number;
}

/** List immediate subdirectories of a path under the workspace root. */
export async function listDirs(handle: FsDirHandle, path: string[]): Promise<RunDirEntry[]> {
  let dir = handle;
  for (const segment of path) {
    dir = await dir.getDirectoryHandle(segment);
  }
  const out: RunDirEntry[] = [];
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== "directory") continue;
    // Directory handles don't expose mtime; approximate via the state.md file
    // inside, if present.
    let modifiedMs = 0;
    try {
      const state = await entry.getFileHandle("state.md");
      modifiedMs = (await state.getFile()).lastModified;
    } catch {
      // no state.md — leave 0
    }
    out.push({ name, modifiedMs });
  }
  return out;
}

/** Recursively delete a file or directory at a nested path. Used to remove
 *  a past Prose run under `.prose/runs/<id>/`. Walks to the parent directory,
 *  then calls `removeEntry({ recursive: true })` so non-empty dirs are
 *  removed in one shot. Returns true on success, false if the path is
 *  missing or the browser doesn't expose `removeEntry`. */
export async function deleteNestedPath(handle: FsDirHandle, path: string[]): Promise<boolean> {
  if (path.length === 0) return false;
  let dir = handle;
  for (let i = 0; i < path.length - 1; i += 1) {
    try {
      dir = await dir.getDirectoryHandle(path[i]!);
    } catch {
      return false;
    }
  }
  if (!dir.removeEntry) return false;
  try {
    await dir.removeEntry(path[path.length - 1]!, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Read a nested file (path segments from root). Null if any segment missing. */
export async function readNestedFileText(handle: FsDirHandle, path: string[]): Promise<string | null> {
  if (path.length === 0) return null;
  let dir = handle;
  for (let i = 0; i < path.length - 1; i++) {
    try {
      dir = await dir.getDirectoryHandle(path[i]!);
    } catch {
      return null;
    }
  }
  try {
    const fileHandle = await dir.getFileHandle(path[path.length - 1]!);
    const file = await fileHandle.getFile();
    return file.text();
  } catch {
    return null;
  }
}
