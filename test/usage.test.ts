import { describe, expect, it } from "vitest";
import { exhaustedReset, headroomFromStoredWindows, minimumHeadroom, parseStoredUsage, parseUsagePayload } from "../src/usage";

describe("usage payload", () => {
  it("flattens primary, secondary, and additional windows", () => {
    const parsed = parseUsagePayload({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 60 }
      },
      additional_rate_limits: [{
        limit_name: "gpt-5-codex",
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 3_600 } }
      }]
    }, 1_000_000);
    expect(parsed.planType).toBe("plus");
    expect(parsed.windows.map((window) => window.name)).toEqual(["primary", "secondary", "gpt-5-codex"]);
    expect(parsed.windows[1].resetsAt).toBe(new Date(1_060_000).toISOString());
    expect(minimumHeadroom(parsed.windows)).toBe(60);
  });

  it("uses full headroom when no window constrains the account", () => {
    expect(minimumHeadroom([])).toBe(100);
  });

  it("finds the latest reset among exhausted windows", () => {
    const windows = parseUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 100, reset_at: 2_000_000_000 },
        secondary_window: { used_percent: 101, reset_at: 2_100_000_000 }
      }
    }).windows;
    expect(exhaustedReset(windows, 1_000)).toBe(new Date(2_100_000_000_000).toISOString());
  });

  it("rejects malformed numeric window values", () => {
    expect(() => parseUsagePayload({ rate_limit: { primary_window: { used_percent: "12" } } })).toThrow();
  });

  it("parses only structurally valid current snapshots", () => {
    const windows = [{ name: "primary", usedPercent: 25, windowSeconds: 60, resetsAt: "" }];
    expect(parseStoredUsage(JSON.stringify(windows), "pro", "2026-08-18T00:00:00.000Z")?.headroom).toBe(75);
    expect(parseStoredUsage("{}", "pro", "2026-08-18T00:00:00.000Z")).toBeNull();
    expect(headroomFromStoredWindows("[]")).toBe(100);
    expect(headroomFromStoredWindows("corrupt")).toBe(0);
  });
});
