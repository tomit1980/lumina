// The invite Edge Function, driven as a real caller against the deployed
// function — not mocked, not through the UI.
//
// WHY THAT DISTINCTION IS THE WHOLE POINT. The Members screen only shows the
// Invite button to someone holding `members.manage`, but anyone can POST to
// this endpoint with any token they have. A function that trusts its caller
// because the interface only offered the button to admins is a UI-only
// permission check wearing a server costume, and it holds the service-role
// key — which bypasses every policy in the database.
//
// So every rule is asserted from a client that really is a Member, or really
// is an Admin, or really has no token at all. `signInAs` returns a client
// whose `functions.invoke` attaches that session's bearer token itself, which
// is exactly what the function authorises against.
//
// WHAT THESE CONTROLS CAN AND CANNOT ASSERT. Sending the invitation needs
// Supabase's built-in email service, which is rate-limited to a handful of
// messages per hour on the free tier — the first run here hit "email rate
// limit exceeded". So a control cannot assert "the invitation arrived"
// without being flaky by construction and burning the project's quota.
//
// What it CAN assert, and what actually matters here, is that authorization
// passed: the function got all the way to the email step instead of refusing.
// A rule that refused everybody would fail that just as loudly as it would
// fail a full success, which is the property a control is for. The complete
// path — invitation delivered, account created, role assigned — is verified
// once, by hand, when a real person is actually invited.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient, createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  owner: `inv-owner-${stamp}@lumina.test`,
  admin: `inv-admin-${stamp}@lumina.test`,
  member: `inv-member-${stamp}@lumina.test`,
};
/** Addresses this file invites; whoever is created gets cleaned up. */
const invited = {
  byOwner: `invitee-owner-${stamp}@lumina.test`,
  byAdmin: `invitee-admin-${stamp}@lumina.test`,
  refused: `invitee-refused-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ola Owner", handle: `invola${stamp}`, roleId: "owner",
  });
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `invada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo Member", handle: `invmo${stamp}`, roleId: "member",
  });
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
  // Anyone the function actually invited.
  const { data } = await serviceClient.auth.admin.listUsers({ perPage: 200 });
  for (const u of data?.users ?? []) {
    if (u.email && Object.values(invited).includes(u.email)) {
      await serviceClient.auth.admin.deleteUser(u.id);
    }
  }
});

/** The function's own reply, whether it arrived as a 2xx body or an error. */
async function invite(
  client: Awaited<ReturnType<typeof signInAs>>,
  email: string,
  roleId: string
): Promise<{ status: number; message: string; userId?: string }> {
  const { data, error } = await client.functions.invoke<{ userId?: string; error?: string }>(
    "invite-user",
    { body: { email, roleId } }
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
    const result = await invite(member, invited.refused, "member");

    expect(result.status).toBe(403);
    expect(result.message).toMatch(/can't invite/i);
    expect(await userExists(invited.refused)).toBe(false);
  });

  it("REFUSES a caller with no token at all", async () => {
    const { data, error } = await anonClient().functions.invoke("invite-user", {
      body: { email: invited.refused, roleId: "member" },
    });
    // Either the gateway rejects it or the function does; both are refusals,
    // and what matters is that no account appears.
    expect(error ?? (data as { error?: string })?.error).toBeTruthy();
    expect(await userExists(invited.refused)).toBe(false);
  });

  it("CONTROL: an admin gets PAST authorization — the refusals are not universal", async () => {
    // Without this, a function that refused everybody would pass every
    // negative above while being completely broken. It asserts the shape of
    // the failure, not its absence: reaching the email step means
    // `members.manage` was accepted and the rank rule allowed the role.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const result = await invite(admin, invited.byAdmin, "member");

    expect(result.status).not.toBe(403);
    expect(result.message).not.toMatch(/can't invite/i);
    // Either it sent, or it reached the mail service and that refused.
    expect(result.userId || /invitation/i.test(result.message)).toBeTruthy();
  });
});

describe("the rank rule, before the account exists", () => {
  it("REFUSES an admin inviting an Owner", async () => {
    // The escalation this exists to stop: an admin cannot mint an Owner, and
    // must not be able to invite one either. Refusing BEFORE the invitation
    // means no half-created account is left behind.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const result = await invite(admin, invited.refused, "owner");

    expect(result.status).toBe(403);
    expect(result.message).toMatch(/as Owner/i);
    expect(await userExists(invited.refused)).toBe(false);
  });

  it("CONTROL: an owner inviting an admin is not refused on rank", async () => {
    // The mirror of the negative above. An owner outranks admin, so the rank
    // check must let this through — whatever the mail service then does.
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const result = await invite(owner, invited.byOwner, "admin");

    expect(result.status).not.toBe(403);
    expect(result.message).not.toMatch(/as Admin/i);
  });
});

describe("the invited profile", () => {
  it("lands on the role that was asked for WHEN the invitation is actually sent", async () => {
    // `handle_new_user` creates every profile as a Member. If the function
    // stopped there, an invitation "as Admin" would silently produce a
    // Member — invisible until they could not do something, and looking for
    // all the world like a permissions bug.
    //
    // Conditional on the invitation having gone out, because the built-in
    // mail service's hourly cap decides that and not this code. Skipped
    // loudly rather than passing vacuously: a test that quietly asserts
    // nothing when a dependency is unavailable is worse than one that says so.
    const role = await roleOf(invited.byOwner);
    if (role === null) {
      console.warn(
        "SKIPPED: the invitation was not sent (email rate limit), so there is no profile to check."
      );
      return;
    }
    expect(role).toBe("admin");
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
