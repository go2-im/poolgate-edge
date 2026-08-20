const MAX_WINDOW_SECONDS = 32 * 24 * 60 * 60;

export interface UsageWindow {
  name: string;
  usedPercent: number;
  windowSeconds: number;
  resetsAt: string;
}

export interface CurrentUsage {
  planType: string;
  windows: UsageWindow[];
  capturedAt: string;
  headroom: number;
}

export interface UsageRouteCandidate {
  name: "backend_api_wham" | "wham" | "codex_api";
  url: string;
}

export function usageRouteCandidates(upstreamUrl: string): UsageRouteCandidate[] {
  const origin = new URL(upstreamUrl).origin;
  return [
    { name: "backend_api_wham", url: `${origin}/backend-api/wham/usage` },
    { name: "wham", url: `${origin}/wham/usage` },
    { name: "codex_api", url: `${origin}/api/codex/usage` }
  ];
}

interface RawWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
}

interface RawDetails {
  primary_window?: unknown;
  secondary_window?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) throw new Error(`${field} must be a finite number`);
  return number;
}

function optionalNonNegativeInteger(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  const number = finiteNumber(value, field);
  if (!Number.isInteger(number) || number < 0 || number > MAX_WINDOW_SECONDS) {
    throw new Error(`${field} is outside the supported range`);
  }
  return number;
}

function resetTime(window: RawWindow, now: number): string {
  const absolute = window.reset_at === undefined || window.reset_at === null
    ? 0
    : finiteNumber(window.reset_at, "reset_at");
  if (absolute > 0) {
    const value = new Date(absolute * 1000);
    if (!Number.isFinite(value.getTime())) throw new Error("reset_at is invalid");
    return value.toISOString();
  }
  const after = optionalNonNegativeInteger(window.reset_after_seconds, "reset_after_seconds");
  return after > 0 ? new Date(now + after * 1000).toISOString() : "";
}

function parseWindow(value: unknown, name: string, now: number): UsageWindow | null {
  if (value === undefined || value === null) return null;
  const raw = record(value) as RawWindow | null;
  if (!raw) throw new Error(`${name} window must be an object`);
  return {
    name,
    usedPercent: finiteNumber(raw.used_percent, `${name}.used_percent`),
    windowSeconds: optionalNonNegativeInteger(raw.limit_window_seconds, `${name}.limit_window_seconds`),
    resetsAt: resetTime(raw, now)
  };
}

function appendDetails(windows: UsageWindow[], value: unknown, primaryName: string, secondaryName: string, now: number): void {
  if (value === undefined || value === null) return;
  const details = record(value) as RawDetails | null;
  if (!details) throw new Error("rate_limit must be an object");
  const primary = parseWindow(details.primary_window, primaryName, now);
  const secondary = parseWindow(details.secondary_window, secondaryName, now);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
}

export function minimumHeadroom(windows: UsageWindow[]): number {
  if (windows.length === 0) return 100;
  return Math.min(...windows.map((window) => Math.max(0, Math.min(100, 100 - window.usedPercent))));
}

export function parseUsagePayload(value: unknown, now = Date.now()): Omit<CurrentUsage, "capturedAt" | "headroom"> {
  const payload = record(value);
  if (!payload) throw new Error("usage payload must be an object");
  const planType = typeof payload.plan_type === "string" ? payload.plan_type.trim().slice(0, 80) : "";
  const windows: UsageWindow[] = [];
  appendDetails(windows, payload.rate_limit, "primary", "secondary", now);
  if (payload.additional_rate_limits !== undefined && !Array.isArray(payload.additional_rate_limits)) {
    throw new Error("additional_rate_limits must be an array");
  }
  for (const entryValue of (payload.additional_rate_limits as unknown[] | undefined) ?? []) {
    const entry = record(entryValue);
    if (!entry) throw new Error("additional rate limit must be an object");
    const rawName = typeof entry.limit_name === "string" && entry.limit_name.trim()
      ? entry.limit_name.trim()
      : typeof entry.metered_feature === "string" && entry.metered_feature.trim()
        ? entry.metered_feature.trim()
        : "additional";
    const name = rawName.slice(0, 80);
    appendDetails(windows, entry.rate_limit, name, `${name}_secondary`, now);
  }
  return { planType, windows };
}

function decodeStoredWindows(windowsJson: string): UsageWindow[] | null {
  try {
    const value = JSON.parse(windowsJson) as unknown;
    if (!Array.isArray(value)) return null;
    return value.map((item) => {
      const window = record(item);
      if (
        !window || typeof window.name !== "string" || typeof window.usedPercent !== "number" ||
        !Number.isFinite(window.usedPercent) || typeof window.windowSeconds !== "number" ||
        !Number.isFinite(window.windowSeconds) || typeof window.resetsAt !== "string"
      ) throw new Error("invalid stored usage window");
      return {
        name: window.name,
        usedPercent: window.usedPercent,
        windowSeconds: window.windowSeconds,
        resetsAt: window.resetsAt
      } satisfies UsageWindow;
    });
  } catch {
    return null;
  }
}

export function headroomFromStoredWindows(windowsJson: string): number {
  const windows = decodeStoredWindows(windowsJson);
  return windows ? minimumHeadroom(windows) : 0;
}

export function parseStoredUsage(windowsJson: string, planType: string, capturedAt: string): CurrentUsage | null {
  if (!capturedAt) return null;
  const windows = decodeStoredWindows(windowsJson);
  return windows ? { planType, windows, capturedAt, headroom: minimumHeadroom(windows) } : null;
}

export function exhaustedReset(windows: UsageWindow[], now = Date.now()): string {
  const reset = windows
    .filter((window) => 100 - window.usedPercent <= 0)
    .map((window) => Date.parse(window.resetsAt))
    .filter((value) => Number.isFinite(value) && value > now)
    .sort((left, right) => right - left)[0];
  return reset ? new Date(reset).toISOString() : "";
}
