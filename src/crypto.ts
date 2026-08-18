const CIPHERTEXT_VERSION = "v1";

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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function importMasterKey(encodedKey: string): Promise<CryptoKey> {
  if (typeof encodedKey !== "string" || !encodedKey.trim()) {
    throw new Error("MASTER_KEY is required and must be base64 encoded");
  }
  const raw = base64ToBytes(encodedKey);
  if (raw.byteLength !== 32) throw new Error("MASTER_KEY must decode to exactly 32 bytes");
  return crypto.subtle.importKey("raw", arrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${CIPHERTEXT_VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(key: CryptoKey, value: string): Promise<string> {
  const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
  if (version !== CIPHERTEXT_VERSION || !encodedIv || !encodedCiphertext || extra !== undefined) {
    throw new Error("unsupported ciphertext format");
  }
  const iv = base64UrlToBytes(encodedIv);
  if (iv.byteLength !== 12) throw new Error("invalid AES-GCM IV");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: arrayBuffer(iv) },
    key,
    arrayBuffer(base64UrlToBytes(encodedCiphertext))
  );
  return new TextDecoder().decode(plaintext);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function newApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `sk-pg-${bytesToBase64Url(bytes)}`;
}
