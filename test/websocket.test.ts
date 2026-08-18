import { describe, expect, it } from "vitest";
import { normalizeClose, webSocketMessageBytes } from "../src/websocket";

describe("WebSocket safety helpers", () => {
  it("replaces reserved abnormal close codes", () => {
    expect(normalizeClose(1006, "abnormal")).toEqual({ code: 1011, reason: "abnormal" });
    expect(normalizeClose(1000, "done")).toEqual({ code: 1000, reason: "done" });
  });

  it("truncates close reasons to the 123-byte protocol limit without breaking UTF-8", () => {
    const close = normalizeClose(1011, "界".repeat(100));
    expect(new TextEncoder().encode(close.reason).byteLength).toBeLessThanOrEqual(123);
    expect(close.reason.endsWith("界")).toBe(true);
  });

  it("measures text as UTF-8 bytes and binary by byte length", () => {
    expect(webSocketMessageBytes("界")).toBe(3);
    expect(webSocketMessageBytes(new Uint8Array([1, 2, 3]).buffer)).toBe(3);
  });
});
