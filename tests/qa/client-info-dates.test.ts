// Day-first dates, which is a decision rather than a detection.
//
// `<input type="date">` renders in the VIEWER'S operating-system locale and
// cannot be told otherwise — no attribute, no CSS. So the same date of birth
// read day-first in Melbourne and month-first on a US-configured laptop, and
// nothing on screen said which you were looking at. For a pension case where
// the date of birth is identifying information, that is not cosmetic.
//
// Replacing it with a typed DD/MM/YYYY box makes the format ours, and makes
// "02/03/1968" mean 2 March everywhere, always. That string is the whole reason
// the native picker was chosen in the first place — see the migration's note and
// the RLS test named "ACCEPTS '02/03/1968' AND READS IT MONTH-FIRST". The rule
// has not become laxer; it has become explicit and is asserted here.
//
// NO `Date` IS CONSTRUCTED FROM A STRING anywhere below the surface. `new
// Date("1968-03-02")` is UTC midnight rendered in the reader's zone, which is
// how a birthday becomes the previous day west of Greenwich. Calendar validity
// uses `Date.UTC` on NUMBERS, which is deterministic.
import { describe, expect, it } from "vitest";

import { formatDayFirst, isIsoDate, parseDayFirst } from "@/lib/client-info";

describe("reading a typed date", () => {
  it("READS 02/03/1968 AS 2 MARCH, never 3 February", () => {
    // The assertion this whole change exists to make true.
    expect(parseDayFirst("02/03/1968")).toBe("1968-03-02");
  });

  it("takes a day and month without leading zeros", () => {
    expect(parseDayFirst("5/3/1968")).toBe("1968-03-05");
  });

  it("takes dashes and dots as well as slashes", () => {
    expect(parseDayFirst("15-03-1968")).toBe("1968-03-15");
    expect(parseDayFirst("15.03.1968")).toBe("1968-03-15");
  });

  it("ignores surrounding space", () => {
    expect(parseDayFirst("  15/03/1968  ")).toBe("1968-03-15");
  });

  it("accepts the 29th of February in a leap year", () => {
    expect(parseDayFirst("29/02/1968")).toBe("1968-02-29");
  });
});

describe("what it refuses", () => {
  // Each of these would otherwise be stored as a real but WRONG date, which is
  // worse than a refusal: nothing downstream could tell it was a guess.
  const refused = [
    ["31/02/1968", "a day that month does not have"],
    ["29/02/1969", "the 29th of February in a common year"],
    ["15/13/1968", "a thirteenth month"],
    ["15/03/68", "a two-digit year, which would have to be guessed at"],
    ["1968-03-15", "an ISO string, which is day-last and not what this box asks for"],
    ["03/1968", "a missing component"],
    ["abc", "text"],
    ["", "nothing"],
  ] as const;

  for (const [input, why] of refused) {
    it(`refuses ${JSON.stringify(input)} — ${why}`, () => {
      expect(parseDayFirst(input)).toBeNull();
    });
  }

  it("CONTROL: a well-formed date is still accepted", () => {
    // Without this the refusals above would pass just as well against a
    // function that returned null for everything.
    expect(parseDayFirst("15/03/1968")).toBe("1968-03-15");
  });
});

describe("showing a stored date", () => {
  it("writes it day-first, zero-padded", () => {
    expect(formatDayFirst("1968-03-05")).toBe("05/03/1968");
  });

  it("shows nothing for a date nobody has recorded", () => {
    expect(formatDayFirst(null)).toBe("");
  });

  it("round-trips every date it accepts", () => {
    for (const typed of ["15/03/1968", "02/03/1968", "29/02/1968", "31/12/2025"]) {
      expect(formatDayFirst(parseDayFirst(typed))).toBe(typed);
    }
  });
});

describe("the column's own rule", () => {
  it("REFUSES the 31st of February, which the old check allowed", () => {
    // `isIsoDate` bounded the day at 1..31 without regard to the month, so a
    // value the `date` column would reject could reach it. The store is the
    // last gate before Postgres and should not be looser than the column.
    expect(isIsoDate("1968-02-31")).toBe(false);
  });

  it("CONTROL: a real leap day is still allowed", () => {
    expect(isIsoDate("1968-02-29")).toBe(true);
  });

  it("CONTROL: an ordinary date is still allowed", () => {
    expect(isIsoDate("1968-03-15")).toBe(true);
  });
});
