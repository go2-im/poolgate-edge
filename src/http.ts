import type { Env, Surface } from "./types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(JSON_HEADERS);
  if (headers) {
    new Headers(headers).forEach((value, key) => result.set(key, value));
  }
  result.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: result });
}

export function jsonError(status: number, type: string, message: string): Response {
  return json({ error: { type, message } }, status);
}

export function classifySurface(request: Request, env: Pick<Env, "ADMIN_HOST" | "PROXY_HOST">): Surface | null {
  const host = new URL(request.url).hostname.toLowerCase();
  const adminHost = env.ADMIN_HOST.trim().toLowerCase();
  const proxyHost = env.PROXY_HOST.trim().toLowerCase();

  if (!adminHost || !proxyHost || adminHost === proxyHost) return null;
  if (host === adminHost) return "admin";
  if (host === proxyHost) return "proxy";
  return null;
}

export function isAdminApi(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export function isProxyPath(pathname: string): boolean {
  return pathname === "/v1/responses" || /^\/e\/[^/]+\/v1\/responses$/.test(pathname);
}

export function addSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function discardRequestBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  try {
    await request.body.cancel();
  } catch {
    // The runtime may already have closed or transferred the stream.
  }
}

export async function readBoundedRequestBody(request: Request, maximum: number): Promise<ArrayBuffer | Response | null> {
  if (!request.body) return null;
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    await discardRequestBody(request);
    return jsonError(413, "body_too_large", `request body exceeds ${maximum} bytes`);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      return jsonError(413, "body_too_large", `request body exceeds ${maximum} bytes`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || null;
}

export function endpointFromPath(pathname: string): string | null {
  if (pathname === "/v1/responses") return "default";
  const match = /^\/e\/([^/]+)\/v1\/responses$/.exec(pathname);
  if (!match) return null;
  try {
    const name = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}
