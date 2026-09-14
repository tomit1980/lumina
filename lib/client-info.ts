/**
 * The client record's shared vocabulary: which documents exist, how money and
 * dates are written down, and what counts as a plausible phone number.
 *
 * This file is deliberately free of React, the store and the backend. Every
 * layer that has an opinion about a client field — the pane, the store's
 * validation, the tests — imports it from here, so "what a valid email looks
 * like" has exactly one answer rather than one per caller.
 */

/**
 * The documents a case needs before it can be lodged.
 *
 * A LIST, NOT FIVE COLUMNS. The database stores one row per
 * (project, document_type) and accepts any type string, so adding a sixth
 * document is one entry here — no migration, no type regeneration, no deploy
 * of the schema. `id` is what goes in the column and must never change once
 * rows exist; `label` is what the person reads and may.
 */
export const CLIENT_DOCUMENT_TYPES = [
  { id: "photo_id_front", label: "Photo ID (front)" },
  { id: "photo_id_back", label: "Photo ID (back)" },
  { id: "bank_statement", label: "Bank statement" },
  { id: "certified_id", label: "Certified ID" },
  { id: "certified_bank_statement", label: "Certified bank statement" },
] as const;

export type ClientDocumentType = (typeof CLIENT_DOCUMENT_TYPES)[number]["id"];

/** How many of the known documents are marked received. Counts the constant's
 *  entries, not the map's keys: a stray row for a document type that has since
 *  been retired must not make the total read "4 / 5 received". */
export function receivedCount(documents: Record<string, boolean>): number {
  return CLIENT_DOCUMENT_TYPES.filter((d) => documents[d.id] === true).length;
}

/**
 * The workspace's currency.
 *
 * Australian, because the practice is. It is a named constant rather than a
 * literal in five places so that the day a second currency appears, the places
 * that assumed one are findable.
 */
export const DEFAULT_CURRENCY = "AUD";

/** What the biggest `numeric(14,2)` can hold: 12 digits before the point. */
const MAX_AMOUNT = 999_999_999_999.99;

/**
 * Turns what somebody typed into an amount, or says why not.
 *
 * Accepts "$", thousands separators and surrounding space, because those are
 * what a person pastes out of a portal. Rejects anything else rather than
 * silently reading "12,0OO" as 12 — a money field that quietly loses digits is
 * worse than one that refuses.
 *
 * An empty string is `null`, which is "not yet known" and a legitimate value.
 * It is NOT zero: those are different answers and the column distinguishes.
 */
export function parseMoney(
  raw: string
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  const cleaned = trimmed.replace(/[$\s,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return {
      ok: false,
      error: "Enter an amount like 12500 or 12500.50.",
    };
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return { ok: false, error: "Enter an amount like 12500 or 12500.50." };
  }
  if (value > MAX_AMOUNT) {
    return { ok: false, error: "That amount is too large to store." };
  }
  // Rounded here rather than trusted: the column is numeric(14,2) and the
  // regex already limits input to two places, so this only ever removes
  // floating-point dust like 12500.499999999999.
  return { ok: true, value: Math.round(value * 100) / 100 };
}

/**
 * The amount as the pane shows it.
 *
 * `Intl.NumberFormat` rather than a hand-rolled "$" + toFixed(2): it puts the
 * separators where the reader's locale expects them and knows how many decimal
 * places a currency actually has. Falls back to a plain rendering if the
 * currency code is one the runtime does not recognise, because a thrown
 * RangeError in a render is a blank screen over a formatting detail.
 */
export function formatMoney(
  amount: number | null,
  currency: string = DEFAULT_CURRENCY
): string {
  if (amount === null) return "";
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** What goes in the text box while it is being edited: the digits only, so
 *  that focusing a field and pressing End does not land after a currency
 *  symbol. Formatting is for the resting state. */
export function moneyInputValue(amount: number | null): string {
  return amount === null ? "" : String(amount);
}

/**
 * A loose email check, and loose on purpose.
 *
 * This is a note of how to contact a client, not a login. The only thing worth
 * refusing is an entry that cannot possibly be an address — no "@", nothing
 * before it, nothing that looks like a domain after it — because a stricter
 * rule rejects real addresses (apostrophes, new TLDs, plus-addressing) and the
 * person then cannot record the truth.
 */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * A loose phone check.
 *
 * International from the start: "+61 412 345 678", "(02) 9876 5432" and
 * "0412-345-678" all pass. The rule is "at least six digits, and nothing in it
 * that is not a digit, space, +, -, ( ), or a full stop" — enough to catch a
 * name typed into the phone box, not enough to argue with a real number.
 */
export function isPlausiblePhone(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 15;
}

/**
 * An ISO date as the pane shows it.
 *
 * NO `Date` IS CONSTRUCTED. `new Date("1980-03-02")` is parsed as UTC midnight
 * and then rendered in the reader's zone, which is how a date of birth becomes
 * the 1st for anyone west of Greenwich — the exact bug this codebase has hit
 * twice with `Task.dueDate`. Splitting the string cannot go wrong.
 */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatIsoDate(iso: string | null): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  if (!name) return iso;
  return `${Number(day)} ${name} ${year}`;
}

/** Whether a string is a date the `date` column will take. `<input type="date">`
 *  produces exactly this or "", but the store must not assume its only caller
 *  is that input. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Rejects 2025-02-30 and friends. `Date.UTC` is arithmetic on a calendar,
  // not a local instant, so it is safe here where display formatting is not.
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  );
}
