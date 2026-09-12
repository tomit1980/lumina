// The forced first-password-change flag, and the only thing that clears it.
//
// WHY THIS FILE IS THE IMPORTANT HALF OF THE FEATURE. The login screen can be
// made to hold somebody at a "choose your own password" step, and that part is
// easy. What decides whether the requirement means anything is what happens
// when the person skips the screen entirely and talks to the API - which
// anybody can do, because the publishable key is in the bundle and the session
// is theirs.
//
// `profiles_update_self` (20260906000100_identity.sql) lets every member update
// their own row. So the obvious build - browser changes password, browser
// writes the flag false - hands the gated party the key to the gate. The first
// test here is that exact attack, and the rest establish that the flag still
// comes off when it should.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient, createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  /** Has the flag set; tries to get out of it. */
  gated: `mcp-gated-${stamp}@lumina.test`,
  /** Holds members.manage. */
  admin: `mcp-admin-${stamp}@lumina.test`,
  /** Flag never set; the control for "the trigger is not clearing at random". */
  ordinary: `mcp-ordinary-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.gated = await createTestUser({
    email: emails.gated, password: TEST_PASSWORD,
    name: "Gaby Gated", handle: `mcpgaby${stamp}`, roleId: "member",
  });
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `mcpada${stamp}`, roleId: "admin",
  });
  ids.ordinary = await createTestUser({
    email: emails.ordinary, password: TEST_PASSWORD,
    name: "Otto Ordinary", handle: `mcpotto${stamp}`, roleId: "member",
  });

  const { error } = await serviceClient
    .from("profiles").update({ must_change_password: true }).eq("id", ids.gated);
  if (error) throw new Error(`could not set the flag: ${error.message}`);
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

async function flagOf(userId: string): Promise<boolean | null> {
  const { data } = await serviceClient
    .from("profiles").select("must_change_password").eq("id", userId).maybeSingle();
  return data?.must_change_password ?? null;
}

describe("the gated person cannot simply turn it off", () => {
  it("REFUSES them clearing their own flag, and says why", async () => {
    // The attack the whole design exists to stop. They own the row and
    // profiles_update_self lets them write to it, so only the trigger stands
    // between them and skipping the requirement with one call.
    const them = await signInAs(emails.gated, TEST_PASSWORD);

    const { error } = await them
      .from("profiles").update({ must_change_password: false }).eq("id", ids.gated);

    // P0001 is a raise from plpgsql - proving the trigger refused it, not a
    // policy quietly filtering the row to nothing.
    expect(error?.code).toBe("P0001");
    expect(error?.message).toMatch(/password requirement/i);
    expect(await flagOf(ids.gated)).toBe(true);
  });

  it("CONTROL: the same person can still update their own title", async () => {
    // Without this, the refusal above would also pass if profiles_update_self
    // had been dropped, or if the account could not write to its row at all.
    // The trigger has to be refusing this column, not the whole row.
    const them = await signInAs(emails.gated, TEST_PASSWORD);

    const { error } = await them
      .from("profiles").update({ title: "Still editable" }).eq("id", ids.gated);

    expect(error).toBeNull();
  });

  it("REFUSES a different member clearing it for them", async () => {
    const other = await signInAs(emails.ordinary, TEST_PASSWORD);

    await other
      .from("profiles").update({ must_change_password: false }).eq("id", ids.gated);

    // Silently filtered by profiles_update_self rather than raised - a member
    // never reaches somebody else's row at all. Either way the flag holds.
    expect(await flagOf(ids.gated)).toBe(true);
  });
});

describe("what the database does with a password that was never replaced", () => {
  // Placed before the block below on purpose: that one changes the gated
  // account's password, which is the one event that clears the flag. Every
  // assertion here needs the flag still standing.

  it("REFUSES a workspace read, which until 20260912000200 it did not", async () => {
    // The finding this gate was built for. `must_change_password` decided
    // which screen lib/auth.tsx rendered and nothing else, so the person
    // holding the password they were handed — the one credential in the system
    // that is expected to leak, by 20260911000100's own account of it — could
    // skip the screen and read the workspace straight from PostgREST.
    //
    // `statuses` is the table to ask about: every workspace carries the five
    // seeded by 20260910005000 and `statuses_read` is `using (true)`, so the
    // control below is guaranteed a non-empty answer. Asking about `projects`
    // or `tasks` would be green whether the policy existed or not, since this
    // account belongs to neither.
    //
    // Silently, like every restrictive policy: filtered to nothing, not an
    // error. The assertion is about rows, which is why the control matters.
    const them = await signInAs(emails.gated, TEST_PASSWORD);

    const { data, error } = await them.from("statuses").select("id");

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("CONTROL: a member who never had the flag reads the same table fine", async () => {
    // Without this the refusal above would pass just as happily against an
    // empty table, a dropped permissive policy, or a gate that had started
    // refusing the whole workspace rather than half-finished sign-ins.
    const them = await signInAs(emails.ordinary, TEST_PASSWORD);

    const { data, error } = await them.from("statuses").select("id");

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("ALLOWS them their own profile row, because the login screen needs it", async () => {
    // The one carve-out in require_password_change. lib/auth.tsx cannot know
    // it is meant to render the password step without reading the flag, and
    // the flag is on this row. Gate it and the login screen can no longer tell
    // "replace your password" from "this account has no profile", which is a
    // real and differently-handled case.
    const them = await signInAs(emails.gated, TEST_PASSWORD);

    const { data, error } = await them
      .from("profiles").select("id, must_change_password").eq("id", ids.gated).maybeSingle();

    expect(error).toBeNull();
    expect(data?.must_change_password).toBe(true);
  });

  it("REFUSES them anybody else's profile row", async () => {
    // The carve-out is one row, not the table. `profiles_read` is
    // `using (true)`, so the looser version — let a gated session read
    // `profiles` entirely — would hand the workspace directory, every name and
    // handle and email, to that same leaked password. A smaller prize than the
    // workspace, which is exactly why it would have been easy to wave through.
    const them = await signInAs(emails.gated, TEST_PASSWORD);

    const { data, error } = await them.from("profiles").select("id").eq("id", ids.ordinary);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("CONTROL: the unflagged member reads that same profile fine", async () => {
    const them = await signInAs(emails.ordinary, TEST_PASSWORD);

    const { data, error } = await them.from("profiles").select("id").eq("id", ids.gated);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("REFUSES find_or_create_dm, which no policy can reach", async () => {
    // SECURITY DEFINER, so RLS is not consulted for its three inserts and no
    // restrictive policy above applies to them. Without the check inside the
    // function this call would hand a gated session a real DM —
    // `conversations`, `dms` and two `dm_members` rows — built past a gate
    // that was closed.
    //
    // And note the shape: everywhere else here the refusal is a silent filter;
    // this one RAISES, because the check is a line of plpgsql rather than a
    // policy. A test that assumed the silent shape would pass on the error
    // being falsy and prove nothing.
    const them = await signInAs(emails.gated, TEST_PASSWORD);

    const { error } = await them.rpc("find_or_create_dm", { other_user_id: ids.ordinary });

    expect(error?.message ?? "").toContain("Finish signing in");
  });

  it("CONTROL: the unflagged member opens the same kind of DM", async () => {
    // Otherwise the refusal above would pass against a function that refused
    // everybody — a missing permission, a profile it cannot see, a typo in the
    // argument name.
    const them = await signInAs(emails.ordinary, TEST_PASSWORD);

    const { data, error } = await them.rpc("find_or_create_dm", { other_user_id: ids.admin });

    expect(error?.message ?? null).toBeNull();
    expect(data).toBeTruthy();

    // Leave lumina-dev as we found it: `dms` and `dm_members` both cascade
    // from `conversations` (20260906000200:24,29).
    await serviceClient.from("conversations").delete().eq("id", data as string);
  });
});

describe("what actually takes it off", () => {
  it("clears when the password really changes", async () => {
    // The rule stated positively: the flag follows auth.users.encrypted_password
    // and nothing else. This is the path the login screen drives.
    const them = await signInAs(emails.gated, TEST_PASSWORD);

    const { error } = await them.auth.updateUser({ password: "replaced-by-them-42" });
    expect(error).toBeNull();

    expect(await flagOf(ids.gated)).toBe(false);
  });

  it("CONTROL: an unrelated profile write does NOT clear it", async () => {
    // The trigger fires on `update of encrypted_password`. If it were on any
    // update, or if the app were clearing the flag as a side effect of
    // something else, this would come back false and the requirement would be
    // escapable by editing your own name.
    await serviceClient
      .from("profiles").update({ must_change_password: true }).eq("id", ids.gated);
    const them = await signInAs(emails.gated, "replaced-by-them-42");

    await them.from("profiles").update({ title: "Renamed, not re-credentialed" }).eq("id", ids.gated);

    expect(await flagOf(ids.gated)).toBe(true);
  });

  it("CONTROL: someone who was never flagged is untouched throughout", async () => {
    // Guards the other direction: a trigger that set the flag, or cleared it
    // across the table, would show up here.
    expect(await flagOf(ids.ordinary)).toBe(false);
  });
});

describe("who may impose it", () => {
  it("lets an admin set it on somebody else", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);

    const { error } = await admin
      .from("profiles").update({ must_change_password: true }).eq("id", ids.ordinary);

    expect(error).toBeNull();
    expect(await flagOf(ids.ordinary)).toBe(true);
  });
});
