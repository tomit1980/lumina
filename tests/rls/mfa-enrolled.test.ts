// `mfa_enrolled_ids()` — who the members list may be told has an authenticator.
//
// WHY THIS FUNCTION EXISTS. `auth.mfa_factors` is not readable by the
// `authenticated` role, and listing somebody else's factors is an `auth.admin`
// call needing the secret key, which must never be in a browser bundle. So the
// Members screen could only ever report the requirement flag, and said "2FA
// pending" about people who had enrolled months earlier.
//
// WHAT IT MAY NOT BECOME. One bit per person, to the people who already manage
// their accounts. Never a factor, never a secret, never a timestamp, and never
// to somebody without `members.manage`. The checks below are aimed at those
// four boundaries rather than at the happy path, which the app exercises on
// every sign-in anyway.
//
// THE FIXTURE IS THE HARD PART, and it is borrowed from ./forced-enrolment.ts:
// a genuinely verified factor needs a real RFC-6238 code, computed from the
// secret Supabase hands back, by the same arithmetic an authenticator app does.
// Nothing here fakes a factor row — a fake one would not prove the function
// reads the real table.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  anonClient, createTestUser, deleteTestUser, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";
import { totpNow } from "@/lib/totp";

const stamp = Date.now();
const emails = {
  /** An admin: holds `members.manage`, so the function answers them. */
  admin: `mfaids-admin-${stamp}@lumina.test`,
  /** Enrols a real authenticator. The person the answer is ABOUT. */
  enrolled: `mfaids-enrolled-${stamp}@lumina.test`,
  /** Never enrols. The control that the function reports enrolment rather
   *  than simply listing the workspace. */
  bare: `mfaids-bare-${stamp}@lumina.test`,
  /** An ordinary member: no `members.manage`, so the function refuses them. */
  member: `mfaids-member-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

/** The enrolled user's own session, kept so the suite spends one sign-in on
 *  it rather than one per test — the project rate-limits sign-ins. */
let enrolledSession: SupabaseClient | null = null;

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "MFA Admin", handle: `mfaidsadmin${stamp}`, roleId: "admin",
  });
  ids.enrolled = await createTestUser({
    email: emails.enrolled, password: TEST_PASSWORD,
    name: "MFA Enrolled", handle: `mfaidsenrolled${stamp}`, roleId: "member",
  });
  ids.bare = await createTestUser({
    email: emails.bare, password: TEST_PASSWORD,
    name: "MFA Bare", handle: `mfaidsbare${stamp}`, roleId: "member",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "MFA Member", handle: `mfaidsmember${stamp}`, roleId: "member",
  });

  // A real factor, verified with a real code.
  enrolledSession = await signInAs(emails.enrolled, TEST_PASSWORD);
  const { data: enrol, error: enrolErr } = await enrolledSession.auth.mfa.enroll({
    factorType: "totp",
  });
  expect(
    enrolErr,
    `TOTP enrolment was refused by the project: ${enrolErr?.message ?? ""}. ` +
      "Turn it on under Authentication -> Multi-Factor Authentication."
  ).toBeNull();

  const { data: challenge } = await enrolledSession.auth.mfa.challenge({
    factorId: enrol!.id,
  });
  const { error: verifyErr } = await enrolledSession.auth.mfa.verify({
    factorId: enrol!.id,
    challengeId: challenge!.id,
    code: await totpNow(enrol!.totp.secret),
  });
  expect(verifyErr, `verify failed: ${verifyErr?.message ?? ""}`).toBeNull();
}, 60_000);

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

/** The ids a caller is told about, as a plain array. */
async function askAs(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.rpc("mfa_enrolled_ids");
  expect(error).toBeNull();
  return (data ?? []).map((row: { user_id: string }) => row.user_id);
}

describe("who the function answers", () => {
  it("names somebody who really has a verified factor, to an admin", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    expect(await askAs(admin)).toContain(ids.enrolled);
  });

  it("CONTROL: and does NOT name a user who never enrolled", async () => {
    // Without this, the check above would pass just as well against a function
    // that returned every profile in the workspace — which is the difference
    // between reporting enrolment and reporting membership.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    expect(await askAs(admin)).not.toContain(ids.bare);
  });

  it("REFUSES an ordinary member, who may not manage anybody", async () => {
    const member = await signInAs(emails.member, TEST_PASSWORD);
    expect(await askAs(member)).toHaveLength(0);
  });

  it("CONTROL: that same member can still read the directory", async () => {
    // So the empty answer above is the function refusing, and not a broken
    // session or a sign-in that silently failed.
    const member = await signInAs(emails.member, TEST_PASSWORD);
    const { data, error } = await member.from("profiles").select("id");
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("REFUSES a signed-out caller at the door, not inside the body", async () => {
    // `revoke all ... from public` does NOT cover `anon` — Supabase grants
    // EXECUTE to that role by name. The message matters: "permission denied
    // for function" means the door; anything else means anon entered the body
    // and was turned back by a line that a later edit could move.
    const { error } = await anonClient().rpc("mfa_enrolled_ids");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied for function/i);
  });
});

describe("what it gives away", () => {
  it("returns ids and nothing else — no factor, no secret, no timestamp", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { data } = await admin.rpc("mfa_enrolled_ids");
    const row = (data ?? []).find(
      (r: { user_id: string }) => r.user_id === ids.enrolled
    );
    expect(row).toBeTruthy();
    expect(Object.keys(row!)).toEqual(["user_id"]);
  });

  it("gives a signed-in session no route to the factor table itself", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    // The function is the only way in; the table stays unreachable over the API.
    const { data, error } = await (admin as unknown as SupabaseClient)
      .schema("auth")
      .from("mfa_factors")
      .select("*");
    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();
  });
});
