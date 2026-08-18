import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { jsonError } from "./http";
import type { Env } from "./types";

interface AccessClaims {
  email?: string;
  sub?: string;
  type?: string;
}

export interface VerifiedAccessIdentity {
  email: string;
  subject: string;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function accessIssuer(teamDomain: string): string | null {
  try {
    const url = new URL(teamDomain.trim());
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".cloudflareaccess.com") ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function remoteKeySet(issuer: string): JWTVerifyGetKey {
  const existing = remoteKeySets.get(issuer);
  if (existing) return existing;
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000
  });
  remoteKeySets.set(issuer, keys);
  return keys;
}

export async function verifyAccessToken(
  token: string,
  issuer: string,
  audience: string,
  keys: JWTVerifyGetKey = remoteKeySet(issuer)
): Promise<VerifiedAccessIdentity> {
  const result = await jwtVerify<AccessClaims>(token, keys, {
    algorithms: ["RS256"],
    issuer,
    audience,
    requiredClaims: ["iss", "aud", "exp", "iat", "type"]
  });
  if (result.payload.type !== "app") throw new Error("Access token is not an application token");
  return {
    email: typeof result.payload.email === "string" ? result.payload.email : "",
    subject: typeof result.payload.sub === "string" ? result.payload.sub : ""
  };
}

export async function authenticateAdminAccess(
  request: Request,
  env: Pick<Env, "ADMIN_AUTH_MODE" | "ENVIRONMENT" | "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">
): Promise<VerifiedAccessIdentity | Response> {
  if (env.ADMIN_AUTH_MODE === "dev" && env.ENVIRONMENT !== "production") {
    return { email: "Local development", subject: "dev" };
  }
  if (env.ADMIN_AUTH_MODE !== "access") {
    return jsonError(503, "admin_auth_misconfigured", "admin authentication is not configured");
  }
  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD.trim();
  if (!issuer || !audience) {
    return jsonError(503, "admin_auth_misconfigured", "Cloudflare Access issuer or audience is not configured");
  }
  const token = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!token) return jsonError(401, "access_required", "Cloudflare Access authentication is required");
  try {
    return await verifyAccessToken(token, issuer, audience);
  } catch (error) {
    console.warn("Cloudflare Access token rejected", error instanceof Error ? error.message : "verification failed");
    return jsonError(401, "invalid_access_token", "Cloudflare Access authentication is invalid or expired");
  }
}
