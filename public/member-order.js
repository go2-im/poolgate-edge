export function orderedMemberAccounts(accounts, selected) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const selectedAccounts = selected.map((id) => byId.get(id)).filter(Boolean);
  const selectedIds = new Set(selectedAccounts.map((account) => account.id));
  return [...selectedAccounts, ...accounts.filter((account) => !selectedIds.has(account.id))];
}
