import { afterEach, describe, expect, it, vi } from "vitest";
import { errorReason, logAccountAdd, upstreamErrorFields } from "../src/account-add-log";

afterEach(() => vi.restoreAllMocks());

describe("account-add logging", () => {
  it("serializes every diagnostic field into the first console argument", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logAccountAdd("error", "device_login", "exchange_authorization_code", "failed", {
      loginRef: "abcdef123456",
      upstreamStatus: 401,
      error: "invalid_grant"
    });

    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({
      event: "gpt_account_add",
      flow: "device_login",
      stage: "exchange_authorization_code",
      status: "failed",
      loginRef: "abcdef123456",
      upstreamStatus: 401,
      error: "invalid_grant"
    });
  });

  it("redacts bearer tokens, JWTs, and long opaque values from errors", () => {
    const jwt = "eyJheader.payload.signature";
    const opaque = "a".repeat(40);
    const reason = errorReason(new Error(`Bearer secret-token ${jwt} ${opaque}`));

    expect(reason).not.toContain("secret-token");
    expect(reason).not.toContain(jwt);
    expect(reason).not.toContain(opaque);
    expect(reason).toContain("[redacted]");
  });

  it("extracts useful OAuth errors without logging the full upstream body", async () => {
    const fields = await upstreamErrorFields(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: `authorization failed for ${"s".repeat(40)}`,
      access_token: "must-not-appear"
    }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" }
    }));

    expect(fields).toEqual({
      upstreamStatus: 401,
      upstreamContentType: "application/json",
      upstreamError: "invalid_grant",
      upstreamErrorDescription: "authorization failed for [redacted]"
    });
    expect(JSON.stringify(fields)).not.toContain("must-not-appear");
  });
});
