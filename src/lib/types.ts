// OpenClaw gateway WebSocket protocol v3 types.
// Source of truth: src/gateway/protocol/schema/{frames,logs-chat,sessions}.ts
// These are the wire shapes a third-party operator client needs.

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayErrorShape;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

export type GatewayErrorShape = {
  code: string;
  message: string;
  details?: Record<string, unknown> & {
    code?: string;
    reason?: string;
    canRetryWithDeviceToken?: boolean;
    recommendedNextStep?: string;
    retryAfterMs?: number;
  };
  retryable?: boolean;
  retryAfterMs?: number;
};

// --- Handshake ---

export type GatewayConnectClientInfo = {
  id: string;
  displayName?: string;
  version: string;
  platform: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  // Valid gateway client modes (src/gateway/protocol/client-info.ts).
  mode: "webchat" | "cli" | "ui" | "backend" | "node" | "probe" | "test";
  instanceId?: string;
};

export type GatewayConnectDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

export type GatewayConnectAuth = {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
};

export type GatewayConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: GatewayConnectClientInfo;
  role: "operator";
  scopes: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  device?: GatewayConnectDevice;
  auth?: GatewayConnectAuth;
  locale?: string;
  userAgent?: string;
};

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server?: { version?: string; connId?: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth: {
    deviceToken?: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
  };
  canvasHostUrl?: string;
  policy?: {
    maxPayload?: number;
    maxBufferedBytes?: number;
    tickIntervalMs?: number;
  };
};

// --- Chat ---

export type ChatEventPayload = {
  runId?: string;
  sessionKey: string;
  agentId?: string;
  spawnedBy?: string;
  seq?: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  // Protocol v4 delta fields (packages/gateway-protocol/src/schema/logs-chat.ts):
  // `deltaText` is the incremental chunk; `replace: true` marks a full-content
  // refresh. `message` carries the cumulative snapshot when present.
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
  errorKind?: "refusal" | "timeout" | "rate_limit" | "context_length" | "unknown";
  usage?: unknown;
  stopReason?: string;
};

// Transcript messages are typed as `unknown` on the wire (Type.Unknown() in the
// schema). The conventional shape is below; normalize defensively at runtime.
export type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  textSignature?: string;
  // Tool-use / tool-result fields (mirrors src/shared/chat-message-content.ts).
  name?: string;
  toolCallId?: string;
  tool_call_id?: string;
  callId?: string;
  id?: string;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
  content?: string | ContentBlock[];
  isError?: boolean;
  is_error?: boolean;
};

export type TranscriptMessage = {
  role?: string;
  content?: string | ContentBlock[];
  text?: string;
  timestamp?: number;
  id?: string;
  // Top-level tool-call id for standalone tool-result messages (role: tool).
  toolCallId?: string;
  tool_call_id?: string;
  toolName?: string;
  tool_name?: string;
};

export type ChatSendParams = {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  idempotencyKey: string;
  sessionId?: string;
  thinking?: string;
};

export type ChatSendResult = {
  runId?: string;
  status?: "started" | "in_flight";
};

export type ChatAbortParams = {
  sessionKey: string;
  runId?: string;
};

export type ChatHistoryResult = {
  sessionKey?: string;
  sessionId?: string;
  messages?: TranscriptMessage[];
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
};

// Thinking-level option exposed by the gateway per session row / defaults.
// Mirrors src/shared/session-types.ts GatewayThinkingLevelOption.
export type ThinkingLevelOption = {
  id: string;
  label: string;
};

// --- Sessions ---

export type SessionRow = {
  key: string;
  kind?: "cron" | "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  updatedAt: number | null;
  sessionId?: string;
  hasActiveRun?: boolean;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
  archived?: boolean;
  model?: string;
  modelProvider?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  agentRuntime?: { id?: string; fallback?: boolean; source?: string };
  // Per-session thinking override (string) or cleared (null/undefined means
  // inherit the configured/provider default). Mirrors
  // src/gateway/session-utils.types.ts GatewaySessionRow.thinkingLevel.
  thinkingLevel?: string | null;
  // Profile-driven level set for the row's current model. When absent the
  // client falls back to base levels (see lib/thinking.ts).
  thinkingLevels?: ThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

// Defaults echoed by sessions.list (src/shared/session-types.ts
// SessionsListResultBase). Only the model + thinking fields this client renders.
export type SessionsDefaults = {
  model?: string | null;
  modelProvider?: string | null;
  thinkingLevels?: ThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

export type SessionsListResult = {
  ts?: number;
  count?: number;
  totalCount?: number;
  hasMore?: boolean;
  defaults?: SessionsDefaults;
  sessions: SessionRow[];
};

export type SessionsCreateParams = {
  key?: string;
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  message?: string;
};

export type SessionsCreateResult = {
  ok?: boolean;
  key?: string;
  sessionId?: string;
  runStarted?: boolean;
};

// sessions.patch with `model` sets/clears the per-session model override.
// `model: null` clears it so the session falls back to defaults. Mirrors
// packages/gateway-protocol/src/index.ts SessionsPatchResult.
export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry?: Record<string, unknown>;
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: { id?: string; fallback?: string; source?: string };
  };
};

// Model catalog entry returned by models.list (view: "configured").
// Mirrors packages/gateway-protocol/src/schema/agents-models-skills.ts
// ModelChoiceSchema / ui/src/ui/types.ts ModelCatalogEntry.
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export type ModelsListResult = {
  models: ModelCatalogEntry[];
};
