import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function testEnv(): Env {
  return {
    ADMIN_HOST: "admin.example.com",
    PROXY_HOST: "api.example.com",
    ADMIN_AUTH_MODE: "dev",
    ENVIRONMENT: "development",
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    ASSETS: {
      async fetch(request: Request) {
        const pathname = new URL(request.url).pathname;
        return pathname === "/index.html"
          ? new Response("admin shell", { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 });
      }
    },
    POOL: {
      idFromName() { return {} as DurableObjectId; },
      get() {
        return { fetch: async () => new Response('{"ready":true}', { headers: { "content-type": "application/json" } }) };
      }
    } as unknown as DurableObjectNamespace,
    ROTATION_JOURNAL: {} as R2Bucket,
    MASTER_KEY: "",
    UPSTREAM_BASE: "",
    OAUTH_ISSUER: "",
    OAUTH_CLIENT_ID: "",
    MAX_REQUEST_BODY_BYTES: "8388608"
  };
}

describe("outer Worker routing", () => {
  it("maps the Admin root to the explicit index asset", async () => {
    const response = await worker.fetch(new Request("https://admin.example.com/"), testEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("admin shell");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("exposes only the verified Admin identity", async () => {
    const response = await worker.fetch(new Request("https://admin.example.com/admin/api/identity"), testEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ identity: { email: "Local development", subject: "dev" } });
  });

  it("exposes a secret-free Proxy base for client configuration", async () => {
    const response = await worker.fetch(new Request("https://admin.example.com/admin/api/client-config"), testEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ proxyBase: "https://api.example.com" });
  });

  it("refuses to generate configuration from an unsafe Proxy hostname", async () => {
    const env = testEnv();
    env.PROXY_HOST = "api.example.com/redirect";
    const response = await worker.fetch(new Request("https://admin.example.com/admin/api/client-config"), env);
    expect(response.status).toBe(503);
  });

  it("requires a same-origin Origin header for Admin mutations", async () => {
    const response = await worker.fetch(new Request("https://admin.example.com/admin/api/accounts/import", {
      method: "POST",
      body: "{}"
    }), testEnv());
    expect(response.status).toBe(403);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("does not expose Admin APIs on the Proxy host", async () => {
    const response = await worker.fetch(new Request("https://api.example.com/admin/api/status"), testEnv());
    expect(response.status).toBe(404);
  });

  it("forwards secret-free readiness checks to the coordinator without a Proxy key", async () => {
    const response = await worker.fetch(new Request("https://api.example.com/readyz"), testEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ready: true });
  });

  it("replaces a spoofed internal client IP with Cloudflare's validated address", async () => {
    const env = testEnv();
    env.POOL = {
      idFromName() { return {} as DurableObjectId; },
      get() {
        return {
          fetch: async (request: Request) => new Response(JSON.stringify({
            clientIp: request.headers.get("x-poolgate-client-ip")
          }), { headers: { "content-type": "application/json" } })
        };
      }
    } as unknown as DurableObjectNamespace;
    const response = await worker.fetch(new Request("https://api.example.com/readyz", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "x-poolgate-client-ip": "198.51.100.9"
      }
    }), env);
    await expect(response.json()).resolves.toEqual({ clientIp: "203.0.113.7" });
  });

  it("fails closed for unknown hosts", async () => {
    const response = await worker.fetch(new Request("https://unknown.example.com/"), testEnv());
    expect(response.status).toBe(421);
  });
});
