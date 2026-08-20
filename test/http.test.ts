import { describe, expect, it } from "vitest";
import {
  addSecurityHeaders,
  bearerToken,
  classifySurface,
  discardRequestBody,
  endpointFromPath,
  isAdminApi,
  isProxyPath,
  jsonError,
  readBoundedRequestBody
} from "../src/http";

const hosts = { ADMIN_HOST: "admin.example.com", PROXY_HOST: "api.example.com" };

describe("host and route isolation", () => {
  it("classifies only exact configured hosts", () => {
    expect(classifySurface(new Request("https://admin.example.com/"), hosts)).toBe("admin");
    expect(classifySurface(new Request("https://api.example.com/"), hosts)).toBe("proxy");
    expect(classifySurface(new Request("https://evil-admin.example.com/"), hosts)).toBeNull();
  });

  it("fails closed when the two hosts are equal", () => {
    expect(
      classifySurface(new Request("https://same.example.com/"), {
        ADMIN_HOST: "same.example.com",
        PROXY_HOST: "same.example.com"
      })
    ).toBeNull();
  });

  it("recognizes disjoint route surfaces", () => {
    expect(isAdminApi("/admin/api/status")).toBe(true);
    expect(isProxyPath("/v1/responses")).toBe(true);
    expect(isProxyPath("/e/team-a/v1/responses")).toBe(true);
    expect(isAdminApi("/v1/responses")).toBe(false);
  });
});

describe("proxy request parsing", () => {
  it("keeps internal error metadata out of public responses", () => {
    const response = addSecurityHeaders(jsonError(502, "upstream_unavailable", "temporarily unavailable"));
    expect(response.headers.get("x-poolgate-error-type")).toBeNull();
  });

  it("extracts bearer tokens", () => {
    expect(bearerToken(new Request("https://api.example.com", { headers: { authorization: "Bearer secret" } }))).toBe("secret");
    expect(bearerToken(new Request("https://api.example.com"))).toBeNull();
  });

  it("extracts and validates endpoint names", () => {
    expect(endpointFromPath("/v1/responses")).toBe("default");
    expect(endpointFromPath("/e/team-a/v1/responses")).toBe("team-a");
    expect(endpointFromPath("/e/%2F/v1/responses")).toBeNull();
    expect(endpointFromPath("/e/a/b/v1/responses")).toBeNull();
  });

  it("cancels unread request bodies before an early response", async () => {
    const request = new Request("https://api.example.com/v1/responses", { method: "POST", body: "{}" });
    await discardRequestBody(request);
    expect(request.bodyUsed).toBe(true);
  });

  it("reads request bodies with a hard upper bound", async () => {
    const accepted = await readBoundedRequestBody(
      new Request("https://api.example.com/v1/responses", { method: "POST", body: "1234" }),
      4
    );
    expect(accepted).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(accepted as ArrayBuffer)).toBe("1234");

    const rejected = await readBoundedRequestBody(
      new Request("https://api.example.com/v1/responses", { method: "POST", body: "12345" }),
      4
    );
    expect(rejected).toBeInstanceOf(Response);
    expect(rejected instanceof Response ? rejected.status : 0).toBe(413);
  });
});
