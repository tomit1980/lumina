// The four rules that make Owner a real privilege boundary rather than a
// label, driven against the database as an ordinary Admin.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. Admin holds `members.manage`, which
// lets it create a role carrying any permission and assign it to a colleague.
// Two admins could promote each other to anything. So an Owner defined as
// "Admin plus one more permission" would not be above Admin at all — an Admin
// could simply mint that permission and hand it over. These rules are the
// difference, and they live in triggers because the client is one PostgREST
// call away from being bypassed.
//
// Every rule is tested from a RAW client, not through the app's backend
// module: the point is what Postgres refuses, not what the UI declines to
// offer. And every refusal is paired with a control — an Owner doing the same
// thing successfully, or an Admin doing the ordinary version — because a rule
// that refused everybody would pass all the negatives on its own.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  owner: `rank-owner-${stamp}@lumina.test`,
  admin: `rank-admin-${stamp}@lumina.test`,
  member: `rank-member-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};
/** Roles this file creates directly, cleaned up at the end. */
const createdRoles: string[] = [];

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ola Owner", handle: `ola${stamp}`, roleId: "owner",
  });
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `ada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo Member", handle: `mo${stamp}`, roleId: "member",
  });
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
  for (const id of createdRoles) {
    await serviceClient.from("roles").delete().eq("id", id);
  }
});

describe("Rule 1 — you cannot grant a permission you do not hold", () => {
  it("REFUSES an admin creating a role that carries workspace.statuses", async () => {
    // The whole escalation in one statement: an admin does not hold
    // `workspace.statuses`, so minting a role that does would hand the
    // Owner's one power to anybody they then assign it to.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const id = `r_esc_${stamp}`;
    createdRoles.push(id);
    const { error } = await admin.from("roles").insert({
      id, name: `Escalated ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send", "workspace.statuses"],
      is_system: false, locked: false, rank: 50,
    });
    expect(error?.message ?? "").toContain("cannot grant");
  });

  it("CONTROL: the same admin CAN create a role with permissions they do hold", async () => {
    // Without this the rule could be refusing every insert and every negative
    // above would still pass.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const id = `r_ok_${stamp}`;
    createdRoles.push(id);
    const { error } = await admin.from("roles").insert({
      id, name: `Ordinary ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send", "task.create"],
      is_system: false, locked: false, rank: 50,
    });
    expect(error).toBeNull();
  });

  it("CONTROL: an owner CAN create a role carrying workspace.statuses", async () => {
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const id = `r_owner_${stamp}`;
    createdRoles.push(id);
    const { error } = await owner.from("roles").insert({
      id, name: `Curator ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send", "workspace.statuses"],
      is_system: false, locked: false, rank: 50,
    });
    expect(error).toBeNull();
  });

  it("allows an admin to REVOKE a permission they do not hold", async () => {
    // Taking away is not escalation, and blocking it would leave an admin
    // unable to tidy up a role an owner had created.
    const target = `r_revoke_${stamp}`;
    createdRoles.push(target);
    await serviceClient.from("roles").insert({
      id: target, name: `Revokable ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send", "workspace.statuses"],
      is_system: false, locked: false, rank: 50,
    });

    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await admin
      .from("roles")
      .update({ permissions: ["message.send"] })
      .eq("id", target);
    expect(error).toBeNull();
  });
});

describe("Rules 2 and 4 — never at or above your own rank", () => {
  it("REFUSES an admin creating a role ranked ABOVE their own", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const id = `r_peer_${stamp}`;
    createdRoles.push(id);
    const { error } = await admin.from("roles").insert({
      id, name: `Peer ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send"], is_system: false, locked: false, rank: 90,
    });
    expect(error?.message ?? "").toContain("above your own");
  });

  it("CONTROL: an admin CAN create a role at their own rank", async () => {
    // Strictly above, deliberately. A peer-ranked role grants nobody anything
    // they could not already have — an admin can assign the admin role
    // itself — and Rule 1 still stops them putting a permission on it that
    // they do not hold. The stricter "at or above" also forbade an admin
    // editing their OWN role, including to reduce it, which is a real flow.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const id = `r_samerank_${stamp}`;
    createdRoles.push(id);
    const { error } = await admin.from("roles").insert({
      id, name: `Samerank ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send"], is_system: false, locked: false, rank: 80,
    });
    expect(error).toBeNull();
  });

  it("REFUSES an admin editing the Owner role", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await admin
      .from("roles")
      .update({ name: "Not the owner any more" })
      .eq("id", "owner");
    // Locked catches this first, which is also correct — either refusal is
    // the database declining, which is what this asserts.
    expect(error).not.toBeNull();
  });

  it("REFUSES an admin raising a role they CAN edit up to their own rank", async () => {
    // The same escalation in two steps: make a role you are allowed to make,
    // then lift it. Without the second rank check this would work.
    const target = `r_lift_${stamp}`;
    createdRoles.push(target);
    await serviceClient.from("roles").insert({
      id: target, name: `Liftable ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send"], is_system: false, locked: false, rank: 50,
    });

    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await admin.from("roles").update({ rank: 90 }).eq("id", target);
    expect(error?.message ?? "").toContain("above your own");
  });

  it("CONTROL: an admin CAN edit a role below their rank", async () => {
    const target = `r_below_${stamp}`;
    createdRoles.push(target);
    await serviceClient.from("roles").insert({
      id: target, name: `Below ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send"], is_system: false, locked: false, rank: 50,
    });

    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await admin
      .from("roles")
      .update({ description: "edited by an admin" })
      .eq("id", target);
    expect(error).toBeNull();
  });
});

describe("Rule 3 — you cannot assign a role at or above your own", () => {
  it("REFUSES an admin promoting a member to Owner", async () => {
    // This is the escalation that survives every other rule: if an admin can
    // hand out the Owner role, everything else is decoration.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await admin
      .from("profiles")
      .update({ role_id: "owner" })
      .eq("id", ids.member);
    expect(error?.message ?? "").toContain("above your own");
  });

  it("CONTROL: an owner CAN promote a member to Admin", async () => {
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const { error } = await owner
      .from("profiles")
      .update({ role_id: "admin" })
      .eq("id", ids.member);
    expect(error).toBeNull();
    // Put them back, so the last-holder tests below read a clean workspace.
    await serviceClient.from("profiles").update({ role_id: "member" }).eq("id", ids.member);
  });
});

describe("the last holder of a locked role", () => {
  it("cannot be demoted — tested as OWNER, which the old trigger could not see", async () => {
    // `block_last_admin_removal` named the literal 'admin' three times, so an
    // Owner was invisible to it: a workspace could lose its only Owner while
    // the trigger contentedly protected a single Admin. This is the exact
    // case the rewrite exists for.
    const { error } = await serviceClient
      .from("profiles")
      .update({ role_id: "member" })
      .eq("id", ids.owner);
    expect(error?.message ?? "").toContain("last holder");
  });

  it("cannot be demoted — for ANY locked role, not the two the seed happens to have", async () => {
    // Deliberately not asserted against the seeded Admin role: the shared dev
    // workspace has other admins, so "the last admin" is not a state this
    // suite can assume, and a test that quietly depended on it would pass or
    // fail according to who else exists. A purpose-made locked role is also
    // the stronger claim — it proves the trigger keys on `locked` rather than
    // knowing the two ids it was written beside.
    const lockedRole = `r_locked_${stamp}`;
    createdRoles.push(lockedRole);
    await serviceClient.from("roles").insert({
      id: lockedRole, name: `Custodian ${stamp}`, description: "", color: "#000000",
      permissions: ["message.send"], is_system: false, locked: true, rank: 60,
    });
    await serviceClient
      .from("profiles")
      .update({ role_id: lockedRole })
      .eq("id", ids.member);

    const { error } = await serviceClient
      .from("profiles")
      .update({ role_id: "member" })
      .eq("id", ids.member);
    expect(error?.message ?? "").toContain("last holder");

    // Two holders, and the same demotion is allowed — which is what shows the
    // rule is "the LAST one" rather than "any holder, ever".
    await serviceClient.from("profiles").update({ role_id: lockedRole }).eq("id", ids.admin);
    const second = await serviceClient
      .from("profiles")
      .update({ role_id: "member" })
      .eq("id", ids.member);
    expect(second.error).toBeNull();
    await serviceClient.from("profiles").update({ role_id: "admin" }).eq("id", ids.admin);
  });

  it("CONTROL: an ordinary member can be moved freely", async () => {
    // Without this, a trigger that refused every role change would pass both
    // negatives above while making the workspace unmanageable.
    const { error } = await serviceClient
      .from("profiles")
      .update({ role_id: "guest" })
      .eq("id", ids.member);
    expect(error).toBeNull();
    await serviceClient.from("profiles").update({ role_id: "member" }).eq("id", ids.member);
  });
});
