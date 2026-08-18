import type { CandidateAccount, Strategy } from "./types";

export interface SelectionState {
  inFlight: Map<string, number>;
  roundRobin: Map<string, number>;
  weightedCurrent: Map<string, Map<string, number>>;
}

export type AccountAvailability = "available" | "saturated" | "unavailable";

export function isEligible(account: CandidateAccount, now = Date.now()): boolean {
  if (!account.enabled) return false;
  if (account.state === "revoked" || account.state === "dead" || account.state === "expired") return false;
  if (account.state === "quota_exhausted") return false;
  if (account.state === "cooldown" && account.cooldownUntil) {
    const until = Date.parse(account.cooldownUntil);
    if (Number.isFinite(until) && until > now) return false;
  }
  return true;
}

export function hasCapacity(account: CandidateAccount, state: SelectionState): boolean {
  return account.concurrencyCap <= 0 || (state.inFlight.get(account.id) ?? 0) < account.concurrencyCap;
}

export function accountAvailability(
  accounts: CandidateAccount[],
  state: SelectionState,
  excluded = new Set<string>(),
  now = Date.now()
): AccountAvailability {
  const eligible = accounts.filter((account) => !excluded.has(account.id) && isEligible(account, now));
  if (eligible.length === 0) return "unavailable";
  return eligible.some((account) => hasCapacity(account, state)) ? "available" : "saturated";
}

export function selectAccount(
  groupId: string,
  strategy: Strategy,
  accounts: CandidateAccount[],
  state: SelectionState,
  excluded = new Set<string>(),
  now = Date.now()
): CandidateAccount | null {
  const candidates = accounts
    .filter((account) => !excluded.has(account.id) && isEligible(account, now) && hasCapacity(account, state))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));

  if (candidates.length === 0) return null;

  switch (strategy) {
    case "best-quota":
      return candidates.reduce((best, account) =>
        account.headroom > best.headroom || (account.headroom === best.headroom && account.id < best.id) ? account : best
      );
    case "load-balance": {
      const minimum = Math.min(...candidates.map((account) => state.inFlight.get(account.id) ?? 0));
      const tied = candidates.filter((account) => (state.inFlight.get(account.id) ?? 0) === minimum);
      const cursor = state.roundRobin.get(groupId) ?? 0;
      state.roundRobin.set(groupId, cursor + 1);
      return tied[cursor % tied.length];
    }
    case "weighted":
      return selectWeighted(groupId, candidates, state);
    case "fallback":
    default:
      return candidates[0];
  }
}

function selectWeighted(groupId: string, accounts: CandidateAccount[], state: SelectionState): CandidateAccount {
  let current = state.weightedCurrent.get(groupId);
  if (!current) {
    current = new Map<string, number>();
    state.weightedCurrent.set(groupId, current);
  }

  const present = new Set(accounts.map((account) => account.id));
  for (const id of current.keys()) if (!present.has(id)) current.delete(id);

  let total = 0;
  let best = accounts[0];
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const account of accounts) {
    const weight = Math.max(1, account.weight);
    total += weight;
    const value = (current.get(account.id) ?? 0) + weight;
    current.set(account.id, value);
    if (value > bestValue || (value === bestValue && account.id < best.id)) {
      best = account;
      bestValue = value;
    }
  }
  current.set(best.id, (current.get(best.id) ?? 0) - total);
  return best;
}
