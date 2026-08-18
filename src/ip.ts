export interface ParsedIp {
  bits: 32 | 128;
  value: bigint;
}

function parseIpv4(value: string): ParsedIp | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    result = (result << 8n) | BigInt(byte);
  }
  return { bits: 32, value: result };
}

function expandEmbeddedIpv4(value: string): string | null {
  if (!value.includes(".")) return value;
  const separator = value.lastIndexOf(":");
  if (separator < 0) return null;
  const ipv4 = parseIpv4(value.slice(separator + 1));
  if (!ipv4) return null;
  const high = Number((ipv4.value >> 16n) & 0xffffn).toString(16);
  const low = Number(ipv4.value & 0xffffn).toString(16);
  return `${value.slice(0, separator)}:${high}:${low}`;
}

function parseHextets(value: string): number[] | null {
  if (!value) return [];
  const parts = value.split(":");
  if (parts.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function parseIpv6(input: string): ParsedIp | null {
  if (input.includes("%")) return null;
  const expanded = expandEmbeddedIpv4(input);
  if (expanded === null) return null;
  const halves = expanded.split("::");
  if (halves.length > 2) return null;
  const left = parseHextets(halves[0]);
  const right = parseHextets(halves[1] ?? "");
  if (!left || !right) return null;
  let hextets: number[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    hextets = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    hextets = [...left, ...Array<number>(missing).fill(0), ...right];
  }
  let result = 0n;
  for (const hextet of hextets) result = (result << 16n) | BigInt(hextet);
  return { bits: 128, value: result };
}

export function parseIp(value: string): ParsedIp | null {
  const input = value.trim();
  if (!input) return null;
  return input.includes(":") ? parseIpv6(input) : parseIpv4(input);
}

export function isIpAddress(value: string): boolean {
  return parseIp(value) !== null;
}

export function isIpCidr(value: string): boolean {
  const parts = value.trim().split("/");
  if (parts.length > 2) return false;
  const address = parseIp(parts[0]);
  if (!address) return false;
  if (parts.length === 1) return true;
  if (!/^\d{1,3}$/.test(parts[1])) return false;
  const prefix = Number(parts[1]);
  return prefix >= 0 && prefix <= address.bits;
}

export function normalizeIpAllowlist(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("ipAllowlist must be an array of IP addresses or CIDRs");
  }
  if (value.length > 64) throw new Error("ipAllowlist must not contain more than 64 entries");
  const entries = value.map((entry) => entry.trim());
  if (entries.some((entry) => entry.length > 64 || !isIpCidr(entry))) {
    throw new Error("ipAllowlist contains an invalid IP address or CIDR");
  }
  if (new Set(entries).size !== entries.length) throw new Error("ipAllowlist contains duplicate entries");
  return entries;
}

export function matchesIpAllowlist(ipValue: string, allowlist: string[]): boolean {
  const ip = parseIp(ipValue);
  if (!ip) return false;
  for (const entry of allowlist) {
    const [addressValue, rawPrefix] = entry.split("/");
    const address = parseIp(addressValue);
    if (!address || address.bits !== ip.bits) continue;
    const prefix = rawPrefix === undefined ? address.bits : Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) continue;
    const shift = BigInt(address.bits - prefix);
    if ((ip.value >> shift) === (address.value >> shift)) return true;
  }
  return false;
}
