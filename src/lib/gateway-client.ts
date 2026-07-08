// OpenClaw gateway WebSocket client (protocol v3, operator role).
// Mirrors ui/src/ui/gateway.ts (GatewayBrowserClient) but trimmed to the
// surfaces this app needs: connect handshake, RPC request/response, events.
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "./device-identity";
import { buildConnectDevice } from "./connect-payload";
import type {
  EventFrame,
  GatewayConnectParams,
  GatewayErrorShape,
  GatewayHelloOk,
  ResponseFrame,
} from "./types";

// Gateway protocol version (packages/gateway-protocol/src/version.ts).
// v2026.6.x speaks v4; min and max are both 4 for a modern client.
const PROTOCOL_VERSION = 4;
const MIN_CLIENT_PROTOCOL_VERSION = 4;
const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];
// Connect as the Control UI identity so the gateway's webchat session-mutation
// guard (src/gateway/server-methods/sessions.ts rejectWebchatSessionMutation)
// exempts this client via `client.id === CONTROL_UI`. That allows direct
// sessions.patch for per-session model selection (like the control UI) instead
// of routing through the /model slash command. Mirrors ui/src/ui/gateway.ts:696.
// Mode stays "webchat" to match the control UI's default connect mode.
const CLIENT_ID = "openclaw-control-ui";
const CLIENT_MODE = "webchat";
const CLIENT_VERSION = "0.1.0";
const CONNECT_QUEUE_MS = 750;
const INITIAL_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 15_000;
const BACKOFF_FACTOR = 1.7;
const REQUEST_TIMEOUT_MS = 30_000;
// 4008 = application-defined "connect failed" (browsers reject 1008).
const CONNECT_FAILED_CLOSE_CODE = 4008;
const STARTUP_RETRY_CLOSE_CODE = 4013;

export type GatewayCloseInfo = {
  code: number;
  reason: string;
  error?: GatewayErrorShape;
};

export type GatewayClientOptions = {
  url: string;
  token?: string | null;
  password?: string | null;
  onHello?: (hello: GatewayHelloOk) => void;
  onClose?: (info: GatewayCloseInfo) => void;
  onEvent?: (evt: EventFrame) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: GatewayErrorShape) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isNonRecoverableAuthError(error?: GatewayErrorShape): boolean {
  const code = error?.code ?? "";
  const detailCode = error?.details?.code ?? "";
  if (code === "AUTH_TOKEN_MISMATCH" || detailCode === "AUTH_TOKEN_MISMATCH") return true;
  if (code === "AUTH_REQUIRED" || detailCode === "AUTH_REQUIRED") return true;
  if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return true;
  return false;
}

function isStartupUnavailable(error?: GatewayErrorShape): boolean {
  const reason = error?.details?.reason ?? "";
  return reason === "startup-sidecars" || error?.retryable === true;
}

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/mac/i.test(ua)) return "macos";
  if (/win/i.test(ua)) return "windows";
  if (/linux/i.test(ua)) return "linux";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  return "web";
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(evt: EventFrame) => void>();
  private closed = false;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identityPromise: Promise<DeviceIdentity> | null = null;

  constructor(private opts: GatewayClientOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearConnectTimer();
    this.clearReconnectTimer();
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.connectSent;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    return this.requestOnSocket(this.ws, method, params) as Promise<T>;
  }

  addEventListener(listener: (evt: EventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- internals ---

  private getDeviceIdentity(): Promise<DeviceIdentity> {
    if (!this.identityPromise) {
      this.identityPromise = loadOrCreateDeviceIdentity();
    }
    return this.identityPromise;
  }

  private connect(): void {
    this.connectNonce = null;
    this.connectSent = false;
    this.clearConnectTimer();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.opts.onClose?.({
        code: 0,
        reason: `failed to open websocket: ${String(err)}`,
      });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.closed) return;
      // Wait briefly for a connect.challenge; send connect regardless after the
      // timer so we don't stall if the server doesn't send a challenge.
      this.connectTimer = setTimeout(() => {
        this.sendConnect().catch((err) => this.handleConnectError(toErrorShape(err)));
      }, CONNECT_QUEUE_MS);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      this.handleMessage(event.data);
    };
    ws.onclose = (event) => this.handleClose(event.code, event.reason);
    ws.onerror = () => {
      // surfaced via onclose; nothing to do here
    };
  }

  private handleMessage(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const f = frame as { type?: string };

    if (f.type === "event") {
      const evt = frame as EventFrame;
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: string } | undefined;
        this.connectNonce = payload?.nonce ?? null;
        this.clearConnectTimer();
        this.sendConnect().catch((err) => this.handleConnectError(toErrorShape(err)));
        return;
      }
      for (const listener of this.listeners) listener(evt);
      this.opts.onEvent?.(evt);
      return;
    }

    if (f.type === "res") {
      const res = frame as ResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(res.error ?? { code: "UNKNOWN", message: "gateway error" });
      }
      return;
    }
  }

  private requestOnSocket(ws: WebSocket, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "TIMEOUT", message: `request timed out: ${method}` });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject: reject as (e: GatewayErrorShape) => void, timer });
      const frame = { type: "req", id, method, params };
      ws.send(JSON.stringify(frame));
    });
  }

  private async sendConnect(): Promise<void> {
    if (this.connectSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.connectSent = true;
    const identity = await this.getDeviceIdentity();
    const device = await buildConnectDevice({
      deviceIdentity: identity,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: "operator",
      scopes: OPERATOR_SCOPES,
      authToken: this.opts.token ?? undefined,
      connectNonce: this.connectNonce,
    });
    const params: GatewayConnectParams = {
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: CLIENT_ID,
        version: CLIENT_VERSION,
        platform: detectPlatform(),
        mode: CLIENT_MODE,
        deviceFamily: "web",
      },
      role: "operator",
      scopes: OPERATOR_SCOPES,
      caps: ["tool-events"],
      device,
      auth: {
        token: this.opts.token ?? undefined,
        password: this.opts.password ?? undefined,
      },
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      locale: typeof navigator !== "undefined" ? navigator.language : undefined,
    };
    const hello = (await this.requestOnSocket(this.ws, "connect", params)) as GatewayHelloOk;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.opts.onHello?.(hello);
  }

  private handleConnectError(error: GatewayErrorShape): void {
    if (isNonRecoverableAuthError(error)) {
      // Surface to the UI; do not auto-reconnect an auth loop.
      this.opts.onClose?.({ code: CONNECT_FAILED_CLOSE_CODE, reason: error.message, error });
      this.stop();
      return;
    }
    if (isStartupUnavailable(error)) {
      const delay = error.details?.retryAfterMs ?? error.retryAfterMs ?? 1000;
      this.connectSent = false;
      this.scheduleReconnect(delay);
      return;
    }
    this.opts.onClose?.({ code: CONNECT_FAILED_CLOSE_CODE, reason: error.message, error });
    this.stop();
  }

  private handleClose(code: number, reason: string): void {
    this.clearConnectTimer();
    this.flushPending(new Error(`connection closed (${code})`));
    this.connectSent = false;
    if (this.closed) return;
    if (code === STARTUP_RETRY_CLOSE_CODE) {
      this.scheduleReconnect(1000);
      return;
    }
    if (code === CONNECT_FAILED_CLOSE_CODE) {
      this.opts.onClose?.({ code, reason: reason || "connect failed" });
      return;
    }
    this.opts.onClose?.({ code, reason: reason || "connection closed" });
    this.scheduleReconnect(this.backoffMs);
    this.backoffMs = Math.min(Math.round(this.backoffMs * BACKOFF_FACTOR), MAX_BACKOFF_MS);
  }

  private scheduleReconnect(delay: number): void {
    if (this.closed) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private flushPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject({ code: "DISCONNECTED", message: error.message });
      this.pending.delete(id);
    }
  }
}

function toErrorShape(err: unknown): GatewayErrorShape {
  if (err && typeof err === "object" && "code" in err) {
    return err as GatewayErrorShape;
  }
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
}
