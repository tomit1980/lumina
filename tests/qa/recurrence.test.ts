// The recurrence calendar. Pure, so every case here is an assertion rather
// than a clock race — `now` is injected.
//
// Node environment (vitest.config.ts's default); no jsdom needed.
//
// HOW THESE ASSERT. Inputs are built with TZDate, the library under test's own
// constructor. Outputs are read back with `Intl.DateTimeFormat`, which is not.
// A bug that leaked the HOST timezone into the arithmetic would have to leak
// identically into both to escape, and the zones used here are deliberately
// nowhere near any machine this runs on.
import { TZDate } from "@date-fns/tz";
import { describe, expect, it } from "vitest";

import {
  describeRepeat,
  isRepeatRule,
  nextDueDate,
  repeats,
  ruleForSave,
  toRepeatRule,
  type RepeatRule,
} from "@/lib/recurrence";

const SYD = "Australia/Sydney";
const NY = "America/New_York";

/** Local midnight of `ymd` in `tz`, as an instant. */
const at = (tz: string, ymd: string): number => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new TZDate(y, m - 1, d, 0, 0, 0, 0, tz).getTime();
};

/** What an instant reads as on a wall clock in `tz` — the independent check. */
const wall = (ms: number | null, tz: string): string => {
  if (ms === null) return "null";
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
};

const rule = (
  unit: RepeatRule["unit"],
  interval: number,
  timeZone = SYD,
  anchorDay: number | null = unit === "month" ? 1 : null
): RepeatRule => ({ unit, interval, anchorDay, timeZone });

const DAY = 86_400_000;

describe("nextDueDate — measured from the due date (D2)", () => {
  it("a daily task due today gets tomorrow", () => {
    const due = at(SYD, "2026-06-10");
    const next = nextDueDate(due, rule("day", 1), at(SYD, "2026-06-10") + 9 * 3_600_000);
    expect(wall(next, SYD)).toBe("2026-06-11 00:00");
  });

  it("a daily task due 3 days ago gets ONE date, not three", () => {
    const due = at(SYD, "2026-06-07");
    const next = nextDueDate(due, rule("day", 1), at(SYD, "2026-06-10"));
    expect(wall(next, SYD)).toBe("2026-06-11 00:00");
  });

  it("D9: a daily task completed a day late SKIPS today", () => {
    // Due yesterday, completed today. k=1 lands on today, which is not
    // strictly after today, so today's occurrence never exists. This is the
    // documented cost of the strict-future rule and it is pinned here so it
    // stays a decision rather than becoming an accident.
    const due = at(SYD, "2026-06-09");
    const next = nextDueDate(due, rule("day", 1), at(SYD, "2026-06-10") + 3_600_000);
    expect(wall(next, SYD)).toBe("2026-06-11 00:00");
  });

  it("a weekly task finished three weeks late still lands on its own weekday", () => {
    const due = at(SYD, "2026-06-01"); // a Monday
    const next = nextDueDate(due, rule("week", 1), at(SYD, "2026-06-22"));
    expect(wall(next, SYD)).toBe("2026-06-29 00:00");
    // The testable form of "stays on Mondays": the gap is a whole number of
    // intervals from the ORIGINAL due date, never from today.
    expect((next! - due) % (7 * DAY)).toBe(0);
  });

  it("a weekly task finished EARLY advances from the due date, not from today", () => {
    const due = at(SYD, "2026-06-19"); // Friday, still ahead
    const next = nextDueDate(due, rule("week", 1), at(SYD, "2026-06-15"));
    expect(wall(next, SYD)).toBe("2026-06-26 00:00");
  });

  it("every-3-days lands on the rule's own cadence", () => {
    const due = at(SYD, "2026-05-31");
    const next = nextDueDate(due, rule("day", 3), at(SYD, "2026-06-10"));
    expect((next! - due) % (3 * DAY)).toBe(0);
    expect(next!).toBeGreaterThan(at(SYD, "2026-06-10"));
    expect(next! - 3 * DAY).toBeLessThanOrEqual(at(SYD, "2026-06-10"));
  });
});

describe("nextDueDate — monthly keeps the day it was given (D7)", () => {
  const monthly31 = rule("month", 1, SYD, 31);

  it("the 31st becomes the 28th in February", () => {
    expect(wall(nextDueDate(at(SYD, "2026-01-31"), monthly31, at(SYD, "2026-02-01")), SYD))
      .toBe("2026-02-28 00:00");
  });

  it("and the 29th in a leap February", () => {
    expect(wall(nextDueDate(at(SYD, "2028-01-31"), monthly31, at(SYD, "2028-02-01")), SYD))
      .toBe("2028-02-29 00:00");
  });

  it("THE CASE THE ANCHOR EXISTS FOR: it returns to the 31st in March", () => {
    // Four single-step completions, each computed from the occurrence before
    // it — the normal path, not one multi-step catch-up. Without the anchor
    // this clamps to the 28th in February and stays there for ever.
    let due = at(SYD, "2026-01-31");
    const got: string[] = [];
    for (const today of ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]) {
      due = nextDueDate(due, monthly31, at(SYD, today))!;
      got.push(wall(due, SYD));
    }
    expect(got).toEqual([
      "2026-02-28 00:00",
      "2026-03-31 00:00",
      "2026-04-30 00:00",
      "2026-05-31 00:00",
    ]);
  });

  it("CONTROL: an anchor of 15 is never clamped, so it is the same every month", () => {
    // Proves the case above passes because of the anchor rather than because
    // month arithmetic happens to work.
    let due = at(SYD, "2026-01-15");
    const got: string[] = [];
    for (const today of ["2026-02-01", "2026-03-01"]) {
      due = nextDueDate(due, rule("month", 1, SYD, 15), at(SYD, today))!;
      got.push(wall(due, SYD));
    }
    expect(got).toEqual(["2026-02-15 00:00", "2026-03-15 00:00"]);
  });

  it("every-2-months from an anchored 31st", () => {
    expect(wall(nextDueDate(at(SYD, "2026-10-31"), rule("month", 2, SYD, 31), at(SYD, "2026-11-05")), SYD))
      .toBe("2026-12-31 00:00");
  });

  it("rolls the year", () => {
    expect(wall(nextDueDate(at(SYD, "2026-12-15"), rule("month", 1, SYD, 15), at(SYD, "2026-12-20")), SYD))
      .toBe("2027-01-15 00:00");
  });
});

describe("nextDueDate — the series' timezone, not the completer's (D8)", () => {
  it("returns local midnight IN THE RULE'S ZONE, whatever the host is", () => {
    const due = at(SYD, "2026-06-10");
    const next = nextDueDate(due, rule("day", 1, SYD), at(SYD, "2026-06-10"));
    expect(wall(next, SYD)).toBe("2026-06-11 00:00");
  });

  it("two series a day apart in wall-clock terms produce different instants", () => {
    // Same calendar dates, different zones: if the implementation ignored the
    // rule's zone these would be equal, and they are 14 hours apart.
    const a = nextDueDate(at(SYD, "2026-06-10"), rule("day", 1, SYD), at(SYD, "2026-06-10"));
    const b = nextDueDate(at(NY, "2026-06-10"), rule("day", 1, NY), at(NY, "2026-06-10"));
    expect(wall(a, SYD)).toBe("2026-06-11 00:00");
    expect(wall(b, NY)).toBe("2026-06-11 00:00");
    expect(a).not.toBe(b);
  });

  it("survives a fall-back DST boundary at local midnight", () => {
    // New York falls back on 2026-11-01. Adding 7 * 86_400_000 milliseconds
    // across it lands at 23:00 on the previous calendar day.
    const due = at(NY, "2026-10-28");
    const next = nextDueDate(due, rule("week", 1, NY), at(NY, "2026-10-29"));
    expect(wall(next, NY)).toBe("2026-11-04 00:00");
    expect(next! - due).not.toBe(7 * DAY); // an hour longer, which is the point
  });

  it("survives a spring-forward DST boundary at local midnight", () => {
    // Sydney springs forward on 2026-10-04.
    const due = at(SYD, "2026-09-30");
    const next = nextDueDate(due, rule("week", 1, SYD), at(SYD, "2026-10-01"));
    expect(wall(next, SYD)).toBe("2026-10-07 00:00");
  });

  it("monthly across a DST boundary is still local midnight", () => {
    const next = nextDueDate(at(NY, "2026-10-15"), rule("month", 1, NY, 15), at(NY, "2026-10-20"));
    expect(wall(next, NY)).toBe("2026-11-15 00:00");
  });

  it("normalises a due date that is not at midnight", () => {
    const due = at(SYD, "2026-06-10") + 14 * 3_600_000; // 14:00
    const next = nextDueDate(due, rule("day", 1, SYD), at(SYD, "2026-06-10"));
    expect(wall(next, SYD)).toBe("2026-06-11 00:00");
  });
});

describe("nextDueDate — refuses rather than guesses", () => {
  it.each([
    ["no due date", null, rule("day", 1)],
    ["no rule", at(SYD, "2026-06-10"), null],
    ["interval 0", at(SYD, "2026-06-10"), rule("day", 0)],
    ["interval -1", at(SYD, "2026-06-10"), rule("day", -1)],
    ["interval NaN", at(SYD, "2026-06-10"), rule("day", Number.NaN)],
    ["unknown unit", at(SYD, "2026-06-10"), { unit: "year", interval: 1, anchorDay: null, timeZone: SYD }],
    ["unknown zone", at(SYD, "2026-06-10"), rule("day", 1, "Mars/Olympus_Mons")],
    ["monthly with no anchor", at(SYD, "2026-06-10"), { unit: "month", interval: 1, anchorDay: null, timeZone: SYD }],
  ] as const)("returns null for %s", (_label, due, r) => {
    expect(nextDueDate(due as number | null, r as RepeatRule | null)).toBeNull();
  });

  it("terminates on a base 50 years old instead of spinning", () => {
    const next = nextDueDate(at(SYD, "1976-06-10"), rule("day", 1), at(SYD, "2026-06-10"));
    // 50 years of daily is ~18k advances, past the cap: a corrupt row, not a
    // schedule. The assertion that matters is that it RETURNS.
    expect(next).toBeNull();
  });

  it("but a 50-year-old WEEKLY base is inside the cap and still resolves", () => {
    const next = nextDueDate(at(SYD, "1976-06-07"), rule("week", 1), at(SYD, "2026-06-10"));
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(at(SYD, "2026-06-10"));
  });
});

describe("the small helpers", () => {
  it("repeats() needs both a rule and a due date", () => {
    expect(repeats({ dueDate: at(SYD, "2026-06-10"), repeat: rule("day", 1) })).toBe(true);
    expect(repeats({ dueDate: null, repeat: rule("day", 1) })).toBe(false);
    expect(repeats({ dueDate: at(SYD, "2026-06-10"), repeat: null })).toBe(false);
  });

  it("isRepeatRule fails closed on anything malformed", () => {
    expect(isRepeatRule(rule("day", 1))).toBe(true);
    expect(isRepeatRule(rule("month", 1, SYD, 31))).toBe(true);
    expect(isRepeatRule(null)).toBe(false);
    expect(isRepeatRule({ unit: "day", interval: 1 })).toBe(false); // no timeZone
    expect(isRepeatRule({ unit: "month", interval: 1, anchorDay: null, timeZone: SYD })).toBe(false);
    expect(isRepeatRule({ unit: "day", interval: 1, anchorDay: 5, timeZone: SYD })).toBe(false);
  });

  it("toRepeatRule turns the four columns into one value, or null", () => {
    expect(toRepeatRule("week", 2, null, SYD)).toEqual({
      unit: "week", interval: 2, anchorDay: null, timeZone: SYD,
    });
    expect(toRepeatRule("month", 1, 31, SYD)).toEqual({
      unit: "month", interval: 1, anchorDay: 31, timeZone: SYD,
    });
    expect(toRepeatRule(null, null, null, null)).toBeNull();
    // A half-written row — possible only by hand, since the check constraint
    // forbids it — normalises to "no rule" rather than to a guess.
    expect(toRepeatRule("week", null, null, SYD)).toBeNull();
    expect(toRepeatRule("week", 2, null, null)).toBeNull();
  });

  it("describeRepeat reads as a sentence fragment", () => {
    expect(describeRepeat(null)).toBe("Does not repeat");
    expect(describeRepeat(rule("day", 1))).toBe("Every day");
    expect(describeRepeat(rule("day", 3))).toBe("Every 3 days");
    expect(describeRepeat(rule("week", 1))).toBe("Every week");
    expect(describeRepeat(rule("week", 2))).toBe("Every 2 weeks");
    expect(describeRepeat(rule("month", 1, SYD, 31))).toBe("Every month on the 31st");
    expect(describeRepeat(rule("month", 3, SYD, 1))).toBe("Every 3 months on the 1st");
  });
});

describe("ruleForSave — captured once, then preserved (D8)", () => {
  // Every case here runs as though the browser were in London while the series
  // was defined in Sydney. That is the whole point: somebody editing a task
  // from another country must not move a colleague's series.
  const LONDON = "Europe/London";
  const existing: RepeatRule = { unit: "week", interval: 1, anchorDay: null, timeZone: SYD };

  it("captures the browser's zone when recurrence is switched on", () => {
    const r = ruleForSave({
      previous: null, unit: "week", interval: 1,
      dueDate: at(LONDON, "2026-06-10"), browserZone: LONDON,
    });
    expect(r!.timeZone).toBe(LONDON);
  });

  it("PRESERVES the zone when only the due date changes", () => {
    const r = ruleForSave({
      previous: existing, unit: "week", interval: 1,
      dueDate: at(SYD, "2026-07-20"), browserZone: LONDON,
    });
    expect(r!.timeZone).toBe(SYD);
  });

  it("PRESERVES the zone when only the interval or unit changes", () => {
    const r = ruleForSave({
      previous: existing, unit: "day", interval: 3,
      dueDate: at(SYD, "2026-06-10"), browserZone: LONDON,
    });
    expect(r).toEqual({ unit: "day", interval: 3, anchorDay: null, timeZone: SYD });
  });

  it("captures a NEW zone when recurrence is turned off and on again", () => {
    const off = ruleForSave({
      previous: existing, unit: "never", interval: 1,
      dueDate: at(SYD, "2026-06-10"), browserZone: LONDON,
    });
    expect(off).toBeNull();
    const back = ruleForSave({
      previous: off, unit: "week", interval: 1,
      dueDate: at(LONDON, "2026-06-10"), browserZone: LONDON,
    });
    expect(back!.timeZone).toBe(LONDON);
  });

  it("updates the monthly anchor when the due date changes, reading it in the SERIES' zone", () => {
    const monthly: RepeatRule = { unit: "month", interval: 1, anchorDay: 5, timeZone: SYD };
    const r = ruleForSave({
      previous: monthly, unit: "month", interval: 1,
      dueDate: at(SYD, "2026-08-31"), browserZone: LONDON,
    });
    expect(r).toEqual({ unit: "month", interval: 1, anchorDay: 31, timeZone: SYD });
  });

  it("clears the anchor when a monthly rule becomes weekly", () => {
    const monthly: RepeatRule = { unit: "month", interval: 1, anchorDay: 31, timeZone: SYD };
    const r = ruleForSave({
      previous: monthly, unit: "week", interval: 1,
      dueDate: at(SYD, "2026-08-31"), browserZone: LONDON,
    });
    expect(r!.anchorDay).toBeNull();
  });

  it("drops the rule when the due date is cleared", () => {
    // The database's `tasks_repeat_needs_due_date` is a backstop; this is the
    // write path honouring it rather than hitting it.
    expect(
      ruleForSave({ previous: existing, unit: "week", interval: 1, dueDate: null, browserZone: LONDON })
    ).toBeNull();
  });

  it("and the preserved series still computes the same dates it always did", () => {
    // The point of preserving the zone: after an edit from another country,
    // the series is unchanged, so TS and SQL still agree about it.
    const edited = ruleForSave({
      previous: existing, unit: "week", interval: 1,
      dueDate: at(SYD, "2026-06-01"), browserZone: LONDON,
    })!;
    const next = nextDueDate(at(SYD, "2026-06-01"), edited, at(SYD, "2026-06-22"));
    expect(wall(next, SYD)).toBe("2026-06-29 00:00");
  });

  it("clamps an out-of-range interval to what the database accepts", () => {
    expect(ruleForSave({ previous: null, unit: "day", interval: 0, dueDate: at(SYD, "2026-06-10"), browserZone: SYD })!.interval).toBe(1);
    expect(ruleForSave({ previous: null, unit: "day", interval: 5000, dueDate: at(SYD, "2026-06-10"), browserZone: SYD })!.interval).toBe(999);
  });
});
