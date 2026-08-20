import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRequestId,
  errorReason,
  logPathname,
  logRuntime,
  REQUEST_ID_HEADER,
  requestIdFromRequest
} from "../src/observability";

afterEach(() => vi.restoreAllMocks());

describe("structured runtime logging", () => {
  it("serializes the full event into one Cloudflare console argument", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logRuntime("error", "proxy_http", "upstream_fetch", "failed", {
      requestId: "ray-123",
      reason: "connection_failed",
      upstreamStatus: 503
    });

    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({
      event: "poolgate_runtime",
      component: "proxy_http",
      stage: "upstream_fetch",
      status: "failed",
      requestId: "ray-123",
      reason: "connection_failed",
      upstreamStatus: 503
    });
  });

  it("redacts credentials from captured error messages", () => {
    const jwt = "eyJheader.payload.signature";
    expect(errorReason(new Error(`Bearer secret-token ${jwt}`))).toBe("Bearer [redacted] [redacted-jwt]");
  });

  it("normalizes opaque admin resource IDs in logged paths", () => {
    expect(logPathname("/admin/api/accounts/account_secret/probe"))
      .toBe("/admin/api/accounts/:accountId/probe");
    expect(logPathname("/admin/api/accounts/login/device/login_secret/poll"))
      .toBe("/admin/api/accounts/login/device/:loginId/poll");
    expect(logPathname("/admin/api/api-keys/key_secret/regenerate"))
      .toBe("/admin/api/api-keys/:apiKeyId/regenerate");
    expect(logPathname(`/${"a".repeat(250)}`)).toHaveLength(201);
  });

  it("accepts only generated or validated request IDs", () => {
    const fromRay = createRequestId(new Request("https://example.com", { headers: { "cf-ray": "ray-123" } }));
    expect(fromRay).toBe("ray-123");
    expect(requestIdFromRequest(new Request("https://example.com", {
      headers: { [REQUEST_ID_HEADER]: "trace-456" }
    }))).toBe("trace-456");
    expect(requestIdFromRequest(new Request("https://example.com", {
      headers: { [REQUEST_ID_HEADER]: "invalid id" }
    }))).toBe("missing");
  });
});
