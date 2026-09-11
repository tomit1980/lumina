// Who may curate a task set, asked of the database rather than the interface.
//
// The Settings screen will only show the editor to somebody holding
// `workspace.taskSets`, and that is worth nothing here: the publishable key is
// in every bundle and any signed-in person can POST to PostgREST directly. So
// every claim below is made from a client that really is a Member, or really
// is an Admin, or really is an Owner.
//
// WHY THE PERMISSION IS ITS OWN. It would have been cheaper to ride on
// `project.create` - Owner and Admin already hold it, no migration. But
// 20260906000350_fix_project_policies.sql contemplates a custom role holding
// `project.create` alone ("an ordinary project manager"), and set management
// riding on it would mean granting project creation silently also grants the
// right to delete the definition every future project is built from. The tests
// that matter here are therefore the ones proving a non-holder is refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  owner: `ts-owner-${stamp}@lumina.test`,
  admin: `ts-admin-${stamp}@lumina.test`,
  member: `ts-member-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

/** Sets this file creates, through any client; all are swept in afterAll. */
const sets = {
  seeded: `ts_seeded_${stamp}`,
  byAdmin: `ts_admin_${stamp}`,
  byOwner: `ts_owner_${stamp}`,
  refused: `ts_refused_${stamp}`,
};
const items = {
  seeded: `tsi_seeded_${stamp}`,
  refused: `tsi_refused_${stamp}`,
};

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ola Owner", handle: `tsola${stamp}`, roleId: "owner",
  });
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `tsada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo Member", handle: `tsmo${stamp}`, roleId: "member",
  });

  const set = await serviceClient.from("task_sets").insert({
    id: sets.seeded, name: "Pension Release — Standard", created_by: ids.owner,
  });
  if (set.error) throw new Error(`seed set failed: ${set.error.message}`);
  const item = await serviceClient.from("task_set_items").insert({
    id: items.seeded, task_set_id: sets.seeded,
    title: "Collect client identification", position: 0,
  });
  if (item.error) throw new Error(`seed item failed: ${item.error.message}`);
});

afterAll(async () => {
  await serviceClient.from("task_sets").delete().in("id", Object.values(sets));
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

async function setExists(id: string): Promise<boolean> {
  const { data } = await serviceClient.from("task_sets").select("id").eq("id", id).maybeSingle();
  return !!data;
}

async function nameOf(id: string): Promise<string | null> {
  const { data } = await serviceClient.from("task_sets").select("name").eq("id", id).maybeSingle();
  return data?.name ?? null;
}

describe("a member, who does not hold workspace.taskSets", () => {
  it("REFUSES creating a set", async () => {
    const them = await signInAs(emails.member, TEST_PASSWORD);

    await them.from("task_sets").insert({ id: sets.refused, name: "Mine" });

    // RLS filters rather than raising on INSERT with no returning clause, so
    // the absence of the row is the assertion - not the absence of an error.
    expect(await setExists(sets.refused)).toBe(false);
  });

  it("REFUSES renaming an existing set", async () => {
    const them = await signInAs(emails.member, TEST_PASSWORD);

    await them.from("task_sets").update({ name: "Renamed by a member" }).eq("id", sets.seeded);

    expect(await nameOf(sets.seeded)).toBe("Pension Release — Standard");
  });

  it("REFUSES archiving a set", async () => {
    const them = await signInAs(emails.member, TEST_PASSWORD);

    await them
      .from("task_sets").update({ archived_at: new Date().toISOString() }).eq("id", sets.seeded);

    const { data } = await serviceClient
      .from("task_sets").select("archived_at").eq("id", sets.seeded).maybeSingle();
    expect(data?.archived_at).toBeNull();
  });

  it("REFUSES adding an item to a set", async () => {
    const them = await signInAs(emails.member, TEST_PASSWORD);

    await them.from("task_set_items").insert({
      id: items.refused, task_set_id: sets.seeded, title: "Snuck in", position: 99,
    });

    const { data } = await serviceClient
      .from("task_set_items").select("id").eq("id", items.refused).maybeSingle();
    expect(data).toBeNull();
  });

  it("CAN read both tables — the project picker depends on it", async () => {
    // The counterweight to the four refusals. Read is open exactly as
    // statuses_read is: a set's name is no more sensitive than a board
    // column's, and somebody who cannot see the list cannot choose from it.
    const them = await signInAs(emails.member, TEST_PASSWORD);

    const setsRead = await them.from("task_sets").select("id").eq("id", sets.seeded);
    const itemsRead = await them.from("task_set_items").select("id").eq("task_set_id", sets.seeded);

    expect(setsRead.error).toBeNull();
    expect(setsRead.data ?? []).toHaveLength(1);
    expect(itemsRead.data ?? []).toHaveLength(1);
  });
});

describe("CONTROL: who can", () => {
  it("an admin creates a set and adds an item", async () => {
    // Without this every refusal above would pass against a policy that
    // refused everybody, which is the same shape as a broken feature.
    const admin = await signInAs(emails.admin, TEST_PASSWORD);

    const set = await admin
      .from("task_sets").insert({ id: sets.byAdmin, name: "Onboarding" });
    const item = await admin.from("task_set_items").insert({
      id: `tsi_admin_${stamp}`, task_set_id: sets.byAdmin, title: "Send welcome pack", position: 0,
    });

    expect(set.error).toBeNull();
    expect(item.error).toBeNull();
    expect(await setExists(sets.byAdmin)).toBe(true);
  });

  it("an owner creates one too", async () => {
    const owner = await signInAs(emails.owner, TEST_PASSWORD);

    const { error } = await owner
      .from("task_sets").insert({ id: sets.byOwner, name: "Audit" });

    expect(error).toBeNull();
    expect(await setExists(sets.byOwner)).toBe(true);
  });
});

describe("what the database keeps true on its own", () => {
  it("bumps the set's updated_at when an ITEM changes, not only the set", async () => {
    // The Settings list prints "last updated". If only a set-level write
    // touched it, reordering or renaming an item would leave that line stale
    // while the screen kept claiming it was current — a component asserting
    // something it does not know.
    const before = await updatedAt(sets.seeded);
    await new Promise((r) => setTimeout(r, 1100));

    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await admin
      .from("task_set_items").update({ title: "Collect client ID" }).eq("id", items.seeded);
    expect(error).toBeNull();

    const after = await updatedAt(sets.seeded);
    expect(after).not.toBeNull();
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
  });

  it("CONTROL: an untouched set's updated_at does not move", async () => {
    // Proves the trigger is about the row that changed rather than bumping
    // every set on any write — which would make the column meaningless while
    // still passing the test above.
    const before = await updatedAt(sets.byOwner);
    await new Promise((r) => setTimeout(r, 1100));

    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    await admin.from("task_set_items").update({ title: "Collect ID" }).eq("id", items.seeded);

    expect(await updatedAt(sets.byOwner)).toBe(before);
  });

  it("cascades items when a set is deleted", async () => {
    const { error } = await serviceClient.from("task_sets").delete().eq("id", sets.byAdmin);
    expect(error).toBeNull();

    const { data } = await serviceClient
      .from("task_set_items").select("id").eq("task_set_id", sets.byAdmin);
    expect(data ?? []).toHaveLength(0);
  });
});

async function updatedAt(id: string): Promise<string | null> {
  const { data } = await serviceClient
    .from("task_sets").select("updated_at").eq("id", id).maybeSingle();
  return data?.updated_at ?? null;
}
