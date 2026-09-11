// Who may change whose details, asked of Postgres.
//
// The dialog will only offer the pencil to an admin, and that is worth nothing
// here: any signed-in person can PATCH `profiles` directly. So every claim
// below is made from a client that really is a Member or really is an Admin.
//
// WHAT IS DIFFERENT ABOUT THIS ONE. Most features in this codebase needed a
// policy written for them. This needed none: `profiles_update_self` already
// grants a blanket UPDATE on your own row and `profiles_admin_write` gives a
// `members.manage` holder everyone's, and every trigger on the table is scoped
// to `role_id`, `mfa_required` or `must_change_password`. These tests exist to
// establish that as fact rather than as a reading of the migrations - because
// the whole feature was built on that reading.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  admin: `pw-admin-${stamp}@lumina.test`,
  member: `pw-member-${stamp}@lumina.test`,
  other: `pw-other-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `pwada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo Member", handle: `pwmo${stamp}`, roleId: "member",
  });
  ids.other = await createTestUser({
    email: emails.other, password: TEST_PASSWORD,
    name: "Ora Other", handle: `pwora${stamp}`, roleId: "member",
  });
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

async function profileOf(id: string) {
  const { data } = await serviceClient
    .from("profiles").select("name,handle,title").eq("id", id).maybeSingle();
  return data;
}

describe("your own row", () => {
  it("lets a member change their own name and handle", async () => {
    const them = await signInAs(emails.member, TEST_PASSWORD);

    const { error } = await them
      .from("profiles")
      .update({ name: "Mo Renamed", handle: `pwmo${stamp}x`, title: "Caseworker" })
      .eq("id", ids.member);

    expect(error).toBeNull();
    const row = await profileOf(ids.member);
    expect(row?.name).toBe("Mo Renamed");
    expect(row?.handle).toBe(`pwmo${stamp}x`);
    expect(row?.title).toBe("Caseworker");
  });

  it("REFUSES a handle somebody else already holds", async () => {
    // The rule the store's own check only approximates. This is what stops two
    // people claiming the same handle in the same second.
    const them = await signInAs(emails.member, TEST_PASSWORD);

    const { error } = await them
      .from("profiles").update({ handle: `pwora${stamp}` }).eq("id", ids.member);

    expect(error?.code).toBe("23505");
    // And the rest of the row is untouched - a rejected UPDATE is not a
    // partial one.
    expect((await profileOf(ids.member))?.name).toBe("Mo Renamed");
  });
});

describe("somebody else's row", () => {
  it("REFUSES a member renaming another member", async () => {
    const them = await signInAs(emails.member, TEST_PASSWORD);

    const { error } = await them
      .from("profiles").update({ name: "Hijacked" }).eq("id", ids.other);

    // `profiles_update_self` filters rather than raising, so the absence of
    // the change is the assertion - not the presence of an error.
    expect(error).toBeNull();
    expect((await profileOf(ids.other))?.name).toBe("Ora Other");
  });

  it("CONTROL: an admin renames that same person", async () => {
    // Without this, the refusal above would pass equally against a policy that
    // refused everybody, or a row that could not be written at all.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);

    const { error } = await admin
      .from("profiles").update({ name: "Ora Corrected" }).eq("id", ids.other);

    expect(error).toBeNull();
    expect((await profileOf(ids.other))?.name).toBe("Ora Corrected");
  });
});

describe("what these columns are NOT a way into", () => {
  it("still refuses a member changing their own role through the same update", async () => {
    // `profiles_update_self` is blanket on the row, so the only thing keeping
    // `role_id` out of reach is the `profiles_block_self_role_change` trigger.
    // Editing a name must not become a way to edit a role alongside it.
    const them = await signInAs(emails.member, TEST_PASSWORD);

    const { error } = await them
      .from("profiles")
      .update({ name: "Mo Escalated", role_id: "admin" })
      .eq("id", ids.member);

    expect(error?.code).toBe("P0001");
    const row = await profileOf(ids.member);
    expect(row?.name).toBe("Mo Renamed");
  });
});
