// Forced two-factor enrolment, driven against a real Supabase project.
//
// WHY THIS FILE EXISTS. The forced-enrolment flow is covered by
// tests/qa/auth-supabase.test.ts, which drives tests/qa/_fake-supabase.ts. The
// fake answers `enroll` because it was written to. A real project answers it
// only if TOTP enrolment is switched on in its Auth settings - and that switch
// is the difference between a working feature and a permanent lockout:
//
//   `startEnrollment` returns null, `login()` signs them out, and it does that
//   on every attempt. The locked-out person cannot clear their own requirement
//   (`guard_mfa_required` forbids it), so only an admin can rescue them.
//
// Nothing in this codebase could answer "is that switch on" before this file.
// Step 2 below is the answer, re-asked on every run.
//
// THE ORDER MATTERS, AND IS NOT THE OBVIOUS ONE. `session_is_assured()`
// (20260910004000_require_assurance.sql) reads:
//
//   aal = 'aal2'  OR  no verified factor exists for this user
//
// So a user who is *required* but has not yet enrolled is assured, and reads
// the database perfectly well. The refusal this file exists to observe appears
// only once a factor is verified AND a fresh password-only session is opened.
// An earlier draft asserted it one step too early, where it would have passed
// for the wrong reason.
//
// AND THE REFUSAL IS SILENT. `require_assurance` is a RESTRICTIVE policy, so an
// unassured SELECT is filtered to nothing rather than erroring. The assertion
// is therefore about rows returned, never about an error - which is exactly why
// it needs the controls in the last describe block to mean anything.
//
// NOTE FOR WHOEVER DELETES THE DEMO. This file imports `totpNow` from
// lib/totp.ts, whose header says it retires with the demo at cutover. It now
// has a second consumer that has nothing to do with the demo. Deleting that
// module takes this suite with it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  anonClient, createTestUser, deleteTestUser, serviceClient, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";
import { totpNow } from "@/lib/totp";

const stamp = Date.now();
const emails = {
  /** Required to enrol; walks the whole flow. */
  required: `mfa-required-${stamp}@lumina.test`,
  /** Required of nothing; the control that the refusals are not universal. */
  ordinary: `mfa-ordinary-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

/** The aal2 session from step 3, kept for the control in the last block. */
let assured: SupabaseClient | null = null;
/** A verified factor's id, so the aal1 session can be built against it. */
let factorId = "";
/** The enrolment secret, for generating codes. */
let secret = "";

beforeAll(async () => {
  await seedRoles();
  ids.required = await createTestUser({
    email: emails.required, password: TEST_PASSWORD,
    name: "Rhea Required", handle: `mfarhea${stamp}`, roleId: "member",
  });
  ids.ordinary = await createTestUser({
    email: emails.ordinary, password: TEST_PASSWORD,
    name: "Otto Ordinary", handle: `mfaotto${stamp}`, roleId: "member",
  });

  // The admin half of "Require two-factor", done with the service role so the
  // test does not depend on a second signed-in admin. The guard trigger has an
  // explicit service_role carve-out for exactly this.
  const { error } = await serviceClient
    .from("profiles").update({ mfa_required: true }).eq("id", ids.required);
  if (error) throw new Error(`could not require two-factor: ${error.message}`);
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("the flow an admin arms when they require two-factor", () => {
  it("1. signs in on password alone, and the session is aal1", async () => {
    // Supabase issues a real token before any second factor. This is the
    // session `lib/auth.tsx` deliberately withholds from React (`gated`), and
    // the reason it must: it is accepted by PostgREST.
    const client = anonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: emails.required, password: TEST_PASSWORD,
    });

    expect(error).toBeNull();
    expect(data.session).toBeTruthy();

    const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal?.currentLevel).toBe("aal1");

    assured = client;
  });

  it("2. can enrol a TOTP factor - which is what proves the project allows it", async () => {
    // THE ASSERTION THIS FILE WAS WRITTEN FOR. If TOTP enrolment is disabled in
    // the project's Auth settings this fails, and its message is the answer:
    // requiring two-factor of anybody on this project would lock them out.
    const { data, error } = await assured!.auth.mfa.enroll({ factorType: "totp" });

    expect(
      error,
      `TOTP enrolment was refused by the project: ${error?.message ?? ""}. ` +
        "Turn it on under Authentication -> Multi-Factor Authentication, or " +
        "requiring two-factor of anyone will lock them out."
    ).toBeNull();
    expect(data?.totp.secret).toBeTruthy();

    factorId = data!.id;
    secret = data!.totp.secret;
  });

  it("3. verifies a real code and reaches aal2", async () => {
    // A genuine RFC-6238 code from the secret Supabase just handed over - the
    // same arithmetic an authenticator app does, already pinned against the
    // RFC's own vectors in tests/qa/totp.test.ts.
    const { data: ch, error: chErr } = await assured!.auth.mfa.challenge({ factorId });
    expect(chErr).toBeNull();

    const { error: vErr } = await assured!.auth.mfa.verify({
      factorId, challengeId: ch!.id, code: await totpNow(secret),
    });
    expect(vErr, `verify failed: ${vErr?.message ?? ""}`).toBeNull();

    const { data: aal } = await assured!.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal?.currentLevel).toBe("aal2");
  });

  it("4. CONTROL: a wrong code does not verify", async () => {
    // Without this, step 3 would pass just as happily against a verify that
    // accepted anything - proving the round trip and nothing about the code.
    const { data: ch } = await assured!.auth.mfa.challenge({ factorId });
    const { error } = await assured!.auth.mfa.verify({
      factorId, challengeId: ch!.id, code: "000000",
    });

    expect(error).toBeTruthy();
  });
});

describe("what the database does with a half-finished sign-in", () => {
  it("REFUSES an aal1 session once a verified factor exists", async () => {
    // The whole point of require_assurance. Password alone now yields a session
    // that Postgres will not act on: `session_is_assured()` is false, the
    // restrictive policy is ANDed onto every permissive one, and the rows
    // simply are not there.
    //
    // Silently - a restrictive policy filters, it does not error. That is why
    // this asserts a count and why the next test exists.
    const client = anonClient();
    const { error: signInError } = await client.auth.signInWithPassword({
      email: emails.required, password: TEST_PASSWORD,
    });
    expect(signInError).toBeNull();

    const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal?.currentLevel).toBe("aal1");
    expect(aal?.nextLevel).toBe("aal2");

    const { data, error } = await client.from("profiles").select("id");

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("CONTROL: the aal2 session reads the same table fine", async () => {
    // Same query, same account, same moment - only the assurance level differs.
    // Without this, a dropped policy or an empty table would pass the refusal
    // above while proving nothing at all.
    const { data, error } = await assured!.from("profiles").select("id");

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("CONTROL: an account with no factor at all reads it fine on password alone", async () => {
    // The other direction. `session_is_assured()` is true for somebody with no
    // verified factor, which is almost everyone - so the rule must not be
    // refusing aal1 as such. If this ever goes red, the policy has started
    // locking out the whole workspace rather than half-finished sign-ins.
    const client = anonClient();
    const { error: signInError } = await client.auth.signInWithPassword({
      email: emails.ordinary, password: TEST_PASSWORD,
    });
    expect(signInError).toBeNull();

    const { data, error } = await client.from("profiles").select("id");

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});
