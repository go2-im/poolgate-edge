import { afterEach, describe, expect, it, vi } from "vitest";
import { logUsagePoll } from "../src/usage-log";

afterEach(() => vi.restoreAllMocks());

describe("usage poll logging", () => {
  it("serializes stage and failure details into one Cloudflare log argument", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logUsagePoll("error", "manual", "fetch_usage", "failed", {
      accountRef: "abcdef123456",
      reason: "upstream_rejected",
      upstreamStatus: 403,
      upstreamError: "forbidden"
    });

    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({
      event: "usage_poll",
      source: "manual",
      stage: "fetch_usage",
      status: "failed",
      accountRef: "abcdef123456",
      reason: "upstream_rejected",
      upstreamStatus: 403,
      upstreamError: "forbidden"
    });
  });
});
