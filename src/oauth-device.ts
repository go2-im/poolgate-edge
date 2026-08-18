export const OAUTH_BASE = "https://auth.openai.com";
export const DEVICE_VERIFICATION_URL = `${OAUTH_BASE}/codex/device`;
export const DEVICE_USER_CODE_URL = `${OAUTH_BASE}/api/accounts/deviceauth/usercode`;
export const DEVICE_TOKEN_URL = `${OAUTH_BASE}/api/accounts/deviceauth/token`;
export const DEVICE_REDIRECT_URI = `${OAUTH_BASE}/deviceauth/callback`;

export interface DeviceCodeStart {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

export interface DeviceAuthorizationCode {
  authorizationCode: string;
  codeVerifier: string;
}

function requiredText(value: unknown, maximum: number): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maximum) throw new Error("invalid device authorization response");
  return result;
}

export function assertPinnedOAuthIssuer(value: string): URL {
  const issuer = new URL(value);
  if (
    issuer.protocol !== "https:" ||
    issuer.hostname !== "auth.openai.com" ||
    issuer.pathname !== "/oauth/token" ||
    issuer.username ||
    issuer.password ||
    issuer.port ||
    issuer.search ||
    issuer.hash
  ) throw new Error("OAUTH_ISSUER must be https://auth.openai.com/oauth/token");
  return issuer;
}

export function parseDeviceCodeStart(value: unknown): DeviceCodeStart {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid device authorization response");
  }
  const payload = value as Record<string, unknown>;
  const rawInterval = typeof payload.interval === "string" ? Number(payload.interval.trim()) : Number(payload.interval);
  if (!Number.isFinite(rawInterval) || rawInterval < 1) throw new Error("invalid device authorization response");
  return {
    deviceAuthId: requiredText(payload.device_auth_id, 512),
    userCode: requiredText(payload.user_code ?? payload.usercode, 128),
    intervalSeconds: Math.min(30, Math.ceil(rawInterval))
  };
}

export async function parseDeviceAuthorizationCode(value: unknown): Promise<DeviceAuthorizationCode> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid device authorization response");
  }
  const payload = value as Record<string, unknown>;
  const authorizationCode = requiredText(payload.authorization_code, 4096);
  const codeVerifier = requiredText(payload.code_verifier, 512);
  const codeChallenge = requiredText(payload.code_challenge, 512);
  const expected = await sha256Base64Url(codeVerifier);
  if (codeChallenge !== expected) throw new Error("device authorization PKCE mismatch");
  return { authorizationCode, codeVerifier };
}

export function accountIdFromIdToken(idToken: string): string {
  const parts = idToken.split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]))) as {
      [key: string]: unknown;
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" ? accountId.trim() : "";
  } catch {
    return "";
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
