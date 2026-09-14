// What the two-factor menu offers, as a decision rather than a rendering.
//
// WHY THIS IS A PURE FUNCTION. The rule here is a two-by-two: enrolled or not,
// required or not, on your row or somebody else's. Asserting it by opening a
// Radix dropdown costs seconds per case in jsdom and the cost compounds within
// a file — the first version of this coverage took 165s for seven cases, and
// the 50s it still cost after trimming was enough to tip the CI reporter into
// "Timeout calling onTaskUpdate" and fail a build in which all 883 tests
// passed. Slow tests are not merely slow; past a threshold they are flaky.
//
// So the decision lives in lib/two-factor.ts and is asserted here in
// milliseconds, and ONE rendered case in ./members-two-factor-menu.test.ts
// proves the component actually renders what this returns. Neither file is
// sufficient alone: this one cannot tell whether anything is on screen, and
// that one cannot afford the combinations.
import { describe, expect, it } from "vitest";

import { twoFactorMenu } from "@/lib/two-factor";

describe("somebody else's row", () => {
  it("never offers to reset or disable an authenticator it cannot touch", () => {
    // Unenrolling somebody else is an `auth.admin` call needing the secret
    // key. Before enrolment was knowable these were hidden by accident —
    // `enrolled` was only ever true for yourself — and making the badge
    // truthful would have surfaced two buttons that quietly do nothing.
    const menu = twoFactorMenu({ status: "enrolled", required: true, isSelf: false });

    expect(menu.items).not.toContain("reset");
    expect(menu.items).not.toContain("disable");
  });

  it("says where a lost authenticator is actually removed", () => {
    const menu = twoFactorMenu({ status: "enrolled", required: true, isSelf: false });

    expect(menu.notes).toContain("removed-in-dashboard");
  });

  it("keeps the requirement cancellable for somebody who HAS enrolled", () => {
    // The regression a single-status menu would have introduced: this item
    // lived in the `pending` branch and vanished the moment they enrolled.
    const menu = twoFactorMenu({ status: "enrolled", required: true, isSelf: false });

    expect(menu.items).toContain("cancel-requirement");
    expect(menu.items).not.toContain("require");
  });

  it("offers Require to an enrolled person nobody has required it of", () => {
    const menu = twoFactorMenu({ status: "enrolled", required: false, isSelf: false });

    expect(menu.items).toContain("require");
    expect(menu.items).not.toContain("cancel-requirement");
  });
});

describe("your own row", () => {
  it("offers reset and disable, which are self-service and do work", () => {
    const menu = twoFactorMenu({ status: "enrolled", required: true, isSelf: true });

    expect(menu.items).toContain("reset");
    expect(menu.items).toContain("disable");
  });

  it("does not send you to the dashboard for a factor you can drop here", () => {
    const menu = twoFactorMenu({ status: "enrolled", required: true, isSelf: true });

    expect(menu.notes).not.toContain("removed-in-dashboard");
  });
});

describe("the requirement is independent of enrolment", () => {
  // The whole point of splitting the two inputs, asserted as a table so a
  // future edit that re-collapses them fails here rather than on a screen.
  const cases = [
    { required: false, expected: "require" },
    { required: true, expected: "cancel-requirement" },
  ] as const;

  for (const status of ["off", "pending", "enrolled"] as const) {
    for (const { required, expected } of cases) {
      // `off` and `pending` are defined by the requirement flag, so only the
      // combinations that can actually occur are asserted.
      if (status === "off" && required) continue;
      if (status === "pending" && !required) continue;

      it(`offers ${expected} when status is ${status} and required is ${required}`, () => {
        expect(twoFactorMenu({ status, required, isSelf: false }).items).toContain(
          expected
        );
      });
    }
  }
});

describe("what it says about them", () => {
  it("notes enrolment when they have an authenticator", () => {
    expect(
      twoFactorMenu({ status: "enrolled", required: false, isSelf: false }).notes
    ).toContain("enrolled");
  });

  it("notes the pending requirement when they do not", () => {
    expect(
      twoFactorMenu({ status: "pending", required: true, isSelf: false }).notes
    ).toContain("awaiting-enrolment");
  });

  it("says nothing extra when two-factor is simply off", () => {
    expect(twoFactorMenu({ status: "off", required: false, isSelf: false }).notes)
      .toEqual([]);
  });
});
