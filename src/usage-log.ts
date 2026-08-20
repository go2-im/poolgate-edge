export type UsagePollSource = "manual" | "scheduled";
export type UsagePollStatus = "started" | "progress" | "failed" | "completed";

type LogLevel = "log" | "warn" | "error";
type LogField = string | number | boolean | null | undefined;

export function logUsagePoll(
  level: LogLevel,
  source: UsagePollSource,
  stage: string,
  status: UsagePollStatus,
  fields: Record<string, LogField> = {}
): void {
  // Cloudflare may render only the first console argument. Keep the complete
  // diagnostic event in one JSON string, matching account-add logging.
  console[level](JSON.stringify({ event: "usage_poll", source, stage, status, ...fields }));
}
