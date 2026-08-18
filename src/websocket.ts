const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

export function normalizeClose(code: number, reason: string): { code: number; reason: string } {
  const validCode = Number.isInteger(code) && code >= 1000 && code <= 4999 && !RESERVED_CLOSE_CODES.has(code);
  return {
    code: validCode ? code : 1011,
    reason: truncateUtf8(reason, 123)
  };
}

export function webSocketMessageBytes(data: string | ArrayBuffer): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

function truncateUtf8(value: string, maximum: number): string {
  if (new TextEncoder().encode(value).byteLength <= maximum) return value;
  let result = "";
  for (const character of value) {
    if (new TextEncoder().encode(result + character).byteLength > maximum) break;
    result += character;
  }
  return result;
}
