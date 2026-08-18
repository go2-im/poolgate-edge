import { describe, expect, it } from "vitest";
// @ts-expect-error The browser-native module intentionally has no TypeScript declaration file.
import { orderedMemberAccounts } from "../public/member-order.js";

interface Account {
  id: string;
}

describe("Admin policy member ordering", () => {
  const accounts: Account[] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("preserves the selected order returned by the policy API", () => {
    expect(orderedMemberAccounts(accounts, ["c", "a"]).map((account: Account) => account.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores stale selected IDs without duplicating accounts", () => {
    expect(orderedMemberAccounts(accounts, ["missing", "d", "b"]).map((account: Account) => account.id)).toEqual(["d", "b", "a", "c"]);
  });
});
