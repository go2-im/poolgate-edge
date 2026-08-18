import { describe, expect, it } from "vitest";
import { accountAvailability, selectAccount, type SelectionState } from "../src/policy";
import type { CandidateAccount } from "../src/types";

function state(): SelectionState {
  return { inFlight: new Map(), roundRobin: new Map(), weightedCurrent: new Map() };
}

function account(id: string, position: number, options: Partial<CandidateAccount> = {}): CandidateAccount {
  return {
    id,
    label: id,
    accountId: `upstream-${id}`,
    accessTokenCiphertext: "a",
    refreshTokenCiphertext: "r",
    idTokenCiphertext: "i",
    state: "ok",
    enabled: true,
    credentialVersion: 1,
    lastRefreshedAt: "",
    cooldownUntil: "",
    nextProbeAt: "",
    concurrencyCap: 0,
    createdAt: "",
    updatedAt: "",
    position,
    weight: 1,
    headroom: 0,
    ...options
  };
}

describe("account policies", () => {
  it("uses configured order for fallback", () => {
    expect(selectAccount("g", "fallback", [account("b", 2), account("a", 1)], state())?.id).toBe("a");
  });

  it("chooses the largest quota headroom", () => {
    expect(
      selectAccount("g", "best-quota", [account("a", 1, { headroom: 10 }), account("b", 2, { headroom: 80 })], state())?.id
    ).toBe("b");
  });

  it("balances least-in-flight candidates with rotating ties", () => {
    const selection = state();
    const candidates = [account("a", 1), account("b", 2)];
    expect(selectAccount("g", "load-balance", candidates, selection)?.id).toBe("a");
    expect(selectAccount("g", "load-balance", candidates, selection)?.id).toBe("b");
    selection.inFlight.set("a", 2);
    expect(selectAccount("g", "load-balance", candidates, selection)?.id).toBe("b");
  });

  it("implements smooth weighted round robin", () => {
    const selection = state();
    const candidates = [account("a", 1, { weight: 2 }), account("b", 2, { weight: 1 })];
    const chosen = Array.from({ length: 6 }, () => selectAccount("g", "weighted", candidates, selection)?.id);
    expect(chosen.filter((id) => id === "a")).toHaveLength(4);
    expect(chosen.filter((id) => id === "b")).toHaveLength(2);
  });

  it("honors cooldown and concurrency caps", () => {
    const selection = state();
    selection.inFlight.set("a", 1);
    const candidates = [
      account("a", 1, { concurrencyCap: 1 }),
      account("b", 2, { state: "cooldown", cooldownUntil: new Date(Date.now() + 60_000).toISOString() }),
      account("c", 3)
    ];
    expect(selectAccount("g", "fallback", candidates, selection)?.id).toBe("c");
  });

  it("excludes administratively disabled accounts", () => {
    expect(selectAccount("g", "fallback", [account("a", 1, { enabled: false }), account("b", 2)], state())?.id).toBe("b");
    expect(accountAvailability([account("a", 1, { enabled: false })], state())).toBe("unavailable");
  });

  it("distinguishes saturation from no eligible account", () => {
    const selection = state();
    selection.inFlight.set("a", 1);
    expect(accountAvailability([account("a", 1, { concurrencyCap: 1 })], selection)).toBe("saturated");
    expect(accountAvailability([account("a", 1, { state: "expired" })], selection)).toBe("unavailable");
    expect(accountAvailability([account("a", 1)], state())).toBe("available");
  });
});
