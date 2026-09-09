// @vitest-environment jsdom
//
// Genuine RFC-6238 TOTP, kept for the local demo path (`lib/totp.ts`).
//
// The auth swap deleted `lib/crypto.ts`, which held the demo's password
// hashing, an AES-GCM "credential vault" *and* this. The first two were
// browser-side theatre — the wrapping key shipped in the bundle — and are
// gone for good. This one stayed, because the alternative to real
// verification is a two-factor screen that accepts any six digits, which is
// a lie told by the UI. These tests are what stop it drifting into that.
//
// Adapted from the deleted Suite A8, keeping its fixed mid-step instant so
// that ±1 step lands cleanly on adjacent windows.
import { describe, expect, it } from "vitest";

import {
  base32Encode,
  generateTotpSecret,
  totpAuthUri,
  totpNow,
  totpSecondsRemaining,
  verifyTotp,
} from "@/lib/totp";

const SECRET = "MZXW6YTBOI";
const STEP_MS = 30_000;
const NOW = 1_700_000_015_000; // mid-step

describe("base32Encode (RFC 4648 vectors — this implementation never pads)", () => {
  const enc = (s: string) => base32Encode(new TextEncoder().encode(s));

  it.each([
    { input: "", expected: "" },
    { input: "f", expected: "MY" },
    { input: "fo", expected: "MZXQ" },
    { input: "foo", expected: "MZXW6" },
    { input: "foob", expected: "MZXW6YQ" },
    { input: "fooba", expected: "MZXW6YTB" },
    { input: "foobar", expected: "MZXW6YTBOI" },
  ])("encodes $input", ({ input, expected }) => {
    expect(enc(input)).toBe(expected);
  });
});

describe("generateTotpSecret", () => {
  it("returns base32 an authenticator app can accept", () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("does not repeat across many draws", () => {
    const seen = new Set(Array.from({ length: 25 }, () => generateTotpSecret()));
    expect(seen.size).toBe(25);
  });
});

describe("totpAuthUri", () => {
  it("builds an otpauth URI carrying the secret, issuer and account", () => {
    const uri = totpAuthUri({
      secret: SECRET,
      account: "moshe@northlight.studio",
      issuer: "Lumina",
    });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(`secret=${SECRET}`);
    expect(uri).toContain("issuer=Lumina");
    expect(decodeURIComponent(uri)).toContain("moshe@northlight.studio");
  });
});

describe("verifyTotp", () => {
  it("accepts the code for the current window", async () => {
    expect(await verifyTotp(SECRET, await totpNow(SECRET, NOW), 1, NOW)).toBe(true);
  });

  it("accepts one step either side, so a slightly wrong clock still works", async () => {
    const past = await totpNow(SECRET, NOW - STEP_MS);
    const future = await totpNow(SECRET, NOW + STEP_MS);
    expect(await verifyTotp(SECRET, past, 1, NOW)).toBe(true);
    expect(await verifyTotp(SECRET, future, 1, NOW)).toBe(true);
  });

  it("rejects two steps away — the drift window is not open-ended", async () => {
    const twoPast = await totpNow(SECRET, NOW - 2 * STEP_MS);
    const twoFuture = await totpNow(SECRET, NOW + 2 * STEP_MS);
    expect(await verifyTotp(SECRET, twoPast, 1, NOW)).toBe(false);
    expect(await verifyTotp(SECRET, twoFuture, 1, NOW)).toBe(false);
  });

  it("rejects a code generated from a different secret", async () => {
    const other = await totpNow("GEZDGNBVGY3TQOJQ", NOW);
    expect(await verifyTotp(SECRET, other, 1, NOW)).toBe(false);
  });

  it("rejects malformed input rather than throwing", async () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "······"]) {
      expect(await verifyTotp(SECRET, bad, 1, NOW)).toBe(false);
    }
  });

  it("tolerates whitespace in a pasted code", async () => {
    const code = await totpNow(SECRET, NOW);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(await verifyTotp(SECRET, spaced, 1, NOW)).toBe(true);
  });

  it("is not a stub: a wrong six-digit code is refused", async () => {
    // The failure this whole file exists to prevent. An implementation that
    // waved everything through would satisfy every acceptance test above;
    // only this one catches it.
    const right = await totpNow(SECRET, NOW);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    expect(await verifyTotp(SECRET, wrong, 1, NOW)).toBe(false);
  });
});

describe("totpSecondsRemaining", () => {
  it("counts down inside the 30-second window", () => {
    expect(totpSecondsRemaining(0)).toBe(30);
    expect(totpSecondsRemaining(10_000)).toBe(20);
    expect(totpSecondsRemaining(29_000)).toBe(1);
  });
});
