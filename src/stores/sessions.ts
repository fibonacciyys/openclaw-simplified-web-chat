// Sessions store: list/create/subscribe gateway sessions.
import { defineStore } from "pinia";
import { ref } from "vue";
import type { SessionRow, SessionsCreateResult, SessionsListResult } from "../lib/types";
import { useConnectionStore } from "./connection";
import { useChatStore } from "./chat";

const ACTIVE_MINUTES = 120;
const LIST_LIMIT = 200;

export const useSessionsStore = defineStore("sessions", () => {
  const sessions = ref<SessionRow[]>([]);
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
        activeMinutes: ACTIVE_MINUTES,
        limit: LIST_LIMIT,
      });
      sessions.value = res.sessions ?? [];
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

  return { sessions, loading, error, load, subscribe, handleSessionsChanged, create, select };
});
