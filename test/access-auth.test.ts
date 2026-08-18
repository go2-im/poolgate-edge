import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticateAdminAccess, verifyAccessToken } from "../src/access-auth";

const issuer = "https://poolgate.cloudflareaccess.com";
const audience = "poolgate-admin-audience";
let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;

async function token(overrides: { issuer?: string; audience?: string; type?: string; expiresAt?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: overrides.type ?? "app", email: "operator@example.com", sub: "operator-1" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(overrides.expiresAt ?? now + 60)
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" }] });
});

describe("Cloudflare Access authentication", () => {
  it("verifies signature, issuer, audience, time, and application type", async () => {
    await expect(verifyAccessToken(await token(), issuer, audience, keys)).resolves.toEqual({
      email: "operator@example.com",
      subject: "operator-1"
    });
  });

  it("rejects tokens for another audience or an expired session", async () => {
    await expect(verifyAccessToken(await token({ audience: "another-app" }), issuer, audience, keys)).rejects.toThrow();
    await expect(verifyAccessToken(await token({ expiresAt: Math.floor(Date.now() / 1000) - 1 }), issuer, audience, keys)).rejects.toThrow();
  });

  it("rejects non-application tokens", async () => {
    await expect(verifyAccessToken(await token({ type: "org" }), issuer, audience, keys)).rejects.toThrow(/application token/);
  });

  it("fails closed when production Access configuration is incomplete", async () => {
    const response = await authenticateAdminAccess(new Request("https://admin.example.com/"), {
      ADMIN_AUTH_MODE: "access",
      ENVIRONMENT: "production",
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_AUD: ""
    });
    expect(response).toBeInstanceOf(Response);
    expect(response instanceof Response ? response.status : 0).toBe(503);
  });

  it("allows the explicit development bypass only outside production", async () => {
    await expect(authenticateAdminAccess(new Request("https://admin.example.com/"), {
      ADMIN_AUTH_MODE: "dev",
      ENVIRONMENT: "development",
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_AUD: ""
    })).resolves.toEqual({ email: "Local development", subject: "dev" });

    const response = await authenticateAdminAccess(new Request("https://admin.example.com/"), {
      ADMIN_AUTH_MODE: "dev",
      ENVIRONMENT: "production",
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_AUD: ""
    });
    expect(response).toBeInstanceOf(Response);
    expect(response instanceof Response ? response.status : 0).toBe(503);
  });
});
