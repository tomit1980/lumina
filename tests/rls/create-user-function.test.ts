// The create-user Edge Function, driven as a real caller against the deployed
// function — not mocked, not through the UI.
//
// WHY THAT DISTINCTION IS THE WHOLE POINT. The Members screen only shows the
// "Add teammate" button to someone holding `members.manage`, but anyone can
// POST to this endpoint with any token they have. A function that trusts its
// caller because the interface only offered the button to admins is a UI-only
// permission check wearing a server costume, and it holds the service-role
// key — which bypasses every policy in the database.
//
// So every rule is asserted from a client that really is a Member, or really
// is an Admin, or really has no token at all. `signInAs` returns a client
// whose `functions.invoke` attaches that session's bearer token itself, which
// is exactly what the function authorises against.
//
// The control here asserts the whole thing rather than the shape of it: the
// account is created, the profile lands on the role that was asked for, and
// the new person can actually sign in with the password they were given.
// (The earlier email-invitation version of this function could not assert
// that — delivery depended on Supabase's shared mail service and its
// free-tier cap of a few messages an hour, which the first run hit. Creating
// the account outright removed that dependency, and with it the excuse for a
// control that only checked authorization had passed.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient, createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  owner: `add-owner-${stamp}@lumina.test`,
  admin: `add-admin-${stamp}@lumina.test`,
  member: `add-member-${stamp}@lumina.test`,
};
/** Addresses this file creates through the function; all get cleaned up. */
const added = {
  byOwner: `added-by-owner-${stamp}@lumina.test`,
  byAdmin: `added-by-admin-${stamp}@lumina.test`,
  refused: `added-refused-${stamp}@lumina.test`,
};
/** The password an admin picks for someone else. Long enough to be accepted. */
const CHOSEN_PASSWORD = "chosen-password-4c1d";
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ola Owner", handle: `addola${stamp}`, roleId: "owner",
  });
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `addada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo Member", handle: `addmo${stamp}`, roleId: "member",
  });
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
  // Anyone the function actually created.
  const { data } = await serviceClient.auth.admin.listUsers({ perPage: 200 });
  for (const u of data?.users ?? []) {
    if (u.email && Object.values(added).includes(u.email)) {
      await serviceClient.auth.admin.deleteUser(u.id);
    }
  }
});

/** The function's own reply, whether it arrived as a 2xx body or an error. */
async function create(
  client: Awaited<ReturnType<typeof signInAs>>,
  email: string,
  roleId: string,
  password: string = CHOSEN_PASSWORD
): Promise<{ status: number; message: string; userId?: string }> {
  const { data, error } = await client.functions.invoke<{ userId?: string; error?: string }>(
    "create-user",
    { body: { email, password, roleId } }
  );
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let message = error.message;
    const status = ctx?.status ?? 0;
    try {
      const body = (await ctx?.json()) as { error?: string } | undefined;
      if (body?.error) message = body.error;
    } catch {
      // Not JSON — keep the transport message.
    }
    return { status, message };
  }
  if (data?.error) return { status: 200, message: data.error };
  return { status: 200, message: "", userId: data?.userId };
}

describe("who the function will act for", () => {
  it("REFUSES a member — the UI never offers this, and that is not the reason", async () => {
    const member = await signInAs(emails.member, TEST_PASSWORD);
    const result = await create(member, added.refused, "member");

    expect(result.status).toBe(403);
    expect(result.message).toMatch(/can't add people/i);
    expect(await userExists(added.refused)).toBe(false);
  });

  it("REFUSES a caller with no token at all", async () => {
    const { data, error } = await anonClient().functions.invoke("create-user", {
      body: { email: added.refused, password: CHOSEN_PASSWORD, roleId: "member" },
    });
    // Either the gateway rejects it or the function does; both are refusals,
    // and what matters is that no account appears.
    expect(error ?? (data as { error?: string })?.error).toBeTruthy();
    expect(await userExists(added.refused)).toBe(false);
  });
});

describe("the rank rule, before the account exists", () => {
  it("REFUSES an admin creating an Owner", async () => {
    // The escalation this exists to stop: an admin cannot mint an Owner by
    // editing a profile, and must not be able to create one either. Refusing
    // BEFORE the account is made means no half-created user is left behind
    // for someone to find and promote later.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const result = await create(admin, added.refused, "owner");

    expect(result.status).toBe(403);
    expect(result.message).toMatch(/as Owner/i);
    expect(await userExists(added.refused)).toBe(false);
  });

  it("CONTROL: an admin creating a Member at their own level succeeds", async () => {
    // The mirror of the negative above, and the proof that the refusals are
    // about rank rather than about admins. Without it, a function that
    // refused everybody would pass every negative here while being broken.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const result = await create(admin, added.byAdmin, "member");

    expect(result.status).toBe(200);
    expect(result.userId).toBeTruthy();
    expect(await roleOf(added.byAdmin)).toBe("member");
  });
});

describe("what a weak request gets", () => {
  it("REFUSES a password shorter than eight characters", async () => {
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const result = await create(owner, added.refused, "member", "short");

    expect(result.status).toBe(400);
    expect(result.message).toMatch(/8 characters/i);
    expect(await userExists(added.refused)).toBe(false);
  });

  it("REFUSES a second account on an address already in the workspace", async () => {
    // Created by the admin control above. Supabase's own error here is
    // unhelpful; the function turns it into a sentence and a 409.
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const result = await create(owner, added.byAdmin, "member");

    expect(result.status).toBe(409);
    expect(result.message).toMatch(/already in the workspace/i);
  });
});

describe("the account that comes out", () => {
  it("lands on the role that was asked for, not the trigger's default", async () => {
    // `handle_new_user` creates every profile as a Member. If the function
    // stopped at createUser, "add them as Admin" would silently produce a
    // Member — invisible until they could not do something, and looking for
    // all the world like a permissions bug.
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const result = await create(owner, added.byOwner, "admin");

    expect(result.status).toBe(200);
    expect(await roleOf(added.byOwner)).toBe("admin");
  });

  it("must replace the password it was given", async () => {
    // The admin typed that password and read it out, so it is a delivery
    // mechanism rather than a credential. The function sets the flag; only a
    // real password change clears it (users_clear_password_flag), and
    // tests/rls/must-change-password.test.ts is where that half is proved.
    const { data } = await serviceClient
      .from("profiles").select("must_change_password").eq("email", added.byOwner).maybeSingle();

    expect(data?.must_change_password).toBe(true);
  });

  it("can sign in immediately with the password that was chosen", async () => {
    // The reason `email_confirm: true` is passed. An unconfirmed account
    // exists, shows up in the dashboard, and cannot sign in — the exact trap
    // docs/runbooks/creating-a-user.md warns about. Asserting the sign-in is
    // the only way to tell the two apart from outside.
    const { data, error } = await anonClient().auth.signInWithPassword({
      email: added.byOwner,
      password: CHOSEN_PASSWORD,
    });

    expect(error).toBeNull();
    expect(data.user?.email).toBe(added.byOwner);
  });

  it("CONTROL: the wrong password does NOT sign in", async () => {
    // Without this, a sign-in that accepted anything would pass the check
    // above. It proves the previous test asserted the password and not just
    // the existence of the account.
    const { data, error } = await anonClient().auth.signInWithPassword({
      email: added.byOwner,
      password: `${CHOSEN_PASSWORD}-wrong`,
    });

    expect(error).toBeTruthy();
    expect(data.user).toBeNull();
  });
});

async function userExists(email: string): Promise<boolean> {
  const { data } = await serviceClient.auth.admin.listUsers({ perPage: 200 });
  return (data?.users ?? []).some((u) => u.email === email);
}

async function roleOf(email: string): Promise<string | null> {
  const { data } = await serviceClient
    .from("profiles").select("role_id").eq("email", email).maybeSingle();
  return data?.role_id ?? null;
}
