import { logStructured, type LogField, type LogLevel } from "./observability";

export type UsagePollSource = "manual" | "scheduled";
export type UsagePollStatus = "started" | "progress" | "failed" | "completed";

export function logUsagePoll(
  level: LogLevel,
  source: UsagePollSource,
  stage: string,
  status: UsagePollStatus,
  fields: Record<string, LogField> = {}
): void {
  logStructured(level, "usage_poll", { source, stage, status, ...fields });
}
