/**
 * Browser-native crypto primitives for Lumina's auth layer.
 *
 * SECURITY BOUNDARY — read this before trusting it:
 * Lumina has no backend; everything runs in the browser against localStorage.
 * That means:
 *   • Passwords are hashed with PBKDF2-SHA256 (never stored in plaintext), so a
 *     leaked store can't be trivially reversed — this part is genuinely useful.
 *   • TOTP 2FA is real RFC-6238 and Google Authenticator compatible.
 *   • The credential store is AES-GCM encrypted at rest, but the wrapping key is
 *     derived from a constant that ships in the bundle. That's obfuscation, not
 *     true confidentiality: anyone who can run this code can derive the key.
 * A real deployment must move verification server-side (see README). This module
 * is correct in its mechanisms; it is not a substitute for a trusted server.
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

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Length-independent-ish equality check to avoid early-exit timing leaks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Password hashing — PBKDF2-SHA256
// ---------------------------------------------------------------------------

export interface PasswordHash {
  algo: "PBKDF2-SHA256";
  salt: string; // base64
  hash: string; // base64
  iterations: number;
}

const PBKDF2_ITERATIONS = 210_000;
const HASH_BYTES = 32;

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  bytes: number
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    bytes * 8
  );
  return new Uint8Array(derived);
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, HASH_BYTES);
  return {
    algo: "PBKDF2-SHA256",
    salt: toBase64(salt),
    hash: toBase64(hash),
    iterations: PBKDF2_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  record: PasswordHash
): Promise<boolean> {
  const salt = fromBase64(record.salt);
  const hash = await pbkdf2(password, salt, record.iterations, HASH_BYTES);
  return timingSafeEqual(toBase64(hash), record.hash);
}

// ---------------------------------------------------------------------------
// TOTP — RFC 6238, Google Authenticator compatible (base32 secret, SHA-1, 6 digits)
// ---------------------------------------------------------------------------

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

/** A fresh, 20-byte (160-bit) base32 secret suitable for an authenticator app. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth:// URI that authenticator apps read from a QR code. */
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

/** Current 6-digit code for a secret (mainly for tests / previews). */
export function totpNow(secret: string, atMs = Date.now()): Promise<string> {
  return totpForCounter(secret, Math.floor(atMs / 1000 / PERIOD_SECONDS));
}

/** Verify a user-entered code, allowing ±`window` steps for clock drift. */
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

/** Seconds remaining in the current TOTP window (for a live countdown ring). */
export function totpSecondsRemaining(atMs = Date.now()): number {
  return PERIOD_SECONDS - (Math.floor(atMs / 1000) % PERIOD_SECONDS);
}

// ---------------------------------------------------------------------------
// AES-GCM encryption of the credential store at rest
// ---------------------------------------------------------------------------

// Constant wrapping material. This ships in the bundle, so it protects against
// casual localStorage inspection only — NOT against anyone running the code.
const WRAP_PASSPHRASE = "lumina.local.credential.vault.v1";
const WRAP_SALT = "lumina-static-wrap-salt";

let cachedKey: CryptoKey | null = null;

async function wrappingKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(WRAP_PASSPHRASE),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  cachedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(WRAP_SALT),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return cachedKey;
}

export interface EncryptedBlob {
  v: 1;
  iv: string; // base64
  data: string; // base64
}

export async function encryptJSON(value: unknown): Promise<EncryptedBlob> {
  const key = await wrappingKey();
  const iv = randomBytes(12);
  const plaintext = enc.encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  );
  return { v: 1, iv: toBase64(iv), data: toBase64(toBytes(cipher)) };
}

export async function decryptJSON<T>(blob: EncryptedBlob): Promise<T> {
  const key = await wrappingKey();
  const iv = fromBase64(blob.iv);
  const data = fromBase64(blob.data);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    data as BufferSource
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
