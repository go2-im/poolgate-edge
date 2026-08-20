export type AccountAddFlow = "device_login" | "auth_json_import";
export type AccountAddStatus = "started" | "progress" | "failed" | "completed";

type LogLevel = "log" | "warn" | "error";
type LogField = string | number | boolean | null | undefined;

export function errorReason(error: unknown): string {
  if (error instanceof Error) return redactLogText(error.message);
  if (typeof error === "string") return redactLogText(error);
  return "unknown error";
}

export async function upstreamErrorFields(response: Response): Promise<Record<string, LogField>> {
  const fields: Record<string, LogField> = {
    upstreamStatus: response.status,
    upstreamContentType: response.headers.get("content-type")?.split(";", 1)[0] || "unknown"
  };
  try {
    const body = (await response.clone().text()).trim();
    if (!body) return fields;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = parsed.error && typeof parsed.error === "object"
      ? parsed.error as Record<string, unknown>
      : parsed;
    const code = typeof nested.code === "string" ? nested.code : typeof nested.error === "string" ? nested.error : "";
    const description = typeof nested.message === "string"
      ? nested.message
      : typeof nested.error_description === "string"
        ? nested.error_description
        : "";
    if (code) fields.upstreamError = redactLogText(code);
    if (description) fields.upstreamErrorDescription = redactLogText(description);
  } catch {
    // Non-JSON upstream responses are intentionally not logged: HTML and proxy
    // pages add little diagnostic value and may echo request credentials.
  }
  return fields;
}

export function logAccountAdd(
  level: LogLevel,
  flow: AccountAddFlow,
  stage: string,
  status: AccountAddStatus,
  fields: Record<string, LogField> = {}
): void {
  // Cloudflare may render only the first console argument. Serialize the entire
  // event into that argument so stage and failure details always remain visible.
  console[level](JSON.stringify({ event: "gpt_account_add", flow, stage, status, ...fields }));
}

function redactLogText(value: string, limit = 500): string {
  const redacted = value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g, "[redacted-jwt]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}
