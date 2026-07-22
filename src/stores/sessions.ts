// Sessions store: list/create/subscribe gateway sessions.
import { defineStore } from "pinia";
import { ref } from "vue";
import type {
  SessionRow,
  SessionsCreateResult,
  SessionsDefaults,
  SessionsListResult,
} from "../lib/types";
import { useConnectionStore } from "./connection";
import { useChatStore } from "./chat";
import { useWorkspaceStore } from "./workspace";

const LIST_LIMIT = 200;

export const useSessionsStore = defineStore("sessions", () => {
  const sessions = ref<SessionRow[]>([]);
  const defaults = ref<SessionsDefaults | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  function client() {
    const c = useConnectionStore().getClient();
    if (!c) throw new Error("gateway not connected");
    return c;
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await client().request<SessionsListResult>("sessions.list", {
        includeGlobal: true,
        includeUnknown: true,
        limit: LIST_LIMIT,
      });
      sessions.value = res.sessions ?? [];
      defaults.value = res.defaults ?? null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function subscribe(): Promise<void> {
    try {
      await client().request("sessions.subscribe", {});
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleSessionsChanged(): Promise<void> {
    // Reload the index on any change. Cheap and keeps the sidebar fresh.
    await load();
  }

  async function create(): Promise<string | null> {
    // New conversation: let the gateway mint a fresh session key.
    try {
      const res = await client().request<SessionsCreateResult>("sessions.create", {});
      const key = typeof res?.key === "string" ? res.key.trim() : "";
      if (!key) {
        error.value = "sessions.create returned no key";
        return null;
      }
      await load();
      return key;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async function select(key: string): Promise<void> {
    await useChatStore().setSession(key);
  }

  /**
   * Delete a session via the gateway's `sessions.delete` RPC. The transcript
   * is deleted along with the record (deleteTranscript: true) so the chat
   * view clears. If the deleted session was the current one, switch to a
   * different session (the next remaining one, or create a fresh one if the
   * list is now empty) so the chat view doesn't point at a now-missing key.
   * Also drops any run↔session bindings that pointed at this session from
   * `.prose/runs/sessions.json` so the sidecar index doesn't accumulate
   * stale entries. Always reloads the session index after.
   */
  async function del(key: string): Promise<boolean> {
    try {
      await client().request("sessions.delete", { key, deleteTranscript: true });
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
    // Drop the run↔session binding pointing at the deleted session (if any).
    // The run itself stays on disk; selecting it in the prose sidebar will
    // leave runSessionKey unset. Returns the unbound runId, unused here.
    try {
      await useWorkspaceStore().removeRunSessionForSession(key);
    } catch {
      // workspace not connected or map file missing — non-fatal
    }
    await load();
    const chat = useChatStore();
    if (chat.sessionKey === key) {
      // Pick the first remaining session, or start a fresh one if none left.
      const next = sessions.value[0]?.key;
      if (next) {
        await chat.setSession(next);
      } else {
        const fresh = await create();
        if (fresh) await chat.setSession(fresh);
      }
    }
    return true;
  }

  return { sessions, defaults, loading, error, load, subscribe, handleSessionsChanged, create, select, del };
});
