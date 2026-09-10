// The board's columns, against the real database.
//
// Driven from RAW clients, never through the app's backend module: the claim
// is what Postgres refuses, not what the interface declines to offer. The
// store has its own tests for the sentences a person reads
// (tests/qa/status-writes.test.ts); these are about the rules underneath,
// which a direct PostgREST call cannot walk around.
//
// Two of them are not policies at all but schema:
//   * `tasks.status` is a foreign key with `on delete restrict`, so a column
//     still holding work cannot be removed;
//   * a partial unique index permits exactly one `is_done`.
// Both are here because "the UI stops you" and "the database stops you" are
// very different guarantees, and only the second survives someone with an
// access token and curl.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  owner: `st-owner-${stamp}@lumina.test`,
  admin: `st-admin-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};
const createdStatuses: string[] = [];
const PROJECT = `p_st_${stamp}`;
const TASK = `t_st_${stamp}`;
const HELD = `s_held_${stamp}`;

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ola Owner", handle: `stola${stamp}`, roleId: "owner",
  });
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `stada${stamp}`, roleId: "admin",
  });

  // A column with real work in it, for the foreign key to defend.
  createdStatuses.push(HELD);
  await serviceClient.from("statuses").insert({
    id: HELD, name: `Held ${stamp}`, color: "#000000", position: 90, is_done: false,
  });
  await serviceClient.from("projects").insert({
    id: PROJECT, name: `Statuses ${stamp}`, description: "", emoji: "🧪",
    color: "#000000", priority: "medium", restricted: false, created_by: ids.owner,
  });
  await serviceClient.from("tasks").insert({
    id: TASK, project_id: PROJECT, title: "Occupant", description: "",
    status: HELD, priority: "medium", position: 0, created_by: ids.owner,
  });
});

afterAll(async () => {
  await serviceClient.from("tasks").delete().eq("id", TASK);
  await serviceClient.from("projects").delete().eq("id", PROJECT);
  for (const id of createdStatuses) {
    await serviceClient.from("statuses").delete().eq("id", id);
  }
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("who may write a status", () => {
  it("REFUSES an admin — this is the one power that separates Owner from Admin", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const id = `s_admin_${stamp}`;
    createdStatuses.push(id);
    const { data, error } = await admin
      .from("statuses")
      .insert({ id, name: `Nope ${stamp}`, color: "#000000", position: 91, is_done: false })
      .select("id");
    // RLS filters rather than raising, so "no error and no rows" is the
    // refusal — asserting only on `error` would pass on a silent no-op.
    expect(data ?? []).toHaveLength(0);
    expect(error ?? { message: "filtered" }).toBeTruthy();
    expect(await rowExists(id)).toBe(false);
  });

  it("REFUSES an admin renaming an existing column", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { data } = await admin
      .from("statuses")
      .update({ name: "Renamed by an admin" })
      .eq("id", "backlog")
      .select("id");
    expect(data ?? []).toHaveLength(0);
    const { data: after } = await serviceClient
      .from("statuses").select("name").eq("id", "backlog").maybeSingle();
    expect(after?.name).not.toBe("Renamed by an admin");
  });

  it("CONTROL: an owner CAN create and rename one", async () => {
    // Without this, `statuses_write` could be refusing everybody and both
    // negatives above would still pass.
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const id = `s_owner_${stamp}`;
    createdStatuses.push(id);

    const created = await owner
      .from("statuses")
      .insert({ id, name: `Owned ${stamp}`, color: "#000000", position: 92, is_done: false })
      .select("id");
    expect(created.error).toBeNull();
    expect(created.data ?? []).toHaveLength(1);

    const renamed = await owner
      .from("statuses").update({ name: `Owned again ${stamp}` }).eq("id", id).select("id");
    expect(renamed.error).toBeNull();
    expect(renamed.data ?? []).toHaveLength(1);
  });

  it("CONTROL: everyone signed in can READ the columns — a board needs them", async () => {
    const admin = await signInAs(emails.admin, TEST_PASSWORD);
    const { data, error } = await admin.from("statuses").select("id");
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

describe("the rules that are schema, not policy", () => {
  it("REFUSES removing a column that still holds work — even for the owner", async () => {
    // The foreign key, not the interface. The store checks the count first
    // and explains; this is what happens when nobody asks it nicely.
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const { error } = await owner.from("statuses").delete().eq("id", HELD);
    expect(error).not.toBeNull();
    expect(await rowExists(HELD)).toBe(true);
  });

  it("CONTROL: the same owner CAN remove an empty column", async () => {
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const id = `s_empty_${stamp}`;
    await serviceClient.from("statuses").insert({
      id, name: `Empty ${stamp}`, color: "#000000", position: 93, is_done: false,
    });
    const { error } = await owner.from("statuses").delete().eq("id", id);
    expect(error).toBeNull();
    expect(await rowExists(id)).toBe(false);
  });

  it("REFUSES a second finished column", async () => {
    // A partial unique index. Without it, `isDone` would answer according to
    // whichever row came back first.
    const owner = await signInAs(emails.owner, TEST_PASSWORD);
    const { error } = await owner.from("statuses").update({ is_done: true }).eq("id", "backlog");
    expect(error).not.toBeNull();
    const { data } = await serviceClient.from("statuses").select("id").eq("is_done", true);
    expect(data ?? []).toHaveLength(1);
  });
});

async function rowExists(id: string): Promise<boolean> {
  const { data } = await serviceClient.from("statuses").select("id").eq("id", id).maybeSingle();
  return data !== null;
}
