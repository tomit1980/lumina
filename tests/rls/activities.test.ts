import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addChannelMember, createChannel, createProject, seedRoles } from "../helpers/workspace";

// QA-001's last hole. activities_read was `using (true)`, so every signed-in
// browser received the whole feed — including free-text rows naming restricted
// projects and private channels. 20260909000900_activity_scope.sql gives a row
// a nullable scope and filters on it; this file is the gate on that filter.
//
// The shape that matters here is the PAIRING. An RLS test that only asserts
// "the outsider sees zero restricted rows" passes just as happily when the
// query is broken, the table is missing, or the policy denies everything — so
// each negative below has a positive control that proves the same query, run
// by the same client in the same call, does return the rows it should.
//
// Frugal with identities for the reason task-collaborators.test.ts documents:
// Supabase rate-limits sign-ins per IP across the whole parallel rls run. Two
// users, one of them ever signed in.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const openProject = `p_act_open_${stamp}`;
const secretProject = `p_act_secret_${stamp}`;
const publicChannel = `c_act_pub_${stamp}`;
const privateChannel = `c_act_priv_${stamp}`;

// One activity per visibility case. The two "secret" texts are written to look
// exactly like the real leak: they name the restricted resource in prose.
const wideActivity = `a_act_wide_${stamp}`;
const openProjectActivity = `a_act_open_${stamp}`;
const publicChannelActivity = `a_act_pub_${stamp}`;
const secretProjectActivity = `a_act_secret_${stamp}`;
const privateChannelActivity = `a_act_priv_${stamp}`;

const SECRET_PROJECT_TEXT = `created the Payroll ${stamp} project`;
const PRIVATE_CHANNEL_TEXT = `deleted #board-only-${stamp}`;

const emails = {
  owner: `actown-${stamp}@lumina.test`,
  outsider: `actout-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

// Rows the outsider's own insert attempts may leave behind.
const insertedByOutsider = [
  `a_act_try_wide_${stamp}`,
  `a_act_try_proj_${stamp}`,
  `a_act_try_conv_${stamp}`,
];

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ola", handle: `acola${stamp}`, roleId: "admin",
  });
  // A plain member: holds no members.manage, so can_see_project /
  // can_see_conversation give them nothing but the open resources.
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Ozzy", handle: `acozzy${stamp}`, roleId: "member",
  });

  await createProject({ id: openProject, name: "Website", restricted: false, createdBy: ids.owner });
  await createProject({ id: secretProject, name: "Payroll", restricted: true, createdBy: ids.owner });
  await createChannel({ id: publicChannel, name: `act-pub-${stamp}`, isPrivate: false, createdBy: ids.owner });
  await createChannel({ id: privateChannel, name: `board-only-${stamp}`, isPrivate: true, createdBy: ids.owner });
  await addChannelMember(privateChannel, ids.owner, "editor");

  const seeded = await serviceClient.from("activities").insert([
    { id: wideActivity, actor_id: ids.owner, kind: "member",
      text: `made Ozzy ${stamp} an admin`, project_id: null, conversation_id: null },
    { id: openProjectActivity, actor_id: ids.owner, kind: "project",
      text: `created the Website ${stamp} project`, project_id: openProject, conversation_id: null },
    { id: publicChannelActivity, actor_id: ids.owner, kind: "channel",
      text: `created #act-pub-${stamp}`, project_id: null, conversation_id: publicChannel },
    { id: secretProjectActivity, actor_id: ids.owner, kind: "project",
      text: SECRET_PROJECT_TEXT, project_id: secretProject, conversation_id: null },
    { id: privateChannelActivity, actor_id: ids.owner, kind: "channel",
      text: PRIVATE_CHANNEL_TEXT, project_id: null, conversation_id: privateChannel },
  ]);
  if (seeded.error) throw new Error(`seed activities failed: ${seeded.error.message}`);
});

afterAll(async () => {
  await serviceClient.from("activities").delete().in("id", [
    wideActivity, openProjectActivity, publicChannelActivity,
    secretProjectActivity, privateChannelActivity, ...insertedByOutsider,
  ]);
  await serviceClient.from("projects").delete().in("id", [openProject, secretProject]);
  await serviceClient.from("conversations").delete().in("id", [publicChannel, privateChannel]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("activities RLS: the feed only names what you can see", () => {
  it("gives an outsider the workspace-wide and open rows (positive control)", async () => {
    const client = await clientFor(emails.outsider);
    // A body select, not `select("*", { head: true })`: head-only returns
    // `error: null` even for a table that does not exist, so it would report
    // success against a schema without these columns at all.
    const { data, error } = await client
      .from("activities").select("id,text,project_id,conversation_id")
      .in("id", [wideActivity, openProjectActivity, publicChannelActivity]);

    expect(error).toBeNull();
    expect((data ?? []).map((a) => a.id).sort())
      .toEqual([openProjectActivity, publicChannelActivity, wideActivity].sort());
  });

  it("hides an activity naming a restricted project from an outsider", async () => {
    const client = await clientFor(emails.outsider);
    const { data, error } = await client
      .from("activities").select("id,text").eq("id", secretProjectActivity);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("hides an activity naming a private channel from an outsider", async () => {
    const client = await clientFor(emails.outsider);
    const { data, error } = await client
      .from("activities").select("id,text").eq("id", privateChannelActivity);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // The one that mirrors the actual bug: hydrate() does an unfiltered scan,
  // so the leak has to be closed there and not merely on a targeted lookup.
  it("keeps restricted names out of an UNFILTERED feed scan, while still returning the visible rows", async () => {
    const client = await clientFor(emails.outsider);
    const { data, error } = await client.from("activities").select("id,text");

    expect(error).toBeNull();
    const rows = data ?? [];
    const texts = rows.map((a) => a.text);
    expect(texts).not.toContain(SECRET_PROJECT_TEXT);
    expect(texts).not.toContain(PRIVATE_CHANNEL_TEXT);
    // Positive control on the same scan: a filter that returned nothing at all
    // would satisfy the two assertions above without protecting anything.
    const ids_ = rows.map((a) => a.id);
    expect(ids_).toContain(wideActivity);
    expect(ids_).toContain(openProjectActivity);
    expect(ids_).toContain(publicChannelActivity);
  });

  it("shows every scoped row to an admin, who can see both resources", async () => {
    const client = await clientFor(emails.owner);
    const { data, error } = await client
      .from("activities").select("id").in("id", [secretProjectActivity, privateChannelActivity]);

    expect(error).toBeNull();
    expect((data ?? []).map((a) => a.id).sort())
      .toEqual([privateChannelActivity, secretProjectActivity].sort());
  });
});

describe("activities RLS: the scope cannot be forged on insert", () => {
  it("lets an outsider write a workspace-wide activity (positive control)", async () => {
    const client = await clientFor(emails.outsider);
    const { error } = await client.from("activities").insert({
      id: insertedByOutsider[0], actor_id: ids.outsider, kind: "member",
      text: "changed their display name", project_id: null, conversation_id: null,
    });

    expect(error).toBeNull();
  });

  it("refuses an activity scoped to a project the caller cannot see", async () => {
    const client = await clientFor(emails.outsider);
    const { error } = await client.from("activities").insert({
      id: insertedByOutsider[1], actor_id: ids.outsider, kind: "project",
      text: "poked the payroll project", project_id: secretProject, conversation_id: null,
    });

    // 42501 — new row violates row-level security.
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("refuses an activity scoped to a conversation the caller cannot see", async () => {
    const client = await clientFor(emails.outsider);
    const { error } = await client.from("activities").insert({
      id: insertedByOutsider[2], actor_id: ids.outsider, kind: "channel",
      text: "poked the private channel", project_id: null, conversation_id: privateChannel,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("activities schema: a row names at most one thing", () => {
  // Guards the constraint the read policy's AND leans on. Written through the
  // service client because a check constraint binds every role, RLS or not.
  it("rejects a row carrying both a project and a conversation", async () => {
    const { error } = await serviceClient.from("activities").insert({
      id: `a_act_both_${stamp}`, actor_id: ids.owner, kind: "project",
      text: "two scopes", project_id: openProject, conversation_id: publicChannel,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain("activities_single_scope");
  });
});
