import { describe, expect, it } from "vitest";
import { accountIdFromIdToken, parseAuthJson } from "../src/auth-import";

function jwt(claims: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encoded}.signature`;
}

describe("auth.json import", () => {
  it("uses an explicit account id", () => {
    expect(
      parseAuthJson(JSON.stringify({
        tokens: { access_token: "access", refresh_token: "refresh", account_id: "account" }
      }))
    ).toMatchObject({ accessToken: "access", refreshToken: "refresh", accountId: "account" });
  });

  it("derives the account id from the ID token", () => {
    const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "from-jwt" } });
    expect(accountIdFromIdToken(idToken)).toBe("from-jwt");
    expect(
      parseAuthJson(JSON.stringify({ tokens: { access_token: "access", refresh_token: "refresh", id_token: idToken } }))
    ).toMatchObject({ accountId: "from-jwt", idToken });
  });

  it("rejects missing credentials", () => {
    expect(() => parseAuthJson('{"tokens":{}}')).toThrow(/missing access_token or refresh_token/);
  });
});
