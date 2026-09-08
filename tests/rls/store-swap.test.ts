import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { createChannel, createProject, seedRoles } from "../helpers/workspace";

// Covers supabase/migrations/20260908000800_store_swap.sql: the profile-on-signup
// trigger, DM pair uniqueness + find_or_create_dm, the task position default,
// toggle_reaction, profiles.mfa_required, and the structure-only seed.
//
// Frugal by design, like every other file here: Supabase rate-limits
// signInWithPassword per project across the WHOLE `npm run test:rls` run and
// these files execute in parallel forks. Exactly TWO identities are ever signed
// in (an admin and a plain member); everything else is seeded with the service
// client or created through the auth admin API without ever authenticating.
// signInAs memoises by email, so clientFor is free after the first call.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const project = `p_ss_${stamp}`;
const publicChannel = `c_ss_pub_${stamp}`;
const privateChannel = `c_ss_priv_${stamp}`;
const openMessage = `m_ss_open_${stamp}`;
const secretMessage = `m_ss_secret_${stamp}`;

const emails = {
  admin: `ssadmin-${stamp}@lumina.test`,
  member: `ssmember-${stamp}@lumina.test`,
  mate: `ssmate-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

/** Auth users minted by a test rather than by createTestUser, so the trigger —
 *  not a fixture — is what creates their profile. Torn down in afterAll. */
const triggerUserIds: string[] = [];
/** DM conversations created through the RPC; cleaned up by conversation id,
 *  which cascades into dms and dm_members. */
const createdDmIds = new Set<string>();

async function createAuthUserOnly(email: string): Promise<string> {
  const { data, error } = await serviceClient.auth.admin.createUser({
    email, password: TEST_PASSWORD, email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createAuthUserOnly failed: ${error?.message}`);
  triggerUserIds.push(data.user.id);
  return data.user.id;
}

beforeAll(async () => {
  await seedRoles();

  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada", handle: `ssada${stamp}`, roleId: "admin",
  });
  // Plain Member: holds message.send / task.create / task.edit but NOT
  // members.manage, which short-circuits can_see_conversation and every
  // has_permission gate below. An admin fixture would clear them trivially.
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Milo", handle: `ssmilo${stamp}`, roleId: "member",
  });
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Mina", handle: `ssmina${stamp}`, roleId: "member",
  });

  await createProject({ id: project, name: "Board", restricted: false, createdBy: ids.admin });
  await createChannel({
    id: publicChannel, name: `ss-open-${stamp}`, isPrivate: false, createdBy: ids.admin,
  });
  await createChannel({
    id: privateChannel, name: `ss-shut-${stamp}`, isPrivate: true, createdBy: ids.admin,
  });
  const messages = await serviceClient.from("messages").insert([
    { id: openMessage, conversation_id: publicChannel, author_id: ids.admin, content: "ship it" },
    { id: secretMessage, conversation_id: privateChannel, author_id: ids.admin, content: "offer terms" },
  ]);
  if (messages.error) throw new Error(`seed messages failed: ${messages.error.message}`);

  // Warm both sessions here rather than lazily inside a test: signInAs's
  // rate-limit backoff can span ~45s, which fits this hook's 60s allowance but
  // not a test's 30s one.
  await clientFor(emails.admin);
  await clientFor(emails.member);
});

afterAll(async () => {
  await serviceClient.from("projects").delete().eq("id", project);
  await serviceClient.from("conversations").delete().in("id", [
    publicChannel, privateChannel, ...createdDmIds,
  ]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
  for (const id of triggerUserIds) await deleteTestUser(id);
});

describe("handle_new_user", () => {
  it("creates a Member profile for a new auth user with no manual insert", async () => {
    const email = `sstrig-${stamp}@lumina.test`;
    const userId = await createAuthUserOnly(email);

    // Body select, never `.select("*", { head: true })`: a head request returns
    // error === null and count === null even for a table that does not exist,
    // so only a body select can distinguish "no row" from "no table".
    const { data, error } = await serviceClient
      .from("profiles")
      .select("id,email,name,handle,role_id,mfa_required")
      .eq("id", userId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    const profile = data![0];
    expect(profile.role_id).toBe("member");
    expect(profile.email).toBe(email);
    expect(profile.mfa_required).toBe(false);
    // name and handle both derive from the email's local part.
    expect(profile.handle).toBe(`sstrig${stamp}`);
    expect(profile.name).toBe(`Sstrig ${stamp}`);
  });

  it("gives two people who share an email local part different handles", async () => {
    const local = `ssdupe${stamp}`;
    const first = await createAuthUserOnly(`${local}@one.test`);
    const second = await createAuthUserOnly(`${local}@two.test`);

    const { data } = await serviceClient
      .from("profiles").select("id,handle").in("id", [first, second]);
    expect(data).toHaveLength(2);

    const handles = Object.fromEntries((data ?? []).map((p) => [p.id, p.handle]));
    expect(handles[first]).toBe(local);
    // The counter suffix, not a truncation or a silent failure: the second
    // profile exists AND carries a different, still-derived handle.
    expect(handles[second]).toBe(`${local}2`);
    expect(handles[first]).not.toBe(handles[second]);
  });
});

describe("find_or_create_dm", () => {
  it("yields exactly one DM when two calls for the same pair race", async () => {
    const client = await clientFor(emails.member);

    const [a, b] = await Promise.all([
      client.rpc("find_or_create_dm", { other_user_id: ids.mate }),
      client.rpc("find_or_create_dm", { other_user_id: ids.mate }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(typeof a.data).toBe("string");
    expect(b.data).toBe(a.data);
    createdDmIds.add(a.data as string);

    // The real assertion: one DM row for this pair, not two. Counted from the
    // membership table, which is the source of truth, rather than from the
    // derived pair_key the implementation happens to use.
    const { data: mine } = await serviceClient
      .from("dm_members").select("dm_id").eq("user_id", ids.member);
    const { data: theirs } = await serviceClient
      .from("dm_members").select("dm_id").eq("user_id", ids.mate);
    const shared = (mine ?? [])
      .map((r) => r.dm_id)
      .filter((id) => (theirs ?? []).some((r) => r.dm_id === id));
    expect(shared).toEqual([a.data]);
  });

  it("returns the same thread on a later call instead of a second one", async () => {
    const client = await clientFor(emails.member);
    const { data, error } = await client.rpc("find_or_create_dm", { other_user_id: ids.mate });
    expect(error).toBeNull();
    expect(createdDmIds.has(data as string)).toBe(true);
  });

  it("refuses a DM with someone who is not on the team", async () => {
    const client = await clientFor(emails.member);
    const { error } = await client.rpc("find_or_create_dm", {
      other_user_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not on this team/i);
  });

  it("refuses a DM with yourself", async () => {
    const client = await clientFor(emails.member);
    const { error } = await client.rpc("find_or_create_dm", { other_user_id: ids.member });
    expect(error).not.toBeNull();
  });
});

describe("task position default", () => {
  it("appends a task with no position to the end of its column", async () => {
    const first = `t_ss_a_${stamp}`;
    const second = `t_ss_b_${stamp}`;
    const appended = `t_ss_c_${stamp}`;

    const seeded = await serviceClient.from("tasks").insert([
      { id: first, project_id: project, title: "First", status: "todo", position: 0 },
      { id: second, project_id: project, title: "Second", status: "todo", position: 1 },
    ]);
    expect(seeded.error).toBeNull();

    // No `position` key at all — the whole point of the trigger.
    const { error } = await serviceClient
      .from("tasks").insert({ id: appended, project_id: project, title: "Third", status: "todo" });
    expect(error).toBeNull();

    const { data } = await serviceClient
      .from("tasks").select("position").eq("id", appended).single();
    expect(data?.position).toBe(2);
  });

  it("starts a different column of the same project back at zero", async () => {
    const id = `t_ss_other_${stamp}`;
    await serviceClient
      .from("tasks").insert({ id, project_id: project, title: "Elsewhere", status: "done" });
    const { data } = await serviceClient
      .from("tasks").select("position").eq("id", id).single();
    // Scoped to (project_id, status): the three todo tasks above must not
    // push this one to 3.
    expect(data?.position).toBe(0);
  });

  it("respects an explicitly supplied position, including 0", async () => {
    const id = `t_ss_explicit_${stamp}`;
    await serviceClient.from("tasks").insert({
      id, project_id: project, title: "Jump the queue", status: "todo", position: 0,
    });
    const { data } = await serviceClient
      .from("tasks").select("position").eq("id", id).single();
    // A default that swallowed an explicit 0 would report 3 here. This is what
    // separates a real sentinel from "treat 0 as unset".
    expect(data?.position).toBe(0);
  });
});

describe("toggle_reaction", () => {
  type ToggleResult = { added: boolean; user_ids: string[]; count: number; emoji: string };

  it("adds a reaction, then removes it, reporting the resulting state", async () => {
    const client = await clientFor(emails.member);

    const add = await client.rpc("toggle_reaction", { message_id: openMessage, emoji: "🎉" });
    expect(add.error).toBeNull();
    const added = add.data as unknown as ToggleResult;
    expect(added.added).toBe(true);
    expect(added.user_ids).toEqual([ids.member]);
    expect(added.count).toBe(1);

    const { data: present } = await serviceClient
      .from("reactions").select("user_id").eq("message_id", openMessage).eq("emoji", "🎉");
    expect(present).toHaveLength(1);

    const remove = await client.rpc("toggle_reaction", { message_id: openMessage, emoji: "🎉" });
    expect(remove.error).toBeNull();
    const removed = remove.data as unknown as ToggleResult;
    expect(removed.added).toBe(false);
    expect(removed.user_ids).toEqual([]);
    expect(removed.count).toBe(0);

    const { data: gone } = await serviceClient
      .from("reactions").select("user_id").eq("message_id", openMessage).eq("emoji", "🎉");
    expect(gone).toHaveLength(0);
  });

  it("refuses a message in a private channel the caller is not in", async () => {
    const client = await clientFor(emails.member);

    // Positive control on the same client and the same RPC: the denial below
    // must be the visibility rule, not a broken call. Toggled straight back so
    // the suite leaves no reaction behind.
    const control = await client.rpc("toggle_reaction", { message_id: openMessage, emoji: "👀" });
    expect(control.error).toBeNull();
    await client.rpc("toggle_reaction", { message_id: openMessage, emoji: "👀" });

    const { error } = await client.rpc("toggle_reaction", {
      message_id: secretMessage, emoji: "👀",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not found or not visible/i);

    // And nothing was written on the way to being refused.
    const { data } = await serviceClient
      .from("reactions").select("user_id").eq("message_id", secretMessage);
    expect(data).toHaveLength(0);
  });
});

describe("profiles.mfa_required", () => {
  it("denies a non-admin setting it on someone else", async () => {
    const client = await clientFor(emails.member);
    // profiles_update_self restricts this to the caller's own row, and an
    // UPDATE filtered away by USING reports no error at all — so the surviving
    // value is the assertion, never `error`.
    await client.from("profiles").update({ mfa_required: true }).eq("id", ids.mate);

    const { data } = await serviceClient
      .from("profiles").select("mfa_required").eq("id", ids.mate).single();
    expect(data?.mfa_required).toBe(false);
  });

  it("denies a non-admin clearing or setting it on THEMSELVES", async () => {
    // Seeded through the service client, which the trigger deliberately lets
    // through, so there is a real value to try to clear.
    await serviceClient.from("profiles").update({ mfa_required: true }).eq("id", ids.member);

    const client = await clientFor(emails.member);
    // profiles_update_self ALLOWS this row, so the policy cannot be what stops
    // it — only guard_mfa_required can, and P0001 proves it was the trigger.
    const { error } = await client
      .from("profiles").update({ mfa_required: false }).eq("id", ids.member);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("P0001");

    const { data } = await serviceClient
      .from("profiles").select("mfa_required").eq("id", ids.member).single();
    expect(data?.mfa_required).toBe(true);
  });

  it("still lets that member update the rest of their own row", async () => {
    // Positive control for the two denials above: profiles_update_self is
    // intact, so the refusals are about this one column and not about the
    // member having lost the ability to write their own profile.
    const client = await clientFor(emails.member);
    const { error } = await client
      .from("profiles").update({ title: "Staff Engineer" }).eq("id", ids.member);
    expect(error).toBeNull();

    const { data } = await serviceClient
      .from("profiles").select("title").eq("id", ids.member).single();
    expect(data?.title).toBe("Staff Engineer");
  });

  it("lets a holder of members.manage set it on a teammate", async () => {
    const client = await clientFor(emails.admin);
    const { error } = await client
      .from("profiles").update({ mfa_required: true }).eq("id", ids.mate);
    expect(error).toBeNull();

    const { data } = await serviceClient
      .from("profiles").select("mfa_required").eq("id", ids.mate).single();
    expect(data?.mfa_required).toBe(true);
  });
});

describe("structure-only seed", () => {
  it("has exactly one team channel, named general", async () => {
    const { data, error } = await serviceClient
      .from("channels").select("id,name,is_private").eq("is_team", true);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe("c_general");
    expect(data![0].name).toBe("general");
    expect(data![0].is_private).toBe(false);
  });

  it("refuses a second team channel", async () => {
    const id = `c_ss_team_${stamp}`;
    await serviceClient.from("conversations").insert({ id, kind: "channel" });
    const { error } = await serviceClient.from("channels").insert({
      id, name: "general-2", description: "", is_private: false, is_team: true,
      created_by: ids.admin,
    });
    // 23505: the partial unique index, not a policy — this holds even for the
    // service client.
    expect(error?.code).toBe("23505");
    await serviceClient.from("conversations").delete().eq("id", id);
  });

  it("has the three system roles and no duplicates", async () => {
    const { data } = await serviceClient.from("roles").select("id,is_system").eq("is_system", true);
    expect((data ?? []).map((r) => r.id).sort()).toEqual(["admin", "guest", "member"]);
  });

  it("seeded structure only — the general channel has no members and no messages", async () => {
    // The user's decision for this plan was STRUCTURE ONLY: no fictional
    // people, tasks or messages. Asserted against the seeded channel
    // specifically rather than against a global row count, because the RLS
    // files run in parallel forks and each is creating its own fixtures while
    // this one runs.
    const { data: members, error: memberError } = await serviceClient
      .from("channel_members").select("user_id").eq("channel_id", "c_general");
    expect(memberError).toBeNull();
    expect(members).toEqual([]);

    const { data: messages, error: messageError } = await serviceClient
      .from("messages").select("id").eq("conversation_id", "c_general");
    expect(messageError).toBeNull();
    expect(messages).toEqual([]);

    // And it is not attributed to an invented author.
    const { data: channel } = await serviceClient
      .from("channels").select("created_by").eq("id", "c_general").single();
    expect(channel?.created_by).toBeNull();
  });
});
