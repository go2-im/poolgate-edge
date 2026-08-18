import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, importMasterKey, sha256Hex } from "../src/crypto";

describe("credential encryption", () => {
  it("round trips AES-256-GCM ciphertext", async () => {
    const encoded = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)));
    const key = await importMasterKey(encoded);
    const ciphertext = await encryptSecret(key, "refresh-token");
    expect(ciphertext).not.toContain("refresh-token");
    expect(await decryptSecret(key, ciphertext)).toBe("refresh-token");
  });

  it("hashes API keys deterministically", async () => {
    expect(await sha256Hex("poolgate")).toBe(await sha256Hex("poolgate"));
    expect(await sha256Hex("poolgate")).toHaveLength(64);
  });
});
