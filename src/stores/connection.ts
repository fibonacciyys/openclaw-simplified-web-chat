// Connection store: owns the GatewayClient instance, handshake lifecycle, and
// event routing to the sessions/chat stores.
import { defineStore } from "pinia";
import { ref } from "vue";
import { GatewayClient, type GatewayCloseInfo } from "../lib/gateway-client";
import type { EventFrame, GatewayHelloOk } from "../lib/types";
import { useSessionsStore } from "./sessions";
import { useChatStore } from "./chat";

const SETTINGS_KEY = "openclaw-webchat-settings-v1";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

type PersistedSettings = {
  url?: string;
  token?: string;
  password?: string;
};

function readPersisted(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as PersistedSettings;
  } catch {
    // ignore
  }
  return {};
}

function writePersisted(settings: PersistedSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

function readUrlHashSettings(): Partial<PersistedSettings> {
  // Mirror the control UI: token via URL fragment (#token=...) is preferred;
  // gatewayUrl via fragment or query is also accepted.
  const out: Partial<PersistedSettings> = {};
  try {
    const href = new URL(window.location.href);
    const query = href.searchParams;
    const hash = href.hash.startsWith("#")
      ? new URLSearchParams(href.hash.slice(1))
      : new URLSearchParams();
    const token = hash.get("token") ?? query.get("token");
    const gatewayUrl = hash.get("gatewayUrl") ?? query.get("gatewayUrl");
    if (token) out.token = token;
    if (gatewayUrl) out.url = gatewayUrl;
  } catch {
    // ignore
  }
  return out;
}

export const useConnectionStore = defineStore("connection", () => {
  const persisted = { ...readPersisted(), ...readUrlHashSettings() };
  const url = ref(persisted.url ?? "ws://127.0.0.1:18789");
  const token = ref(persisted.token ?? "");
  const password = ref(persisted.password ?? "");
  const status = ref<ConnectionStatus>("disconnected");
  const hello = ref<GatewayHelloOk | null>(null);
  const lastError = ref<string | null>(null);

  let client: GatewayClient | null = null;

  function getClient(): GatewayClient | null {
    return client;
  }

  function saveSettings(): void {
    writePersisted({ url: url.value, token: token.value, password: password.value });
  }

  function setConnecting(): void {
    status.value = "connecting";
    lastError.value = null;
  }

  async function handleHello(helloOk: GatewayHelloOk): Promise<void> {
    hello.value = helloOk;
    status.value = "connected";
    lastError.value = null;
    const sessions = useSessionsStore();
    const chat = useChatStore();
    // Load the session index first, then resolve which session to render.
    await sessions.load();
    void sessions.subscribe();
    const current = chat.sessionKey;
    const exists = sessions.sessions.some((s) => s.key === current);
    if (exists || sessions.sessions.length === 0) {
      // Persisted key is still listed, or there is nothing to fall back to.
      // chat.history reads the transcript by key and does not require the
      // session to appear in the active list, so try it directly.
      await chat.loadHistory();
    } else {
      // Persisted key no longer exists: fall back to the most recent session
      // (sessions.list is sorted newest-first by updatedAt).
      await chat.setSession(sessions.sessions[0]!.key);
    }
  }

  function handleClose(info: GatewayCloseInfo): void {
    if (status.value === "connected" || status.value === "connecting") {
      status.value = "error";
      lastError.value = info.reason || `connection closed (${info.code})`;
    }
    hello.value = null;
  }

  function handleEvent(evt: EventFrame): void {
    const event = evt.event;
    if (event === "chat" || event === "session.message") {
      const chat = useChatStore();
      if (event === "chat") chat.handleChatEvent(evt.payload);
      else chat.handleSessionMessage(evt.payload);
      return;
    }
    if (event === "sessions.changed") {
      void useSessionsStore().handleSessionsChanged();
      return;
    }
    if (event === "shutdown") {
      status.value = "connecting";
      lastError.value = "gateway shutting down; reconnecting…";
    }
  }

  function connect(urlVal?: string, tokenVal?: string, passwordVal?: string): void {
    if (urlVal !== undefined) url.value = urlVal.trim();
    if (tokenVal !== undefined) token.value = tokenVal.trim();
    if (passwordVal !== undefined) password.value = passwordVal;
    saveSettings();
    if (client) client.stop();
    client = new GatewayClient({
      url: url.value,
      token: token.value || null,
      password: password.value || null,
      onHello: handleHello,
      onClose: handleClose,
      onEvent: handleEvent,
    });
    setConnecting();
    client.start();
  }

  function disconnect(): void {
    if (client) client.stop();
    client = null;
    status.value = "disconnected";
    hello.value = null;
    lastError.value = null;
  }

  return {
    url,
    token,
    password,
    status,
    hello,
    lastError,
    connect,
    disconnect,
    getClient,
  };
});
