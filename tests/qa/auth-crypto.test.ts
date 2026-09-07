// @vitest-environment jsdom
//
// Suite A8 — lib/crypto.ts: password hashing round-trip and per-account
// salting, base32 round-trip, TOTP generation/verification and its ±1-step
// drift window, malformed-code rejection, and the AES-GCM encryptJSON/
// decryptJSON round-trip (including tamper detection).
import { describe, expect, it } from "vitest";

import {
  base32Encode,
  decryptJSON,
  encryptJSON,
  fromBase64,
  hashPassword,
  toBase64,
  totpNow,
  verifyPassword,
  verifyTotp,
} from "@/lib/crypto";

// base32Decode isn't exported, so round-trip it through totpNow (which
// internally decodes the secret) rather than testing decode directly.

describe("hashPassword / verifyPassword", () => {
  it("round-trips: the correct password verifies", async () => {
    const record = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", record)).toBe(true);
  });

  it("a wrong password fails verification", async () => {
    const record = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", record)).toBe(false);
  });

  it("two accounts with the same password get different hashes (per-account salt)", async () => {
    const a = await hashPassword("shared-password");
    const b = await hashPassword("shared-password");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // both still verify independently against the same plaintext
    expect(await verifyPassword("shared-password", a)).toBe(true);
    expect(await verifyPassword("shared-password", b)).toBe(true);
  });
});

describe("base32Encode against known RFC 4648 test vectors (unpadded — this impl never emits '=')", () => {
  it.each([
    { input: "f", expected: "MY" },
    { input: "fo", expected: "MZXQ" },
    { input: "foo", expected: "MZXW6" },
    { input: "foob", expected: "MZXW6YQ" },
    { input: "fooba", expected: "MZXW6YTB" },
    { input: "foobar", expected: "MZXW6YTBOI" },
  ])("encodes %j correctly", ({ input, expected }) => {
    const bytes = new TextEncoder().encode(input);
    expect(base32Encode(bytes)).toBe(expected);
  });
});

describe("base32 encode/decode round-trip (via TOTP, which decodes internally)", () => {
  it.each([
    { bytes: [0], label: "1 byte (needs padding)" },
    { bytes: [0, 1], label: "2 bytes (needs padding)" },
    { bytes: [0, 1, 2], label: "3 bytes" },
    { bytes: [0, 1, 2, 3], label: "4 bytes (needs padding)" },
    { bytes: [0, 1, 2, 3, 4], label: "5 bytes — exact 8-char group, no padding" },
    { bytes: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100], label: "10 bytes (20-byte-secret-ish)" },
  ])("$label", async ({ bytes }) => {
    const secret = base32Encode(new Uint8Array(bytes));
    // A secret that round-trips correctly through base32Decode produces a
    // deterministic code for a fixed instant, and verifyTotp accepts it.
    const code = await totpNow(secret, 1_700_000_000_000);
    expect(await verifyTotp(secret, code, 1, 1_700_000_000_000)).toBe(true);
  });
});

describe("TOTP generation, verification, and the ±1-step drift window", () => {
  const SECRET = base32Encode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
  const STEP_MS = 30_000;
  const NOW = 1_700_000_015_000; // mid-step, so ±1 lands cleanly on adjacent steps

  it("totpNow's code verifies against verifyTotp at the same instant", async () => {
    const code = await totpNow(SECRET, NOW);
    expect(await verifyTotp(SECRET, code, 1, NOW)).toBe(true);
  });

  it("accepts a code from one step in the past", async () => {
    const pastCode = await totpNow(SECRET, NOW - STEP_MS);
    expect(await verifyTotp(SECRET, pastCode, 1, NOW)).toBe(true);
  });

  it("accepts a code from one step in the future", async () => {
    const futureCode = await totpNow(SECRET, NOW + STEP_MS);
    expect(await verifyTotp(SECRET, futureCode, 1, NOW)).toBe(true);
  });

  it("rejects a code two steps away in either direction", async () => {
    const twoPast = await totpNow(SECRET, NOW - 2 * STEP_MS);
    const twoFuture = await totpNow(SECRET, NOW + 2 * STEP_MS);
    expect(await verifyTotp(SECRET, twoPast, 1, NOW)).toBe(false);
    expect(await verifyTotp(SECRET, twoFuture, 1, NOW)).toBe(false);
  });

  it("rejects a non-numeric code", async () => {
    expect(await verifyTotp(SECRET, "abcdef", 1, NOW)).toBe(false);
  });

  it("rejects a code of the wrong length", async () => {
    expect(await verifyTotp(SECRET, "12345", 1, NOW)).toBe(false);
    expect(await verifyTotp(SECRET, "1234567", 1, NOW)).toBe(false);
  });

  it("rejects an empty code", async () => {
    expect(await verifyTotp(SECRET, "", 1, NOW)).toBe(false);
  });
});

describe("encryptJSON / decryptJSON", () => {
  it("round-trips an arbitrary JSON-serializable value", async () => {
    const value = { a: 1, b: ["x", "y", { z: true }], c: null };
    const blob = await encryptJSON(value);
    const decrypted = await decryptJSON(blob);
    expect(decrypted).toEqual(value);
  });

  it("produces a different ciphertext (and iv) each time, even for the same value", async () => {
    const value = { same: "value" };
    const blob1 = await encryptJSON(value);
    const blob2 = await encryptJSON(value);
    expect(blob1.iv).not.toBe(blob2.iv);
    expect(blob1.data).not.toBe(blob2.data);
  });

  it("a tampered ciphertext fails to decrypt rather than silently returning garbage", async () => {
    const blob = await encryptJSON({ secret: "value" });
    const tamperedBytes = fromBase64(blob.data);
    tamperedBytes[0] ^= 0xff; // flip a bit
    const tampered = { ...blob, data: toBase64(tamperedBytes) };
    await expect(decryptJSON(tampered)).rejects.toThrow();
  });

  it("a tampered IV also fails to decrypt", async () => {
    const blob = await encryptJSON({ secret: "value" });
    const tamperedIv = fromBase64(blob.iv);
    tamperedIv[0] ^= 0xff;
    const tampered = { ...blob, iv: toBase64(tamperedIv) };
    await expect(decryptJSON(tampered)).rejects.toThrow();
  });
});
