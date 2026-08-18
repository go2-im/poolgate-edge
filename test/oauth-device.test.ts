import { describe, expect, it } from "vitest";
import {
  accountIdFromIdToken,
  assertPinnedOAuthIssuer,
  parseDeviceAuthorizationCode,
  parseDeviceCodeStart
} from "../src/oauth-device";

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return base64Url(binary);
}

describe("device-code OAuth protocol", () => {
  it("accepts the official user-code response aliases and bounded interval", () => {
    expect(parseDeviceCodeStart({
      device_auth_id: "device-id",
      usercode: "ABCD-1234",
      interval: "5"
    })).toEqual({ deviceAuthId: "device-id", userCode: "ABCD-1234", intervalSeconds: 5 });
    expect(parseDeviceCodeStart({
      device_auth_id: "device-id",
      user_code: "ABCD-1234",
      interval: 90
    }).intervalSeconds).toBe(30);
  });

  it("rejects malformed device start responses", () => {
    expect(() => parseDeviceCodeStart({ device_auth_id: "x", user_code: "y", interval: 0 })).toThrow();
    expect(() => parseDeviceCodeStart({ device_auth_id: "", user_code: "y", interval: 5 })).toThrow();
  });

  it("validates the provider-returned PKCE verifier before exchange", async () => {
    const verifier = "a-secure-verifier";
    await expect(parseDeviceAuthorizationCode({
      authorization_code: "authorization-code",
      code_verifier: verifier,
      code_challenge: await challenge(verifier)
    })).resolves.toEqual({ authorizationCode: "authorization-code", codeVerifier: verifier });
    await expect(parseDeviceAuthorizationCode({
      authorization_code: "authorization-code",
      code_verifier: verifier,
      code_challenge: "wrong"
    })).rejects.toThrow("PKCE mismatch");
  });

  it("extracts only the namespaced ChatGPT account id", () => {
    const payload = base64Url(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" }
    }));
    expect(accountIdFromIdToken(`${base64Url("{}")}.${payload}.signature`)).toBe("account-123");
    expect(accountIdFromIdToken("not-a-jwt")).toBe("");
  });

  it("accepts only the pinned OAuth token endpoint", () => {
    expect(assertPinnedOAuthIssuer("https://auth.openai.com/oauth/token").href).toBe("https://auth.openai.com/oauth/token");
    for (const value of [
      "http://auth.openai.com/oauth/token",
      "https://evil.example/oauth/token",
      "https://auth.openai.com/oauth/token?next=evil",
      "https://auth.openai.com/other"
    ]) expect(() => assertPinnedOAuthIssuer(value)).toThrow();
  });
});
