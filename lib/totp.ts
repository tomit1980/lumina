/**
 * TOTP for the local demo path only.
 *
 * This is a genuine RFC-6238 implementation — the demo's two-factor prompt
 * really does verify a Google Authenticator code rather than waving through
 * any six digits. That honesty is the whole point of keeping it.
 *
 * What used to sit beside this — PBKDF2 password hashing and an AES-GCM
 * "credential vault" — is gone. Both were browser-side theatre: the wrapping
 * key shipped inside the bundle. Real passwords are Supabase's job now. This
 * file retires with the rest of the demo at cutover.
 */

const enc = new TextEncoder();

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function randomBytes(length: number): Uint8Array {
  const b = new Uint8Array(length);
  crypto.getRandomValues(b);
  return b;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAuthUri(options: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const { secret, account, issuer } = options;
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return bytes;
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, message as BufferSource);
  return toBytes(sig);
}

const PERIOD_SECONDS = 30;

async function totpForCounter(secret: string, counter: number): Promise<string> {
  const key = base32Decode(secret);
  const hmac = await hmacSha1(key, counterBytes(counter));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

export function totpNow(secret: string, atMs = Date.now()): Promise<string> {
  return totpForCounter(secret, Math.floor(atMs / 1000 / PERIOD_SECONDS));
}

export async function verifyTotp(
  secret: string,
  code: string,
  window = 1,
  atMs = Date.now()
): Promise<boolean> {
  const trimmed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  for (let i = -window; i <= window; i++) {
    const expected = await totpForCounter(secret, counter + i);
    if (timingSafeEqual(expected, trimmed)) return true;
  }
  return false;
}

export function totpSecondsRemaining(atMs = Date.now()): number {
  return PERIOD_SECONDS - (Math.floor(atMs / 1000) % PERIOD_SECONDS);
}
