import { describe, expect, it } from "vitest";
import { isRedirectStatus, SAFE_FETCH_REDIRECT } from "../src/fetch-policy";

describe("Worker fetch redirect policy", () => {
  it("uses the redirect mode implemented by Cloudflare Workers", () => {
    expect(SAFE_FETCH_REDIRECT).toBe("manual");
  });

  it.each([300, 301, 302, 303, 307, 308, 399])("recognizes redirect status %i", (status) => {
    expect(isRedirectStatus(status)).toBe(true);
  });

  it.each([200, 299, 400, 500])("does not classify status %i as a redirect", (status) => {
    expect(isRedirectStatus(status)).toBe(false);
  });
});
