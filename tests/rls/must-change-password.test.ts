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
