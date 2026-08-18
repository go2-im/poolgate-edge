import type { AuthImportTokens } from "./types";

interface AuthFile {
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
    id_token?: unknown;
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function accountIdFromIdToken(idToken: string): string {
  const payload = idToken.split(".")[1];
  if (!payload) return "";
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return "";
    return text((auth as Record<string, unknown>).chatgpt_account_id);
  } catch {
    return "";
  }
}

export function parseAuthJson(content: string): AuthImportTokens {
  let parsed: AuthFile;
  try {
    parsed = JSON.parse(content) as AuthFile;
  } catch {
    throw new Error("auth.json is not valid JSON");
  }
  const tokens = parsed.tokens;
  if (!tokens) throw new Error("auth.json has no tokens object");

  const accessToken = text(tokens.access_token);
  const refreshToken = text(tokens.refresh_token);
  const idToken = text(tokens.id_token);
  const accountId = text(tokens.account_id) || accountIdFromIdToken(idToken);

  if (!accessToken || !refreshToken) throw new Error("auth.json is missing access_token or refresh_token");
  if (!accountId) throw new Error("auth.json does not contain a ChatGPT account id");
  return { accessToken, refreshToken, accountId, idToken };
}

