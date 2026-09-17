import { TZDate } from "@date-fns/tz";

import type { Task } from "./types";

/**
 * When a recurring task's next occurrence falls due.
 *
 * Pure, and the SECOND of two implementations: `complete_task_with_next`
 * (20260917000200) computes the same answer in SQL, and that one is
 * authoritative — the client's value is optimistic and is replaced by the
 * server's when the write lands. They are held together by a live test that
 * runs a table of rules through both and compares. If you change anything in
 * `nextDueDate`, change the function too, or that test is what will tell you.
 *
 * Three rules govern every date here:
 *
 * 1. **Measured from the due date**, never from today. A weekly task due
 *    Monday stays due Mondays even when it is finished on Wednesday.
 * 2. **Strictly after today**, so completing a late task does not immediately
 *    hand back another overdue one. The cost is documented on `nextDueDate`.
 * 3. **Computed in the series' own timezone**, so two people in different
 *    countries completing the same task produce identical instants.
 */

export const REPEAT_UNITS = ["day", "week", "month"] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];

export interface RepeatRule {
  unit: RepeatUnit;
  /** Units between occurrences. An integer, 1–999. */
  interval: number;
  /**
   * The day of the month the series intends, 1–31. Present for `month` and
   * absent otherwise, because `day` and `week` arithmetic never clamps.
   *
   * It exists so a task due the 31st lands on the 28th in February and then
   * RETURNS to the 31st in March. Computing each occurrence from the previous
   * one's date alone would clamp once and stay clamped for ever.
   */
  anchorDay: number | null;
  /**
   * The IANA zone the series' calendar is computed in — captured once, when
   * the rule is created, and preserved through every later edit.
   *
   * `dueDate` is an instant and carries no zone, so "what date is this, and
   * what is the next one" has no answer until one is named. Without this the
   * series would re-anchor to whoever happened to close the card.
   */
  timeZone: string;
}

/** Roughly 11 years of daily, 76 of weekly, 333 of monthly. A base older than
 *  that is a corrupt row rather than a schedule, and returning null beats
 *  spinning. */
const MAX_ADVANCES = 4000;

const isZone = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    // The only reliable check: ask Intl to use it.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Narrows untrusted input — a persisted localStorage blob, a row written
 *  before the check constraint existed, anything hand-edited. Fails closed. */
export function isRepeatRule(value: unknown): value is RepeatRule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<RepeatRule>;
  if (!REPEAT_UNITS.includes(r.unit as RepeatUnit)) return false;
  if (typeof r.interval !== "number" || !Number.isInteger(r.interval)) return false;
  if (r.interval < 1 || r.interval > 999) return false;
  if (!isZone(r.timeZone)) return false;
  // The anchor belongs to months and only to months — the same shape the
  // database's `tasks_repeat_shape` constraint enforces.
  const wantsAnchor = r.unit === "month";
  const hasAnchor = typeof r.anchorDay === "number";
  if (wantsAnchor !== hasAnchor) return false;
  if (hasAnchor && (!Number.isInteger(r.anchorDay) || r.anchorDay! < 1 || r.anchorDay! > 31)) {
    return false;
  }
  return true;
}

/** The four columns as one value, or null. Used by the Supabase row mapping
 *  and by the local backend's defaulting of older persisted state. */
export function toRepeatRule(
  unit: string | null | undefined,
  interval: number | null | undefined,
  anchorDay: number | null | undefined,
  timeZone: string | null | undefined
): RepeatRule | null {
  const candidate = {
    unit,
    interval,
    anchorDay: anchorDay ?? null,
    timeZone,
  };
  return isRepeatRule(candidate) ? candidate : null;
}

/** Whether completing this task should produce another one. The single
 *  predicate both of the store's completion detectors ask, so they cannot
 *  disagree about what repeats. */
export function repeats(task: Pick<Task, "dueDate" | "repeat">): boolean {
  return task.dueDate !== null && isRepeatRule(task.repeat);
}

/** Days in the month `date` falls in, read in its own zone. */
const daysInMonth = (year: number, monthIndex: number, tz: string): number =>
  new TZDate(year, monthIndex + 1, 0, 12, 0, 0, 0, tz).getDate();

/**
 * The due date of the occurrence that follows `dueDate`, or null when there is
 * nothing to schedule.
 *
 * `now` is a parameter rather than a read so callers — and every test — can be
 * exact about "today" instead of racing a clock.
 *
 * **Strictly after today, and a late daily task therefore skips today.** Due
 * yesterday, completed today: the first candidate IS today, which is not
 * strictly after it, so the answer is tomorrow and today's occurrence never
 * exists. That follows from one completion making exactly one successor, and
 * it is the same rule that keeps a late weekly task on its own weekday.
 */
export function nextDueDate(
  dueDate: number | null,
  rule: RepeatRule | null,
  now: number = Date.now()
): number | null {
  if (dueDate === null || !Number.isFinite(dueDate)) return null;
  if (!isRepeatRule(rule)) return null;

  const tz = rule.timeZone;
  const base = new TZDate(dueDate, tz);
  const baseYear = base.getFullYear();
  const baseMonth = base.getMonth();
  const baseDay = base.getDate();

  // Today's calendar date in the SERIES' zone, not the caller's.
  const todayRef = new TZDate(now, tz);
  const todayKey =
    todayRef.getFullYear() * 10000 + (todayRef.getMonth() + 1) * 100 + todayRef.getDate();

  for (let k = 1; k <= MAX_ADVANCES; k++) {
    let y: number;
    let m: number;
    let d: number;

    if (rule.unit === "month") {
      const total = baseMonth + rule.interval * k;
      y = baseYear + Math.floor(total / 12);
      m = ((total % 12) + 12) % 12;
      // The anchor, clamped to this month's length — never the previous
      // occurrence's possibly-clamped day.
      d = Math.min(rule.anchorDay as number, daysInMonth(y, m, tz));
    } else {
      // Calendar arithmetic, not milliseconds: adding 7 * 86_400_000 across a
      // DST boundary lands at 23:00 on the day before.
      const step = rule.unit === "week" ? 7 : 1;
      const moved = new TZDate(baseYear, baseMonth, baseDay + rule.interval * k * step, 12, 0, 0, 0, tz);
      y = moved.getFullYear();
      m = moved.getMonth();
      d = moved.getDate();
    }

    const key = y * 10000 + (m + 1) * 100 + d;
    if (key > todayKey) {
      // Local midnight in the series' zone. In the handful of places where
      // midnight does not exist on a spring-forward day this resolves to 01:00,
      // which is still inside the right calendar day — the same property
      // `new Date(\`${ymd}T00:00:00\`)` already has everywhere else in the app.
      return new TZDate(y, m, d, 0, 0, 0, 0, tz).getTime();
    }
  }
  return null;
}

const ORDINAL = (n: number): string => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
};

/** One phrasing, used by the dialog's helper line, the card's screen-reader
 *  text and the list row's — so they cannot describe the same rule two ways. */
export function describeRepeat(rule: RepeatRule | null): string {
  if (!isRepeatRule(rule)) return "Does not repeat";
  const plural = rule.interval === 1 ? rule.unit : `${rule.unit}s`;
  const every = rule.interval === 1 ? `Every ${plural}` : `Every ${rule.interval} ${plural}`;
  return rule.unit === "month" ? `${every} on the ${ORDINAL(rule.anchorDay as number)}` : every;
}
