import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

// Task 8 — the five writes that decide what everybody else may do, against
// lumina-dev, under the real policies and the real triggers.
//
// tests/qa/role-writes.test.ts proves what the STORE does with a resolved or
// rejected promise; tests/qa/supabase-backend.test.ts proves what this backend
// SENDS. Neither can observe the thing that actually matters here, which is
// that the rules hold against a caller who never went near the UI. So every
// invariant below is asserted TWICE: once through `SupabaseBackend` (the app
// path) and once through a raw PostgREST call on the same signed-in client
// (the bypass). The raw half is the one that proves the trigger; the app half
// would pass just as happily against a client-side check.
//
// Every negative is paired with a positive control on the SAME client and the
// SAME method, so a suite in which nothing worked at all could not pass.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ASSERT, and why it is worth knowing:
// `roles_write` (20260906000100_identity.sql) has no opinion on `is_system` or
// `locked`, and no trigger covers a roles UPDATE. So a raw PostgREST call from
// any account holding `members.manage` can still edit the locked Admin role —
// the store refuses it, and lib/backend/supabase/roles.ts refuses it again, but
// the database does not. It is not an escalation (a caller with members.manage
// can already mint a role holding everything) yet it IS a one-way lockout:
// revoke members.manage from Admin and nobody can grant it back. A trigger is
// the fix and this task owns no migration, so it is written up as a follow-up
// in .superpowers/sdd/2026-09-08-store-swap/task-8-report.md rather than being
// pinned here as an expectation.
//
// Frugal like every file here: Supabase rate-limits signInWithPassword per
// project across the whole run and these files execute in parallel forks. THREE
// identities ever sign in — `boss` (Admin), `mate` (a plain Member, holding no
// members.manage) and `stew` (a custom role that holds members.manage but is
// NOT the admin role, which is the only way to reach the last-admin trigger
// from a session: an admin demoting an admin means there were two).
const stamp = Date.now();
const emails = {
  boss: `rwboss-${stamp}@lumina.test`,
  mate: `rwmate-${stamp}@lumina.test`,
  stew: `rwstew-${stamp}@lumina.test`,
  pawn: `rwpawn-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};
const createdRoles = new Set<string>();

const STEWARD = `r_rw_steward_${stamp}`;
const CUSTOM = `r_rw_custom_${stamp}`;

const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

async function backendFor(email: string): Promise<SupabaseBackend> {
  return new SupabaseBackend(await clientFor(email));
}

/** A role row, past RLS. */
async function roleRow(id: string) {
  const { data } = await serviceClient
    .from("roles").select("id,name,permissions,is_system,locked").eq("id", id).maybeSingle();
  return data;
}

/** Somebody's stored role id, past RLS — the only honest way to check that a
 *  refusal really refused rather than merely reporting an error. */
async function roleOf(userId: string): Promise<string | null> {
  const { data } = await serviceClient
    .from("profiles").select("role_id").eq("id", userId).maybeSingle();
  return data?.role_id ?? null;
}

async function makeRole(id: string, permissions: string[]): Promise<void> {
  createdRoles.add(id);
  const { error } = await serviceClient.from("roles").upsert({
    id, name: id, description: "", color: "#334155", permissions,
    is_system: false, locked: false,
  });
  if (error) throw new Error(`makeRole failed: ${error.message}`);
}

beforeAll(async () => {
  await seedRoles();
  await makeRole(STEWARD, ["message.send", "members.manage"]);
  await makeRole(CUSTOM, ["message.send"]);

  ids.boss = await createTestUser({
    email: emails.boss, password: TEST_PASSWORD,
    name: "Bo", handle: `rwbo${stamp}`, roleId: "admin",
  });
  // No members.manage: every refusal aimed at this identity is the policy
  // talking, not an admin fixture papering over it.
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Mo", handle: `rwmo${stamp}`, roleId: "member",
  });
  ids.stew = await createTestUser({
    email: emails.stew, password: TEST_PASSWORD,
    name: "St", handle: `rwst${stamp}`, roleId: STEWARD,
  });
  // Assigned to and demoted; never authenticates.
  ids.pawn = await createTestUser({
    email: emails.pawn, password: TEST_PASSWORD,
    name: "Pa", handle: `rwpa${stamp}`, roleId: "member",
  });

  await clientFor(emails.boss);
  await clientFor(emails.mate);
  await clientFor(emails.stew);
}, 60_000);

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
  // One statement per role, not a single `.in(...)`. `block_role_delete_with_
  // members` is a BEFORE DELETE trigger, so a raise on ONE row aborts the whole
  // statement and strands every other fixture with it — which is how a broken
  // run leaves roles behind in lumina-dev for the next suite to trip over (and
  // tests/rls/store-swap.test.ts's "three system roles and no duplicates" then
  // fails, correctly, in a completely unrelated file). Unlocked first for the
  // same reason: a role this file managed to store as `is_system` could not be
  // deleted at all, and cleanup must not depend on the code under test being
  // right.
  for (const id of createdRoles) {
    await serviceClient.from("roles").update({ is_system: false, locked: false }).eq("id", id);
    await serviceClient.from("roles").delete().eq("id", id);
  }
});

// ---------------------------------------------------------------------------
// setUserRole — and the reason its guard and its policy do not match
// ---------------------------------------------------------------------------
describe("setUserRole — nobody changes their own role", () => {
  it("REFUSES a member promoting themselves, through the backend AND raw", async () => {
    // The heart of it. `profiles` carries two permissive UPDATE policies and
    // Postgres OR-s them: `profiles_admin_write` wants members.manage,
    // `profiles_update_self` wants only `id = auth.uid()`. So RLS lets a
    // member's own row through, and the ONLY thing between a member and the
    // admin role is `profiles_block_self_role_change`. The raw half below is
    // what proves that trigger exists — the backend half would pass against a
    // purely client-side check.
    const client = await clientFor(emails.mate);
    const raw = await client.from("profiles")
      .update({ role_id: "admin" }).eq("id", ids.mate).select("id");
    expect(raw.error).not.toBeNull();
    expect(raw.error!.message).toMatch(/own role/i);

    const backend = await backendFor(emails.mate);
    await expect(backend.setUserRole(ids.mate, "admin")).rejects.toThrow(/own role/i);

    expect(await roleOf(ids.mate)).toBe("member");
  });

  it("REFUSES an admin demoting themselves — the rule has no admin exemption", async () => {
    // EITHER message is the correct outcome here, and which one appears is not
    // this file's to pin. `profiles_block_last_admin` and
    // `profiles_block_self_role_change` are both BEFORE UPDATE triggers on
    // `profiles`, Postgres fires same-event triggers in NAME order, and
    // `..._block_last_admin` sorts first. 20260906000500_invariants.sql notes
    // that their order "never matters" because each raises only on its own
    // condition — true of the conditions, but an admin demoting themselves
    // while being the only admin satisfies BOTH, and then the first one to fire
    // is the one that speaks. The refusal is the assertion; the wording is
    // whichever trigger got there, and it depends on how many admins other
    // suites happen to be holding open at this instant.
    const refusal = /own role|last admin/i;
    const client = await clientFor(emails.boss);
    const raw = await client.from("profiles")
      .update({ role_id: "member" }).eq("id", ids.boss).select("id");
    expect(raw.error).not.toBeNull();
    expect(raw.error!.message).toMatch(refusal);

    const backend = await backendFor(emails.boss);
    await expect(backend.setUserRole(ids.boss, "member")).rejects.toThrow(refusal);

    expect(await roleOf(ids.boss)).toBe("admin");
  });

  it("lets an admin change SOMEBODY ELSE's role — the positive control", async () => {
    const backend = await backendFor(emails.boss);

    await expect(backend.setUserRole(ids.pawn, "guest")).resolves.toBeUndefined();
    expect(await roleOf(ids.pawn)).toBe("guest");

    await backend.setUserRole(ids.pawn, "member");
    expect(await roleOf(ids.pawn)).toBe("member");
  });
});

describe("setUserRole — the guard/policy mismatch this task was told to look for", () => {
  it("REFUSES a member setting their own role to the one they already have", async () => {
    // Task 7's `move_task` bug in its other direction. The store guards
    // `members.manage`; the server, for a self-targeted row, guards nothing at
    // all. A member re-asserting the role they already hold changes nothing, so
    // no trigger fires and no policy filters it — the UPDATE succeeds and, left
    // to RLS alone, `setUserRole` would RESOLVE for somebody who may not set
    // roles. `SupabaseBackend` asks `has_permission('members.manage')` outright
    // so that its requirement equals the store's guard instead of merely
    // arriving at the same place by accident.
    const backend = await backendFor(emails.mate);
    await expect(backend.setUserRole(ids.mate, "member")).rejects.toThrow(
      /can't manage members/i
    );

    // ...and the bypass really does succeed, which is why the check is needed.
    const client = await clientFor(emails.mate);
    const raw = await client.from("profiles")
      .update({ role_id: "member" }).eq("id", ids.mate).select("id");
    expect(raw.error).toBeNull();
    expect(raw.data).toHaveLength(1);
    expect(await roleOf(ids.mate)).toBe("member");
  });

  it("REFUSES a member changing anybody else's role, and writes nothing", async () => {
    const backend = await backendFor(emails.mate);
    await expect(backend.setUserRole(ids.pawn, "admin")).rejects.toThrow(
      /manage members|permission/i
    );
    expect(await roleOf(ids.pawn)).toBe("member");
  });

  it("lets a NON-admin who holds members.manage do it — the positive control", async () => {
    // `stew` is not on the admin role; the only thing it has is the permission
    // the guard names. If the two ever diverged, this is the test that would
    // catch it going the other way.
    const backend = await backendFor(emails.stew);

    await expect(backend.setUserRole(ids.pawn, "guest")).resolves.toBeUndefined();
    expect(await roleOf(ids.pawn)).toBe("guest");

    await backend.setUserRole(ids.pawn, "member");
  });
});

describe("setUserRole — the last admin", () => {
  it("REFUSES demoting the sole admin from a client session", async () => {
    // `block_last_admin_removal` reads a genuinely global count (this app has
    // one workspace), so whether `boss` is *the* last admin at this instant
    // depends on what else is running against the same dev project — the same
    // constraint tests/rls/invariants.test.ts records for its service-key
    // version of this check. Both branches assert something real, which is as
    // deterministic as a global invariant can be made from one isolated file.
    //
    // Note the caller: only somebody who is NOT an admin but DOES hold
    // members.manage can reach this trigger, because an admin demoting an
    // admin means there were two.
    const backend = await backendFor(emails.stew);
    const client = await clientFor(emails.stew);
    const { data: admins } = await serviceClient
      .from("profiles").select("id").eq("role_id", "admin");

    if ((admins ?? []).length === 1) {
      const raw = await client.from("profiles")
        .update({ role_id: "member" }).eq("id", ids.boss).select("id");
      expect(raw.error).not.toBeNull();
      expect(raw.error!.message).toMatch(/last admin/i);

      await expect(backend.setUserRole(ids.boss, "member")).rejects.toThrow(/last admin/i);
      expect(await roleOf(ids.boss)).toBe("admin");
    } else {
      // Positive control: with another admin genuinely present (left by a
      // concurrently-running suite), demoting a second, disposable admin we
      // fully control must SUCCEED — proving the trigger is not simply
      // refusing every demotion.
      await serviceClient.from("profiles").update({ role_id: "admin" }).eq("id", ids.pawn);
      await expect(backend.setUserRole(ids.pawn, "member")).resolves.toBeUndefined();
      expect(await roleOf(ids.pawn)).toBe("member");
    }
  });
});

// ---------------------------------------------------------------------------
// roles — create, update, permissions, delete
// ---------------------------------------------------------------------------
describe("createRole", () => {
  it("REFUSES a member, and creates no row", async () => {
    const backend = await backendFor(emails.mate);
    const id = `r_rw_denied_${stamp}`;
    createdRoles.add(id);

    await expect(
      backend.createRole({ id, name: id, description: "", color: "#111", permissions: [] })
    ).rejects.toThrow();
    expect(await roleRow(id)).toBeNull();
  });

  it("lets an admin create one, and FORCES is_system/locked false", async () => {
    // The positive control, and the hardening in one: `Backend.createRole`
    // takes a whole `RoleDef` on which both flags are optional, and a role
    // stored with `is_system: true` would be undeletable forever —
    // `block_role_delete_with_members` refuses built-ins outright.
    const backend = await backendFor(emails.boss);
    const id = `r_rw_made_${stamp}`;
    createdRoles.add(id);

    const created = await backend.createRole({
      id, name: id, description: "Made in a test", color: "#111",
      permissions: ["message.send"], isSystem: true, locked: true,
    });

    expect(created).toMatchObject({ id, permissions: ["message.send"] });
    expect(await roleRow(id)).toMatchObject({ is_system: false, locked: false });
  });
});

describe("updateRole and setRolePermission", () => {
  it("REFUSES a member, and changes nothing", async () => {
    const backend = await backendFor(emails.mate);

    await expect(backend.updateRole(CUSTOM, { name: "Seized" })).rejects.toThrow(/permission/i);
    await expect(backend.setRolePermission(CUSTOM, "members.manage", true)).rejects.toThrow(
      /permission/i
    );

    expect(await roleRow(CUSTOM)).toMatchObject({
      name: CUSTOM, permissions: ["message.send"],
    });
  });

  it("REFUSES editing the locked Admin role", async () => {
    // The store refuses this and so does the backend. The DATABASE does not —
    // see the header note; that gap is a report follow-up, not a silent pass.
    const backend = await backendFor(emails.boss);
    await expect(backend.updateRole("admin", { name: "Overlord" })).rejects.toThrow(/locked/i);
    await expect(
      backend.setRolePermission("admin", "members.manage", false)
    ).rejects.toThrow(/locked/i);

    expect(await roleRow("admin")).toMatchObject({ name: "Admin", locked: true });
  });

  it("lets an admin edit a custom role — the positive control", async () => {
    const backend = await backendFor(emails.boss);

    await expect(
      backend.updateRole(CUSTOM, { name: `${CUSTOM}-renamed`, color: "#abcdef" })
    ).resolves.toBeUndefined();

    expect(await roleRow(CUSTOM)).toMatchObject({ name: `${CUSTOM}-renamed` });
    await backend.updateRole(CUSTOM, { name: CUSTOM });
  });

  it("computes the permission array from the STORED row, not the caller's copy", async () => {
    // A concurrent grant, applied out of band between the store's last hydrate
    // and this toggle. Writing back the client's array would silently revoke
    // it; reading the row first keeps it.
    const backend = await backendFor(emails.boss);
    await serviceClient
      .from("roles").update({ permissions: ["message.send", "task.create"] }).eq("id", CUSTOM);

    await backend.setRolePermission(CUSTOM, "task.edit", true);

    expect((await roleRow(CUSTOM))!.permissions.sort()).toEqual(
      ["message.send", "task.create", "task.edit"]
    );

    await backend.setRolePermission(CUSTOM, "task.edit", false);
    expect((await roleRow(CUSTOM))!.permissions).not.toContain("task.edit");
  });
});

describe("deleteRole", () => {
  it("REFUSES a role that still has members, and keeps the role", async () => {
    const id = `r_rw_populated_${stamp}`;
    await makeRole(id, ["message.send"]);
    await serviceClient.from("profiles").update({ role_id: id }).eq("id", ids.pawn);
    const backend = await backendFor(emails.boss);
    const client = await clientFor(emails.boss);

    const raw = await client.from("roles").delete().eq("id", id).select("id");
    expect(raw.error).not.toBeNull();
    expect(raw.error!.message).toMatch(/still has members/i);

    await expect(backend.deleteRole(id)).rejects.toThrow(/still has members/i);
    expect(await roleRow(id)).not.toBeNull();

    // The positive control, on the SAME client and the SAME method: move the
    // member off and the delete goes through. Without this, a deleteRole that
    // refused everything would pass the assertion above.
    await backend.setUserRole(ids.pawn, "member");
    await expect(backend.deleteRole(id)).resolves.toBeUndefined();
    expect(await roleRow(id)).toBeNull();
  });

  it("REFUSES a built-in role, and keeps it", async () => {
    const backend = await backendFor(emails.boss);
    const client = await clientFor(emails.boss);

    // What matters here is that the server refuses and the role survives.
    // Which guard speaks first is not this test's business: `guest` is a
    // shared row, so whether it has members at this moment depends on which
    // other suite is running, and pinning the wording made the whole gate
    // fail intermittently — "still has members" is an equally correct
    // refusal. The exact built-in wording is asserted in
    // tests/qa/supabase-backend.test.ts, where the state is deterministic.
    const raw = await client.from("roles").delete().eq("id", "guest").select("id");
    expect(raw.error).not.toBeNull();

    await expect(backend.deleteRole("guest")).rejects.toThrow();
    expect(await roleRow("guest")).not.toBeNull();
  });

  it("REFUSES a member, and keeps the role", async () => {
    const backend = await backendFor(emails.mate);
    await expect(backend.deleteRole(CUSTOM)).rejects.toThrow(/permission/i);
    expect(await roleRow(CUSTOM)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The statement-ordering rule, proved against the real policy. Runs LAST: it
// takes members.manage away from `stew` for good.
// ---------------------------------------------------------------------------
describe("updateRole is ONE statement, because the caller may be editing their own powers", () => {
  it("lands a patch that revokes the caller's own members.manage", async () => {
    // `roles_write`'s USING is `has_permission('members.manage')` and the row
    // being written can be the CALLER'S OWN role. Split into "the scalar
    // fields, then the permissions", the second statement would be filtered to
    // zero rows the moment the first took the permission away — half applied,
    // and reported as a permission error rather than the lockout it is. One
    // statement makes the whole patch land or none of it.
    const backend = await backendFor(emails.stew);

    await expect(
      backend.updateRole(STEWARD, {
        name: `${STEWARD}-final`, permissions: ["message.send"],
      })
    ).resolves.toBeUndefined();

    expect(await roleRow(STEWARD)).toMatchObject({
      name: `${STEWARD}-final`, permissions: ["message.send"],
    });

    // And now they genuinely cannot: the negative half of the same pair, which
    // also confirms the permission really was the thing being written.
    await expect(backend.updateRole(STEWARD, { name: "again" })).rejects.toThrow(/permission/i);
    await expect(backend.setUserRole(ids.pawn, "guest")).rejects.toThrow(
      /manage members|permission/i
    );
  });
});
