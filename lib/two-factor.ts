/**
 * What the two-factor menu on the Members screen offers, as a decision.
 *
 * Pure and free of React on purpose. The rule is a two-by-two — enrolled or
 * not, required or not, your row or somebody else's — and asserting it by
 * opening a Radix dropdown costs seconds per case in jsdom. That is not merely
 * slow: a version of this coverage that opened seven menus took 165 seconds and
 * was enough to tip CI's reporter into a timeout and fail a build in which
 * every test had passed.
 *
 * So the combinations are asserted against this function in
 * tests/qa/two-factor-menu.test.ts, and one rendered case in
 * tests/qa/members-two-factor-menu.test.ts proves the component renders what it
 * returns.
 */
import type { TwoFactorStatus } from "./auth";

/** An action the menu can offer. */
export type TwoFactorMenuItem =
  | "require"
  | "cancel-requirement"
  | "reset"
  | "disable";

/** A statement the menu can make, which is not an action. */
export type TwoFactorMenuNote =
  | "enrolled"
  | "awaiting-enrolment"
  | "removed-in-dashboard";

export interface TwoFactorMenu {
  items: TwoFactorMenuItem[];
  notes: TwoFactorMenuNote[];
}

/**
 * `required` and `status` are separate inputs, and that is the whole point.
 *
 * They used to be one. Every item hung off the three-state badge, and
 * `enrolled` was only ever true for the signed-in user — so the enrolment
 * actions were absent from other people's rows by accident rather than by rule.
 * Once `mfa_enrolled_ids()` made enrolment knowable, collapsing them again
 * would do two wrong things at once: offer Reset and Disable where they cannot
 * work, and withdraw Cancel requirement from anybody who had enrolled.
 */
export function twoFactorMenu({
  status,
  required,
  isSelf,
}: {
  status: TwoFactorStatus;
  /** Is two-factor required of them, whether or not they have enrolled? */
  required: boolean;
  /** Is this the signed-in user's own row? Unenrolling anybody else is an
   *  `auth.admin` call the publishable key cannot make. */
  isSelf: boolean;
}): TwoFactorMenu {
  const notes: TwoFactorMenuNote[] = [];
  if (status === "enrolled") notes.push("enrolled");
  if (status === "pending") notes.push("awaiting-enrolment");

  // The requirement, which an admin can always change — including for somebody
  // who has already set an authenticator up.
  const items: TwoFactorMenuItem[] = [required ? "cancel-requirement" : "require"];

  // The authenticator itself. Self-service only.
  if (status === "enrolled") {
    if (isSelf) items.push("reset", "disable");
    else notes.push("removed-in-dashboard");
  }

  return { items, notes };
}
