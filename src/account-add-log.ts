import {
  errorReason,
  logStructured,
  upstreamErrorFields,
  type LogField,
  type LogLevel
} from "./observability";

export type AccountAddFlow = "device_login" | "auth_json_import";
export type AccountAddStatus = "started" | "progress" | "failed" | "completed";

export { errorReason, upstreamErrorFields } from "./observability";

export function logAccountAdd(
  level: LogLevel,
  flow: AccountAddFlow,
  stage: string,
  status: AccountAddStatus,
  fields: Record<string, LogField> = {}
): void {
  logStructured(level, "gpt_account_add", { flow, stage, status, ...fields });
}
