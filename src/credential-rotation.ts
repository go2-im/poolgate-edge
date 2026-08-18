import type { RotationJournalEntry } from "./types";

const JOURNAL_WRITE_ATTEMPTS = 3;

export type RotationReconcileAction = "apply" | "discard";

export interface RotationCommitDependencies {
  writeJournal(entry: RotationJournalEntry): Promise<void>;
  compareAndSwap(entry: RotationJournalEntry): boolean;
  removeJournal(entry: RotationJournalEntry): Promise<void>;
}

export interface RotationCommitResult {
  updated: boolean;
  cleanupPending: boolean;
}

export function isTerminalOAuthFailure(code: string): boolean {
  return code === "invalid_grant";
}

export function parseRotationJournal(value: unknown, expectedAccountId: string): RotationJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid credential rotation journal");
  const entry = value as Record<string, unknown>;
  const baseVersion = Number(entry.baseVersion);
  const targetVersion = Number(entry.targetVersion);
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
  if (
    entry.accountId !== expectedAccountId ||
    !Number.isInteger(baseVersion) ||
    baseVersion < 1 ||
    targetVersion !== baseVersion + 1 ||
    typeof entry.accessTokenCiphertext !== "string" || !entry.accessTokenCiphertext ||
    typeof entry.refreshTokenCiphertext !== "string" || !entry.refreshTokenCiphertext ||
    typeof entry.idTokenCiphertext !== "string" ||
    !createdAt || !Number.isFinite(Date.parse(createdAt))
  ) throw new Error("invalid credential rotation journal");
  return {
    accountId: expectedAccountId,
    baseVersion,
    targetVersion,
    accessTokenCiphertext: entry.accessTokenCiphertext,
    refreshTokenCiphertext: entry.refreshTokenCiphertext,
    idTokenCiphertext: entry.idTokenCiphertext,
    createdAt
  };
}

export function rotationReconcileAction(currentVersion: number, entry: RotationJournalEntry): RotationReconcileAction {
  if (currentVersion === entry.baseVersion) return "apply";
  if (currentVersion >= entry.targetVersion) return "discard";
  throw new Error("credential version does not match rotation journal");
}

export async function persistCredentialRotation(
  entry: RotationJournalEntry,
  dependencies: RotationCommitDependencies
): Promise<RotationCommitResult> {
  let lastWriteError: unknown;
  for (let attempt = 0; attempt < JOURNAL_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await dependencies.writeJournal(entry);
      lastWriteError = undefined;
      break;
    } catch (error) {
      lastWriteError = error;
    }
  }
  if (lastWriteError !== undefined) throw lastWriteError;
  const updated = dependencies.compareAndSwap(entry);
  try {
    await dependencies.removeJournal(entry);
    return { updated, cleanupPending: false };
  } catch {
    // SQLite is already authoritative. Leaving the journal is safe: the next
    // reconciliation will see targetVersion (or newer) and discard it.
    return { updated, cleanupPending: true };
  }
}
