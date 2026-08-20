export const REQUEST_ID_HEADER = "x-poolgate-request-id";
export const ERROR_TYPE_HEADER = "x-poolgate-error-type";

export type LogLevel = "log" | "warn" | "error";
export type LogField = string | number | boolean | null | undefined;

export function redactLogText(value: string, limit = 500): string {
  const redacted = value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g, "[redacted-jwt]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

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
    // Do not log non-JSON upstream bodies. HTML/proxy pages may echo secrets.
  }
  return fields;
}

export function logStructured(
  level: LogLevel,
  event: string,
  fields: Record<string, LogField> = {}
): void {
  // Cloudflare may render only the first console argument. Keep the complete
  // event in one JSON string so every diagnostic field remains searchable.
  console[level](JSON.stringify({ event, ...fields }));
}

export function logRuntime(
  level: LogLevel,
  component: string,
  stage: string,
  status: string,
  fields: Record<string, LogField> = {}
): void {
  logStructured(level, "poolgate_runtime", { component, stage, status, ...fields });
}

export function createRequestId(request: Request): string {
  const ray = request.headers.get("cf-ray")?.trim() ?? "";
  return /^[A-Za-z0-9-]{1,100}$/.test(ray) ? ray : crypto.randomUUID();
}

export function requestIdFromRequest(request: Request): string {
  const value = request.headers.get(REQUEST_ID_HEADER)?.trim() ?? "";
  return /^[A-Za-z0-9-]{1,100}$/.test(value) ? value : "missing";
}

export function responseErrorType(response: Response): string | undefined {
  return response.headers.get(ERROR_TYPE_HEADER)?.trim() || undefined;
}

export function logPathname(pathname: string): string {
  let normalized: string;
  if (/^\/admin\/api\/accounts\/login\/device\/[^/]+\/poll$/.test(pathname)) {
    normalized = pathname.replace(/^(\/admin\/api\/accounts\/login\/device)\/[^/]+(\/poll)$/, "$1/:loginId$2");
  } else {
    normalized = pathname
      .replace(/^(\/admin\/api\/accounts)\/[^/]+(?=\/|$)/, "$1/:accountId")
      .replace(/^(\/admin\/api\/policy-groups)\/[^/]+(?=\/|$)/, "$1/:policyGroupId")
      .replace(/^(\/admin\/api\/api-keys)\/[^/]+(?=\/|$)/, "$1/:apiKeyId");
  }
  return normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized;
}
