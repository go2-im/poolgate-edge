import { describe, expect, it, vi } from "vitest";
import {
  isTerminalOAuthFailure,
  parseRotationJournal,
  persistCredentialRotation,
  rotationReconcileAction
} from "../src/credential-rotation";
import type { RotationJournalEntry } from "../src/types";

function journal(): RotationJournalEntry {
  return {
    accountId: "acct_1",
    baseVersion: 3,
    targetVersion: 4,
    accessTokenCiphertext: "v1.access",
    refreshTokenCiphertext: "v1.refresh",
    idTokenCiphertext: "v1.id",
    createdAt: "2026-08-18T00:00:00.000Z"
  };
}

describe("credential rotation journal", () => {
  it("expires an account only for an explicit invalid_grant", () => {
    expect(isTerminalOAuthFailure("invalid_grant")).toBe(true);
    expect(isTerminalOAuthFailure("temporarily_unavailable")).toBe(false);
    expect(isTerminalOAuthFailure("invalid_client")).toBe(false);
  });

  it("classifies base, applied, and ambiguous versions", () => {
    expect(rotationReconcileAction(3, journal())).toBe("apply");
    expect(rotationReconcileAction(4, journal())).toBe("discard");
    expect(rotationReconcileAction(8, journal())).toBe("discard");
    expect(() => rotationReconcileAction(2, journal())).toThrow(/version/);
  });

  it("validates journal structure and account binding", () => {
    expect(parseRotationJournal(journal(), "acct_1")).toEqual(journal());
    expect(() => parseRotationJournal({ ...journal(), accountId: "acct_2" }, "acct_1")).toThrow(/invalid/);
    expect(() => parseRotationJournal({ ...journal(), targetVersion: 9 }, "acct_1")).toThrow(/invalid/);
  });

  it("never commits if the durable journal write fails", async () => {
    const writeJournal = vi.fn(async () => { throw new Error("R2 unavailable"); });
    const compareAndSwap = vi.fn(() => true);
    const removeJournal = vi.fn(async () => undefined);
    await expect(persistCredentialRotation(journal(), {
      writeJournal,
      compareAndSwap,
      removeJournal
    })).rejects.toThrow(/R2/);
    expect(compareAndSwap).not.toHaveBeenCalled();
    expect(removeJournal).not.toHaveBeenCalled();
    expect(writeJournal).toHaveBeenCalledTimes(3);
  });

  it("commits after a transient journal write failure", async () => {
    let attempts = 0;
    await expect(persistCredentialRotation(journal(), {
      writeJournal: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary R2 failure");
      },
      compareAndSwap: () => true,
      removeJournal: async () => undefined
    })).resolves.toEqual({ updated: true, cleanupPending: false });
    expect(attempts).toBe(3);
  });

  it("leaves the journal intact when the SQLite commit fails", async () => {
    const removeJournal = vi.fn(async () => undefined);
    await expect(persistCredentialRotation(journal(), {
      writeJournal: async () => undefined,
      compareAndSwap: () => { throw new Error("SQLite unavailable"); },
      removeJournal
    })).rejects.toThrow(/SQLite/);
    expect(removeJournal).not.toHaveBeenCalled();
  });

  it("treats cleanup failure after commit as recoverable", async () => {
    await expect(persistCredentialRotation(journal(), {
      writeJournal: async () => undefined,
      compareAndSwap: () => true,
      removeJournal: async () => { throw new Error("delete failed"); }
    })).resolves.toEqual({ updated: true, cleanupPending: true });
  });
});
