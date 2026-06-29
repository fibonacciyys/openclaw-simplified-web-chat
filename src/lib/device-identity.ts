// Ed25519 device identity for the gateway connect handshake.
// Mirrors ui/src/ui/device-identity.ts (openclaw control UI).
// Identity is generated once, persisted in localStorage, and reused so the
// gateway can pair the device on first connect and auto-approve on loopback.
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

const STORAGE_KEY = "openclaw-webchat-device-identity-v1";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return bytesToHex(new Uint8Array(hash));
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomPrivateKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  const deviceId = await sha256Hex(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

function getSafeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const storage = getSafeStorage();
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
        if (
          parsed?.version === 1 &&
          typeof parsed.deviceId === "string" &&
          typeof parsed.publicKey === "string" &&
          typeof parsed.privateKey === "string"
        ) {
          const derivedId = await sha256Hex(base64UrlDecode(parsed.publicKey));
          const identity: DeviceIdentity = {
            deviceId: derivedId,
            publicKey: parsed.publicKey,
            privateKey: parsed.privateKey,
          };
          // Repair a stale deviceId in-place.
          if (derivedId !== parsed.deviceId) {
            const repaired: StoredIdentity = {
              version: 1,
              deviceId: derivedId,
              publicKey: parsed.publicKey,
              privateKey: parsed.privateKey,
              createdAtMs: parsed.createdAtMs ?? Date.now(),
            };
            storage.setItem(STORAGE_KEY, JSON.stringify(repaired));
          }
          return identity;
        }
      }
    } catch {
      // fall through to regenerate
    }
  }

  const identity = await generateIdentity();
  if (storage) {
    const stored: StoredIdentity = {
      version: 1,
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      createdAtMs: Date.now(),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }
  return identity;
}

export async function signDevicePayload(privateKeyBase64Url: string, payload: string): Promise<string> {
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await signAsync(data, key);
  return base64UrlEncode(sig);
}
