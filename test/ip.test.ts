import { describe, expect, it } from "vitest";
import { isIpCidr, matchesIpAllowlist, normalizeIpAllowlist, parseIp } from "../src/ip";

describe("IP allowlists", () => {
  it("parses strict IPv4 addresses", () => {
    expect(parseIp("203.0.113.7")?.bits).toBe(32);
    expect(parseIp("256.0.0.1")).toBeNull();
    expect(parseIp("1.2.3")).toBeNull();
  });

  it("parses compressed and embedded IPv6 addresses", () => {
    expect(parseIp("2001:db8::1")?.bits).toBe(128);
    expect(parseIp("::ffff:192.0.2.1")?.bits).toBe(128);
    expect(parseIp("2001::db8::1")).toBeNull();
    expect(parseIp("fe80::1%en0")).toBeNull();
  });

  it("validates prefix lengths", () => {
    expect(isIpCidr("10.0.0.0/8")).toBe(true);
    expect(isIpCidr("2001:db8::/32")).toBe(true);
    expect(isIpCidr("10.0.0.0/33")).toBe(false);
    expect(isIpCidr("2001:db8::/129")).toBe(false);
  });

  it("matches addresses against same-family networks", () => {
    expect(matchesIpAllowlist("10.2.3.4", ["10.0.0.0/8"])).toBe(true);
    expect(matchesIpAllowlist("11.2.3.4", ["10.0.0.0/8"])).toBe(false);
    expect(matchesIpAllowlist("2001:db8:1::9", ["2001:db8::/32"])).toBe(true);
    expect(matchesIpAllowlist("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(matchesIpAllowlist("203.0.113.7", ["2001:db8::/32"])).toBe(false);
  });

  it("normalizes bounded unique configuration", () => {
    expect(normalizeIpAllowlist([" 203.0.113.7 ", "2001:db8::/32"])).toEqual(["203.0.113.7", "2001:db8::/32"]);
    expect(() => normalizeIpAllowlist(["10.0.0.0/8", "10.0.0.0/8"])).toThrow(/duplicate/);
    expect(() => normalizeIpAllowlist(["not-an-ip"])).toThrow(/invalid/);
  });
});
