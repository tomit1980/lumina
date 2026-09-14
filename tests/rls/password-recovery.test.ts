// A password reset, end to end against the real database — without sending a
// single email.
//
// `admin.generateLink({ type: "recovery" })` mints exactly the token Supabase
// would have put in the email and hands it back instead of delivering it.
// `verifyOtp` then turns it into the same session a person gets by clicking the
// link. So this exercises the real token, the real session and the real write,
// while spending nothing from the free tier's ~2-messages-an-hour budget —
// which is the cap that locked the Owner out on day one and which
// tests/rls/create-user-function.test.ts records the invite flow hitting.
//
// The half this cannot cover is delivery: whether the email arrives, and
// whether the link in it points at the right site. That depends on the
// dashboard's Site URL and is proved once, by hand, on production.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient, createTestUser, deleteTestUser, serviceClient, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  ordinary: `rec-ordinary-${stamp}@lumina.test`,
  handed: `rec-handed-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

const NEW_PASSWORD = "reset-by-link-7k";

beforeAll(async () => {
  await seedRoles();
  ids.ordinary = await createTestUser({
    email: emails.ordinary, password: TEST_PASSWORD,
    name: "Ordinary Olu", handle: `recolu${stamp}`, roleId: "member",
  });
  ids.handed = await createTestUser({
    email: emails.handed, password: TEST_PASSWORD,
    name: "Handed Hana", handle: `rechana${stamp}`, roleId: "member",
  });

  // As `create-user` leaves a freshly created teammate: still holding the
  // password an admin typed out loud.
  const { error } = await serviceClient
    .from("profiles").update({ must_change_password: true }).eq("id", ids.handed);
  if (error) throw new Error(`could not set the flag: ${error.message}`);
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

/** The token Supabase would have emailed, fetched instead of delivered. */
async function recoveryToken(email: string): Promise<string> {
  const { data, error } = await serviceClient.auth.admin.generateLink({
    type: "recovery",
    email,
  });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const hashed = data?.properties?.hashed_token;
  if (!hashed) throw new Error("generateLink returned no hashed_token");
  return hashed;
}

/** Redeem it the way clicking the link does, and return the signed-in client. */
async function redeem(tokenHash: string) {
  const client = anonClient();
  const { data, error } = await client.auth.verifyOtp({
    token_hash: tokenHash,
    type: "recovery",
  });
  if (error) throw new Error(`verifyOtp failed: ${error.message}`);
  return { client, session: data.session };
}

async function canSignIn(email: string, password: string): Promise<boolean> {
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
  return !error && !!data.session;
}

describe("redeeming a reset link", () => {
  it("produces a real session", async () => {
    const { session } = await redeem(await recoveryToken(emails.ordinary));

    expect(session).not.toBeNull();
    expect(session?.user.id).toBe(ids.ordinary);
  });

  it("sets a new password, and the OLD one stops working", async () => {
    // Both halves. "The call returned" is not "the password changed" — the
    // refusal of the old password is what tells those apart, and it is the
    // check that has caught a no-op write twice in this codebase.
    const { client } = await redeem(await recoveryToken(emails.ordinary));

    const { error } = await client.auth.updateUser({ password: NEW_PASSWORD });
    expect(error).toBeNull();

    expect(await canSignIn(emails.ordinary, NEW_PASSWORD)).toBe(true);
    expect(await canSignIn(emails.ordinary, TEST_PASSWORD)).toBe(false);
  });

  it("CONTROL: a token cannot be redeemed twice", async () => {
    // Bounds what a leaked link is worth. Without this, "the link worked"
    // would say nothing about whether it keeps working.
    const token = await recoveryToken(emails.ordinary);
    await redeem(token);

    const { error } = await anonClient().auth.verifyOtp({
      token_hash: token,
      type: "recovery",
    });

    expect(error).toBeTruthy();
  });
});

describe("the teammate who never replaced her handed-out password", () => {
  it("clears must_change_password, because the trigger watches the real column", async () => {
    // The case the app's restore path used to discard on arrival. Nothing here
    // writes the flag: 20260911000100's trigger fires on
    // `auth.users.encrypted_password` moving, whatever moved it — so a reset
    // link satisfies the requirement exactly as the in-app gate does.
    expect(await flagOf(ids.handed)).toBe(true);

    const { client } = await redeem(await recoveryToken(emails.handed));
    const { error } = await client.auth.updateUser({ password: NEW_PASSWORD });
    expect(error).toBeNull();

    expect(await flagOf(ids.handed)).toBe(false);
  });

  it("CONTROL: the flag was not cleared by the redemption alone", async () => {
    // Redeeming a link is not replacing a password. If simply following the
    // link cleared the requirement, the gate would be bypassable by anyone who
    // could trigger a reset email.
    const { error } = await serviceClient
      .from("profiles").update({ must_change_password: true }).eq("id", ids.handed);
    expect(error).toBeNull();

    await redeem(await recoveryToken(emails.handed));

    expect(await flagOf(ids.handed)).toBe(true);
  });
});

async function flagOf(userId: string): Promise<boolean | null> {
  const { data } = await serviceClient
    .from("profiles").select("must_change_password").eq("id", userId).maybeSingle();
  return data?.must_change_password ?? null;
}
