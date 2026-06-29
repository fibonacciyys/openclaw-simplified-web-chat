# OpenClaw Web Chat

A standalone web chat client that uses the [OpenClaw](https://github.com/openclaw/openclaw) gateway as its backend over the WebSocket protocol (v3). It mirrors the OpenClaw control-UI chat flow: per-session transcripts, streaming assistant replies, and markdown rendering (markdown-it + DOMPurify).

This is an independent frontend (Vue 3 + Vite + TypeScript) and is **not** part of the OpenClaw workspace. It connects to a running gateway as a regular operator client.

## Features

- WebSocket connect with the v3 handshake, including Ed25519 device-identity signing of the `connect.challenge` nonce (so it pairs/auto-approves on loopback like the control UI).
- Session list (`sessions.list`) + new conversation (`sessions.create`) + live `sessions.changed` updates.
- Chat: send (`chat.send`), abort (`chat.abort`), history (`chat.history`), and streaming `chat` events (`delta` → `final`/`aborted`/`error`).
- Markdown rendering aligned with the control UI (markdown-it + DOMPurify allowlist, task lists, link/image hardening).
- Core alignment only: text + markdown + streaming. No tool-call panels, attachments, or realtime voice.

## Prerequisites

- Node.js 18+ (20+ recommended).
- A running OpenClaw gateway reachable over WebSocket (default `ws://127.0.0.1:18789`).

## Install & run

```bash
cd web-chat
npm install
npm run dev
```

Open the printed URL (default http://localhost:5174).

## Connecting

The app auto-connects on load using the gateway URL and token from:

1. The URL fragment/query (`#gatewayUrl=…` and `#token=…`), then
2. Persisted settings in `localStorage` (saved from the connection bar).

You can also edit the **URL** and **token** fields in the top bar and click **Connect**.

### Auth

The gateway requires shared-secret auth by default. Get the gateway token from your OpenClaw config/credentials and paste it into the **token** field, or open the app with `#token=<your-token>` in the URL.

Alternatives for local-only development (loopback, not for public/untrusted networks):

- `gateway.auth.mode: "none"` skips shared-secret connect auth entirely.
- `gateway.controlUi.dangerouslyDisableDeviceAuth: true` is a break-glass path that skips device pairing.

The client still signs the `connect.challenge` nonce with an Ed25519 key generated once and stored in `localStorage`, so loopback auto-approval works the same as the control UI.

## How it maps to the gateway protocol

| Concern                | Protocol surface                                                                 |
| ---------------------- | -------------------------------------------------------------------------------- |
| Handshake              | `connect.challenge` event → `connect` req → `hello-ok` res                       |
| Frames                 | `req` / `res` / `event` (JSON text frames)                                       |
| Sessions               | `sessions.list`, `sessions.create`, `sessions.subscribe`, `sessions.changed`     |
| Chat                   | `chat.send` (with `idempotencyKey`), `chat.abort`, `chat.history`                |
| Streaming              | `chat` events: `state: delta → final / aborted / error`                          |
| Device identity        | Ed25519 keypair, `v2` signed payload (`v2|deviceId|…|nonce`)                     |

Implementation references in the OpenClaw source (tag `v2026.5.6`):

- Browser client: `ui/src/ui/gateway.ts`, `ui/src/ui/device-identity.ts`
- Chat controllers: `ui/src/ui/controllers/chat.ts`
- Markdown: `ui/src/ui/markdown.ts`
- Protocol schemas: `src/gateway/protocol/schema/{frames,logs-chat,sessions}.ts`
- Protocol docs: `docs/gateway/protocol.md`

## Build

```bash
npm run build      # type-check (vue-tsc) + vite build → dist/
npm run preview    # preview the production build
```

## Layout

```
src/
  lib/            framework-agnostic gateway client + protocol helpers
  stores/         Pinia stores: connection, sessions, chat
  components/     Vue components
  styles/         CSS
```
