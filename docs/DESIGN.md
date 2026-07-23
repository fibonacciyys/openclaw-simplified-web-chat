# Design: OpenClaw Gateway Protocol Adapter

This document describes how `openclaw-simplified-web-chat` talks to the
OpenClaw gateway over WebSocket. It is a precise reference of the wire
contracts this client relies on, the control-flow invariants the gateway
expects, and where each piece is implemented.

The authoritative protocol schemas live in the OpenClaw repo under
`packages/gateway-protocol/src/schema/`. This client mirrors only the subset
it needs; type definitions are in `src/lib/types.ts` and the transport client
is `src/lib/gateway-client.ts`.

## 1. Transport and framing

- **Transport**: a single long-lived WebSocket (text frames only, JSON
  encoded). Default URL `ws://127.0.0.1:18789`.
- **Protocol version**: `4` (`minProtocol = maxProtocol = 4`), matching the
  `v2026.6.x` gateway train. See `src/lib/gateway-client.ts:16`.
- **Frame envelope** — three discriminated frame types
  (`packages/gateway-protocol/src/schema/frames.ts`):

  | `type` | Direction   | Fields                                    | Purpose                          |
  | ------ | ----------- | ----------------------------------------- | -------------------------------- |
  | `req`  | client→srv  | `id`, `method`, `params?`                 | RPC request                      |
  | `res`  | srv→client  | `id`, `ok`, `payload?`, `error?`          | RPC response paired to a `req.id`|
  | `event`| srv→client  | `event`, `payload?`, `seq?`, `stateVersion?` | unsolicited server push        |

  ```jsonc
  // request
  { "type": "req", "id": "<uuid>", "method": "sessions.list", "params": { ... } }
  // success response
  { "type": "res", "id": "<uuid>", "ok": true, "payload": { ... } }
  // error response
  { "type": "res", "id": "<uuid>", "ok": false, "error": { "code": "...", "message": "..." } }
  // event
  { "type": "event", "event": "chat", "payload": { ... }, "seq": 42 }
  ```

- **Request lifecycle**: the client mints a UUID `id`, sends the `req`, and
  resolves/rejects the matching `res`. Requests time out after 30s
  (`REQUEST_TIMEOUT_MS`). On socket close all pending requests are rejected
  with `DISCONNECTED`. Implementation: `GatewayClient.request` /
  `requestOnSocket` in `src/lib/gateway-client.ts:122,217`.

- **Structured error shape** (`ErrorShapeSchema`):
  ```ts
  { code: string; message: string; details?: unknown;
    retryable?: boolean; retryAfterMs?: number }
  ```
  This client treats `AUTH_TOKEN_MISMATCH` / `AUTH_REQUIRED` / `FORBIDDEN` /
  `UNAUTHORIZED` as non-recoverable (no reconnect loop) and
  `details.reason === "startup-sidecars"` / `retryable === true` as a
  reconnectable startup-unavailable signal.

## 2. Connect handshake

Before the gateway accepts any other `req`, the client must complete a
`connect` handshake. The flow is challenge-response with an Ed25519-signed
device identity, mirroring the control UI (`ui/src/ui/gateway.ts`,
`ui/src/ui/device-identity.ts`).

```
client                              gateway
  │                                    │
  │ ──── WebSocket open ─────────────► │
  │                                    │
  │ ◄── event "connect.challenge" ──── │  payload: { nonce }
  │                                    │
  │ ─── req "connect" (signed) ──────► │
  │                                    │
  │ ◄── res hello-ok ───────────────── │
  │                                    │
  │ ─── normal req/res + events ─────► │
```

- **`connect.challenge` event**: payload `{ nonce: string }`. The client
  stores the nonce and fires `connect`. If no challenge arrives within
  `CONNECT_QUEUE_MS` (750ms) the client sends `connect` anyway with an empty
  nonce, so it does not stall against servers that skip the challenge.
- **`connect` request params** (`ConnectParamsSchema`,
  `src/lib/types.ts:73`):
  ```ts
  {
    minProtocol: 4, maxProtocol: 4,
    client: { id: "openclaw-control-ui", version, platform, mode: "webchat", deviceFamily: "web" },
    role: "operator",
    scopes: ["operator.admin","operator.read","operator.write",
             "operator.approvals","operator.pairing"],
    caps: ["tool-events"],
    device: { id, publicKey, signature, signedAt, nonce },
    auth: { token?, password? },
    locale?, userAgent?
  }
  ```
  The client connects with the **Control UI identity**
  (`client.id = "openclaw-control-ui"`, `src/lib/gateway-client.ts`), matching
  `ui/src/ui/gateway.ts:696`. The gateway then exempts this client from the
  webchat session-mutation guard (§4), so `sessions.patch` is available
  directly for per-session model selection (§6). This also triggers the
  Control UI origin check and device-identity policy
  (`src/gateway/server/ws-connection/message-handler.ts:854`): origin must be
  allowed (loopback auto-OK; remote must be in
  `gateway.controlUi.allowedOrigins`) and the Ed25519 device handshake below
  is required — both already implemented.
- **`hello-ok` response** (`HelloOkSchema`, `src/lib/types.ts:89`): negotiated
  `protocol`, `server.version`, `features.methods/events`, an initial
  `snapshot`, `auth.role/scopes`, and `policy` limits. On `hello-ok` the
  client transitions to `connected` and bootstraps stores
  (`src/stores/connection.ts:82`).

### Ed25519 device identity

`src/lib/device-identity.ts` + `src/lib/connect-payload.ts`.

- A keypair is generated **once** with `@noble/ed25519`, persisted in
  `localStorage` (`openclaw-webchat-device-identity-v1`), and reused across
  sessions. `deviceId = sha256(publicKey)` (hex).
- The signed payload is the `v2` format (`buildDeviceAuthPayload`):
  ```
  v2|<deviceId>|<clientId>|<clientMode>|<role>|<scopesCsv>|<signedAtMs>|<token>|<nonce>
  ```
  signed with Ed25519 over the UTF-8 bytes; signature + public key are
  base64url-encoded. This lets the gateway **pair** the device on first
  connect and **auto-approve** loopback connections on subsequent connects —
  the same behavior as the control UI.

### Auth modes

- **Shared-secret token** (default): the gateway token goes in `auth.token`
  and is also folded into the `v2` signed payload. Mismatch →
  `AUTH_TOKEN_MISMATCH`, treated as non-recoverable.
- Loopback break-glass options (gateway config, not client): `gateway.auth.mode: "none"` skips connect auth; `gateway.controlUi.dangerouslyDisableDeviceAuth: true` skips device pairing.
- Token/URL are sourced from (in priority order) the URL fragment/query
  (`#token=…`, `#gatewayUrl=…`) then persisted `localStorage` settings
  (`src/stores/connection.ts:38`).

### Reconnection

- Exponential backoff `800ms → 15s` (factor 1.7) on transport close.
- Close code `4013` (startup retry) → reconnect after 1s.
- `shutdown` event → set status `connecting`, surface "gateway shutting down;
  reconnecting…", and let backoff take over.
- Non-recoverable auth errors stop the client and surface the error to the
  connection bar instead of looping.

## 3. Events

The client subscribes to server-pushed events via `GatewayClient.addEventListener`
and routes them in `src/stores/connection.ts:113`:

| Event              | Routed to                         | Effect                                                     |
| ------------------ | --------------------------------- | ---------------------------------------------------------- |
| `connect.challenge`| `GatewayClient` (internal)        | Drives the handshake; not exposed to stores.               |
| `chat`             | `chat.handleChatEvent(payload)`   | Streaming assistant reply (see §5).                        |
| `session.message`  | `chat.handleSessionMessage(payload)` | Reload transcript when no run is active (see §5).       |
| `sessions.changed` | `sessions.handleSessionsChanged()`| Reload the session index (cheap full refresh).            |
| `shutdown`         | connection store                  | Mark reconnecting; backoff reconnects.                     |
| `tick`             | (ignored)                         | Heartbeat; no-op here.                                     |

## 4. Sessions protocol

Source schemas: `packages/gateway-protocol/src/schema/sessions.ts` and
`src/shared/session-types.ts`. Client store: `src/stores/sessions.ts`.

### `sessions.list`

```jsonc
// req
{ "method": "sessions.list",
  "params": { "includeGlobal": true, "includeUnknown": true, "limit": 200 } }
// res payload (SessionsListResultBase)
{ "ts": 0, "path": "", "count": 0,
  "defaults": { "model": "openai/gpt-5.5", "modelProvider": "openai" },
  "sessions": [ { "key": "...", "model": "...", "modelProvider": "...", ... } ] }
```

- Returns `defaults` (the configured default model + provider) **and** the
  session rows. Each `SessionRow` carries its own `model` / `modelProvider`
  when a per-session override is set.
- This client persists `defaults` in the sessions store (used by the model
  picker's "Default" option) and keeps the row list for the sidebar.

### `sessions.create`

```jsonc
{ "method": "sessions.create", "params": {} }
// res
{ "ok": true, "key": "<newSessionKey>", "sessionId": "...", "runStarted": false }
```

No-arg create lets the gateway mint a fresh key. Optional params (not used
here): `key`, `agentId`, `label`, `model`, `parentSessionKey`, `message`.

### `sessions.subscribe`

```jsonc
{ "method": "sessions.subscribe", "params": {} }
```

Opts the connection into `sessions.changed` events. Called once after the
initial `sessions.list` in `handleHello`.

### `sessions.patch` (per-session model override)

This is the core of the per-conversation model feature
(`packages/gateway-protocol/src/schema/sessions.ts:299`,
`ui/src/ui/chat/session-controls.ts:1371`).

```jsonc
// set a model for this session
{ "method": "sessions.patch", "params": { "key": "<sessionKey>", "model": "anthropic/claude-sonnet-4-6" } }
// clear the override → fall back to defaults.model
{ "method": "sessions.patch", "params": { "key": "<sessionKey>", "model": null } }
// res
{ "ok": true, "path": "...", "key": "<sessionKey>", "entry": { ... },
  "resolved": { "model": "claude-sonnet-4-6", "modelProvider": "anthropic" } }
```

- `model: string` sets the override; `model: null` clears it.
- `resolved` echoes the authoritative provider-qualified model the server
  will use, which may differ from the requested id (alias resolution,
  provider inference from the catalog).
- **Gateway guard**: `rejectWebchatSessionMutation`
  (`src/gateway/server-methods/sessions.ts:326`) rejects `sessions.patch`
  (and `delete`/`compact`/`restore`) from any webchat client
  (`isWebchatClient` = `mode === "webchat"` or `id === "webchat-ui"`,
  `src/utils/message-channel.ts:73`) **except** the Control UI
  (`client.id === "openclaw-control-ui"`, `sessions.ts:335`).
- **This client connects as the Control UI** (`src/lib/gateway-client.ts`
  `CLIENT_ID = "openclaw-control-ui"`, see §2), so it is exempt and calls
  `sessions.patch` directly — no `/model` slash command, no transcript
  pollution, immediate optimistic update.
- Client flow (`src/stores/models.ts:setModel`): write an optimistic
  per-session override → `sessions.patch` → on success reload
  `sessions.list` and drop the override (the fresh row is authoritative) →
  on failure roll the override back and surface the error.

## 5. Chat protocol

Source schema: `packages/gateway-protocol/src/schema/logs-chat.ts`.
Client store: `src/stores/chat.ts`.

### `chat.send`

```jsonc
{ "method": "chat.send",
  "params": { "sessionKey": "...", "message": "...", "deliver": false,
              "idempotencyKey": "<uuid>", "sessionId": "..." } }
// res
{ "runId": "...", "status": "started" }   // status: "started" | "in_flight"
```

- `idempotencyKey` makes retries safe across transport failures; the client
  uses a freshly minted UUID per send and tracks it as the active `runId`.
- `deliver: false` keeps the message in the operator transcript only (does
  not push to a downstream channel) — matches the control UI chat flow.
- The assistant reply is **not** in the `chat.send` response. It streams in
  via `chat` events (below).

### `chat.abort`

```jsonc
{ "method": "chat.abort",
  "params": { "sessionKey": "...", "runId": "..." } }
```

Cancels the active run (or a named `runId`). The run then terminates with an
`aborted` chat event.

### `chat.history`

```jsonc
{ "method": "chat.history", "params": { "sessionKey": "...", "limit": 200 } }
// res
{ "sessionKey": "...", "sessionId": "...", "messages": [ ... ],
  "thinkingLevel": "...", "fastMode": false, "verboseLevel": "..." }
```

`messages` are `Type.Unknown()` on the wire; the client normalizes them
defensively (`src/lib/extract-text.ts`) and hides purely-silent/tool-only
history rows.

### `chat` streaming events

A run emits a sequence of `chat` events with `state` transitions
`delta → final | aborted | error` (`ChatEventSchema`):

```ts
// common base
{ runId, sessionKey, agentId?, spawnedBy?, seq }
```

| `state`   | Extra fields                                  | Meaning                                    |
| --------- | --------------------------------------------- | ------------------------------------------ |
| `delta`   | `deltaText`, `replace?`, `message?`, `usage?` | Incremental assistant output.             |
| `final`   | `message?`, `usage?`, `stopReason?`           | Successful terminal; commit the message.  |
| `aborted` | `message?`, `stopReason?`                     | Cancelled; finalize partial output.        |
| `error`   | `errorMessage?`, `errorKind?`, `usage?`       | Failed run; `errorKind`: refusal/timeout/rate_limit/context_length/unknown. |

**Stream text resolution** (`resolveDeltaChatStreamText` in
`src/stores/chat.ts:47`, mirroring `ui/src/ui/controllers/chat.ts`):
- `deltaText` + `replace: true` → full-content refresh; replace the stream.
- `deltaText` (incremental) + a cumulative `message` snapshot → verify the
  snapshot prefix matches the current stream, then append `deltaText`; if
  the prefix check fails, fall back to the snapshot.
- `deltaText` with no prior stream → seed from the snapshot if present,
  else from `deltaText`.
- Only `delta`/`final`/`aborted`/`error` for the **active** run
  (`sessionKey` matches, or `runId` matches the in-flight run) drive the
  live stream. A `final` for a different `runId` (e.g. a sub-agent
  announce) is appended as a standalone assistant message.

### `session.message` event

Reloads `chat.history` **only when no run is active**, so the live stream is
never clobbered mid-flight. Events for other session keys are ignored.

## 6. Model selection protocol

Per-conversation model selection reads the catalog via `models.list` and
writes via `sessions.patch` (available because this client connects as the
Control UI — see §2/§4). Client store: `src/stores/models.ts`.

### `models.list`

```jsonc
{ "method": "models.list", "params": { "view": "configured" } }
// res
{ "models": [
  { "id": "openai/gpt-5.5", "name": "GPT-5.5", "provider": "openai",
    "alias?:": "...", "contextWindow?": 128000, "reasoning?": true }, ...
] }
```

`view: "configured"` restricts the catalog to providers actually configured in
`openclaw.json` (`ui/src/ui/controllers/models.ts:58`,
`ui/src/ui/chat/slash-command-executor.ts:678`). The client caches this for
the picker and refreshes it on connect.

### Current model resolution

The picker value is resolved in `src/stores/models.ts:currentModelValue`
(mirroring `ui/src/ui/chat-model-select-state.ts`):

1. Optimistic override for this `sessionKey` (`string` = set, `null` =
   cleared-to-default) — keeps the UI in sync during the RPC round-trip.
2. The session row's `model` from `sessions.list`.
3. `defaults.model` from `sessions.list`.
4. Empty string → the "Default" option.

An explicit override equal to `defaults.model` is treated as "Default"
(matching the control UI's `sessionModelMatchesDefaults` intent), so the
picker shows "Default" whether the override is cleared (`null`) or set to the
default ref.

### Option list

A leading **"Default (`<defaults.model>`)"** option (value `""`), followed by
each catalog entry. If the resolved current model is neither default nor in
the catalog (e.g. a provider-qualified ref the server returned), it is
appended so the select always shows a valid current value.

### Write path — `sessions.patch`

Selecting an option calls `setModel(value)` → `sessions.patch`
(`src/stores/models.ts:setModel`):

- value `<id>` → `sessions.patch { key, model: <id> }` (set override).
- value `""` (Default) → `sessions.patch { key, model: null }` (clear
  override → fall back to `defaults.model`).

The client writes an optimistic override before the RPC, reloads
`sessions.list` on success and drops the override (the fresh row is
authoritative), and rolls the override back on failure. No `/model` slash
command is sent, so the transcript is not polluted and the update is
immediate.

## 7. Config protocol (provider management)

Provider/default-model administration uses the config RPCs. Client store:
`src/stores/providers.ts`. Source schema:
`packages/gateway-protocol/src/schema/config.ts`.

### `config.get`

```jsonc
{ "method": "config.get", "params": {} }
// res
{ "hash": "<configHash>",
  "config": { "models": { "providers": { ... } },
              "agents": { "defaults": { "model": "..." } } } }
```

`hash` is the config version used as an optimistic-concurrency guard for
patches.

### `config.patch`

```jsonc
{ "method": "config.patch",
  "params": { "raw": "<JSON merge-patch string>",
              "baseHash": "<hash from config.get>",
              "replacePaths": ["models.providers.<id>.models"] } }
```

- **RFC 7396 merge-patch** semantics: `null` deletes a key (used for
  provider removal); present keys are set/merged.
- `baseHash` guards against stale patches; the server rejects if the config
  moved. After a successful patch the client reloads `config.get` to refresh
  `hash`.
- `replacePaths` forces a full array replace for keys that merge-by-id would
  otherwise keep stale (used for a provider's `models` array).
- Redacted API keys come back as `"__OPENCLAW_REDACTED__"`; the server
  restores them when the sentinel is echoed back unchanged, so the client
  passes the sentinel through rather than wiping the key.

Operations the ProviderModal exposes:
- **add provider**: patch `{ models: { providers: { [id]: entry } } }`.
- **update provider**: per-field null-to-clear + redacted-sentinel echoing
  + `replacePaths: ["models.providers.<id>.models"]`.
- **delete provider**: patch `{ models: { providers: { [id]: null } } }`.
- **set default model**: patch `{ agents: { defaults: { model: <id>|null } } }`.

## 8. Event/state bootstrapping order

On `hello-ok` (`src/stores/connection.ts:82`):

1. `sessions.load()` — fetch the index + `defaults` (awaited; the sidebar
   and model picker depend on it).
2. `sessions.subscribe()` — fire-and-forget; opts into `sessions.changed`.
3. `models.loadCatalog()` — fire-and-forget; does not block the initial
   transcript render.
4. Resolve the active session: if the persisted `sessionKey` still exists
   (or the list is empty) load its history directly; otherwise adopt the
   most recent session (list is newest-first by `updatedAt`).

This ordering guarantees the model picker has both the catalog and the
session/default model before the user can interact, without delaying the
first transcript.

## 9. Concurrency and correctness invariants

- **One active run per session**: `chat.send` is gated by `isBusy`
  (`chatSending || chatRunId != null`); a second send is ignored. Model
  switches are independent of the chat run slot (they use `sessions.patch`,
  not `chat.send`), so the picker can stay enabled while a reply streams.
- **Optimistic overrides are per-session** and scoped to the active key, so
  switching sessions never shows a stale in-flight model. The override is
  rolled back on RPC failure and dropped after a successful `sessions.list`
  reload (the fresh row is authoritative).
- **`sessions.changed` → full reload**: the client reloads the whole index
  rather than patching rows locally, so server-side model/label/status
  changes are always authoritative.
- **Stream vs. history race**: `session.message` reloads history only when
  no run is active, and only for the active session, preventing the live
  stream from being replaced mid-flight.
- **Idempotent sends**: the `idempotencyKey` (== tracked `runId`) makes
  WebSocket retry-after-disconnect safe; the gateway dedupes by key.

## 10. OpenClaw source cross-reference

| Concern                  | OpenClaw source (tag `v2026.6.10`)                                   |
| ------------------------ | ------------------------------------------------------------------- |
| Frame / connect schemas  | `packages/gateway-protocol/src/schema/frames.ts`                    |
| Chat send/abort/history  | `packages/gateway-protocol/src/schema/logs-chat.ts`                 |
| Sessions list/create/patch | `packages/gateway-protocol/src/schema/sessions.ts`                |
| Session list result base | `src/shared/session-types.ts`                                       |
| Model catalog + patch result | `packages/gateway-protocol/src/schema/agents-models-skills.ts`, `packages/gateway-protocol/src/index.ts:1420` |
| Config get/patch         | `packages/gateway-protocol/src/schema/config.ts`                    |
| Browser client (control UI) | `ui/src/ui/gateway.ts`, `ui/src/ui/device-identity.ts`           |
| Chat controllers         | `ui/src/ui/controllers/chat.ts`                                     |
| Model catalog controller | `ui/src/ui/controllers/models.ts`                                   |
| Model select state       | `ui/src/ui/chat-model-select-state.ts`, `ui/src/ui/chat/session-controls.ts` |
| Slash `/model` executor  | `ui/src/ui/chat/slash-command-executor.ts`                          |

This client is a strict subset: it implements the operator-role chat loop
(connect → sessions → chat streaming) plus model selection and provider
admin, and omits tool-call panels, attachments, realtime voice, approvals,
and agent/skill management.
