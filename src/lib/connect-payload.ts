// Builds the signed payload string for the connect device challenge.
// Mirrors src/gateway/device-auth.ts buildDeviceAuthPayload (v2).
// The control UI signs v2; v2 remains accepted by the gateway.
import { signDevicePayload } from "./device-identity";

export type DeviceAuthPayloadParams = {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
};

export function buildDeviceAuthPayload(params: DeviceAuthPayloadParams): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
  ].join("|");
}

export type GatewayConnectDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

// Builds the signed `device` block for connect params.
export async function buildConnectDevice(params: {
  deviceIdentity: { deviceId: string; publicKey: string; privateKey: string };
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  authToken?: string;
  connectNonce: string | null;
}): Promise<GatewayConnectDevice> {
  const { deviceIdentity } = params;
  const signedAtMs = Date.now();
  const nonce = params.connectNonce ?? "";
  const payload = buildDeviceAuthPayload({
    deviceId: deviceIdentity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs,
    token: params.authToken ?? null,
    nonce,
  });
  const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
  return {
    id: deviceIdentity.deviceId,
    publicKey: deviceIdentity.publicKey,
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}
