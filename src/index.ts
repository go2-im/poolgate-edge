import { authenticateAdminAccess } from "./access-auth";
import {
  addSecurityHeaders,
  classifySurface,
  discardRequestBody,
  isAdminApi,
  isProxyPath,
  json,
  jsonError,
  readBoundedRequestBody
} from "./http";
import { isIpAddress } from "./ip";
import { PoolCoordinator } from "./pool-coordinator";
import type { Env, Surface } from "./types";

export { PoolCoordinator };

function coordinator(env: Env): DurableObjectStub {
  return env.POOL.get(env.POOL.idFromName("primary"));
}

function configuredProxyBase(env: Pick<Env, "PROXY_HOST">): string | null {
  const host = env.PROXY_HOST.trim().toLowerCase();
  try {
    const url = new URL(`https://${host}`);
    if (url.hostname !== host || url.port || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function forward(request: Request, env: Env, surface: Surface): Promise<Response> {
  const maximum = surface === "admin" ? 1024 * 1024 : Math.max(1, Number(env.MAX_REQUEST_BODY_BYTES) || 8 * 1024 * 1024);
  const body = await readBoundedRequestBody(request, maximum);
  if (body instanceof Response) return body;
  const headers = new Headers(request.headers);
  headers.set("x-poolgate-surface", surface);
  headers.delete("x-poolgate-client-ip");
  if (surface === "proxy") {
    const clientIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
    if (isIpAddress(clientIp)) headers.set("x-poolgate-client-ip", clientIp);
  }
  const init: RequestInit = { method: request.method, headers, redirect: request.redirect, signal: request.signal };
  if (body !== null) init.body = body;
  return coordinator(env).fetch(new Request(request.url, init));
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  if (isProxyPath(url.pathname)) {
    await discardRequestBody(request);
    return jsonError(404, "not_found", "route not found on the admin host");
  }
  const authentication = await authenticateAdminAccess(request, env);
  if (authentication instanceof Response) {
    await discardRequestBody(request);
    return authentication;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    try {
      if (!origin || new URL(origin).origin !== url.origin) {
        await discardRequestBody(request);
        return jsonError(403, "origin_rejected", "admin mutations must be same-origin");
      }
    } catch {
      await discardRequestBody(request);
      return jsonError(403, "origin_rejected", "admin mutations must be same-origin");
    }
  }

  if (request.method === "GET" && url.pathname === "/admin/api/identity") {
    return json({ identity: authentication });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/client-config") {
    const proxyBase = configuredProxyBase(env);
    return proxyBase
      ? json({ proxyBase })
      : jsonError(503, "proxy_host_misconfigured", "Proxy hostname is not configured safely");
  }
  if (isAdminApi(url.pathname)) return forward(request, env, "admin");
  if (request.method !== "GET" && request.method !== "HEAD") {
    await discardRequestBody(request);
    return jsonError(405, "method_not_allowed", "admin assets only support GET and HEAD");
  }
  const assetUrl = new URL(request.url);
  if (assetUrl.pathname === "/") assetUrl.pathname = "/index.html";
  let asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (asset.status === 404 && assetUrl.pathname !== "/index.html") {
    const fallback = new URL(request.url);
    fallback.pathname = "/index.html";
    asset = await env.ASSETS.fetch(new Request(fallback, request));
  }
  return asset;
}

async function proxy(request: Request, env: Env, url: URL): Promise<Response> {
  if (isAdminApi(url.pathname)) {
    await discardRequestBody(request);
    return jsonError(404, "not_found", "route not found on the proxy host");
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ ok: true, service: "poolgate-edge" });
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    return forward(request, env, "proxy");
  }
  if (!isProxyPath(url.pathname)) {
    await discardRequestBody(request);
    return jsonError(404, "not_found", "proxy route not found");
  }
  return forward(request, env, "proxy");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const surface = classifySurface(request, env);
    if (!surface) {
      await discardRequestBody(request);
      return addSecurityHeaders(jsonError(421, "unknown_host", "request host is not configured"));
    }
    const url = new URL(request.url);
    const response = surface === "admin" ? await admin(request, env, url) : await proxy(request, env, url);
    return addSecurityHeaders(response);
  }
} satisfies ExportedHandler<Env>;
