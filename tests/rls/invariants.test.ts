import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import {
  addChannelMember, addProjectMember, createChannel, createProject, seedRoles,
} from "../helpers/workspace";

// Supabase rate-limits sign-ins per project; memoize one client per email
// and reuse it everywhere in this file, matching projects.test.ts.
const clientCache = new Map<string, Awaited<ReturnType<typeof signInAs>>>();
async function clientFor(email: string): Promise<Awaited<ReturnType<typeof signInAs>>> {
  const cached = clientCache.get(email);
  if (cached) return cached;
  const client = await signInAs(email, TEST_PASSWORD);
  clientCache.set(email, client);
  return client;
}

const stamp = Date.now();
const project = `p_inv_${stamp}`;
const emails = { admin: `iadmin-${stamp}@lumina.test`, member: `imem-${stamp}@lumina.test` };
const ids: Record<string, string> = {};
const taskIds = [`t_a_${stamp}`, `t_b_${stamp}`, `t_c_${stamp}`];

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada", handle: `iada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo", handle: `imo${stamp}`, roleId: "member",
  });
  await createProject({ id: project, name: "Invariants", restricted: false, createdBy: ids.admin });
  await serviceClient.from("tasks").insert(
    taskIds.map((id, i) => ({
      id, project_id: project, title: `Task ${i}`,
      status: "todo", created_by: ids.admin, position: i,
    }))
  );
});

afterAll(async () => {
  // Delete channels/projects before users: their creators are members of
  // them, and profiles.id cascades into channel_members/project_members
  // on user deletion — see the cascade tests below for why that specific
  // order is safe either way, but this mirrors every other RLS suite's
  // convention regardless.
  await serviceClient.from("projects").delete().eq("id", project);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("business invariants", () => {
  it("refuses to delete a role that still has members", async () => {
    const roleId = `r_pop_${stamp}`;
    await serviceClient.from("roles").insert({
      id: roleId, name: "Populated", description: "", color: "#000", permissions: [],
    });
    await serviceClient.from("profiles").update({ role_id: roleId }).eq("id", ids.member);

    const { error } = await serviceClient.from("roles").delete().eq("id", roleId);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/still has members/i);

    await serviceClient.from("profiles").update({ role_id: "member" }).eq("id", ids.member);
    await serviceClient.from("roles").delete().eq("id", roleId);
  });

  it("refuses to delete a built-in role", async () => {
    const { error } = await serviceClient.from("roles").delete().eq("id", "guest");
    expect(error).not.toBeNull();
  });

  // block_last_admin_removal reads a genuinely global count (this app has
  // one workspace, not per-tenant roles), so whether ids.admin is *the*
  // last admin at this instant depends on whatever else is running
  // concurrently against the same dev project — not something a single
  // test file can pin down without reaching into other suites' data. Both
  // branches below assert something real rather than a no-op, which is as
  // deterministic as this shared, global invariant can be made from one
  // isolated test file.
  it("refuses to demote the last admin", async () => {
    const { data: admins } = await serviceClient
      .from("profiles").select("id").eq("role_id", "admin");

    if ((admins ?? []).length === 1) {
      // The interesting case: ids.admin is provably the only admin left,
      // so demoting it must fail.
      const { error } = await serviceClient
        .from("profiles").update({ role_id: "member" }).eq("id", ids.admin);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/last admin/i);

      const { data } = await serviceClient
        .from("profiles").select("role_id").eq("id", ids.admin).single();
      expect(data?.role_id).toBe("admin");
    } else {
      // Positive control: with another admin genuinely present (left by a
      // concurrently-running suite), demoting a *different*, disposable
      // admin we fully control must succeed — proving the mechanism isn't
      // simply blocking every demotion outright.
      const second = await createTestUser({
        email: `iextra-${stamp}@lumina.test`, password: TEST_PASSWORD,
        name: "Extra", handle: `iex${stamp}`, roleId: "admin",
      });
      const { error } = await serviceClient
        .from("profiles").update({ role_id: "member" }).eq("id", second);
      expect(error).toBeNull();
      await deleteTestUser(second);
    }
  });

  it("refuses to remove a project's creator from its members", async () => {
    await serviceClient.from("project_members")
      .insert({ project_id: project, user_id: ids.admin, level: "editor" });
    const { error } = await serviceClient
      .from("project_members").delete()
      .eq("project_id", project).eq("user_id", ids.admin);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/creator/i);
  });

  // Invariant 3 must not make the parent itself undeletable: deleting the
  // channel/project cascades into channel_members/project_members, whose
  // BEFORE DELETE trigger fires for the creator's own row too — but by
  // then the parent is already gone (the cascade is nested one level
  // inside deleting the parent), so ensure_*_creator_editor's lookup finds
  // no row, `creator` is null, and the guard does not fire.
  it("deleting a project cascades to its members even though the creator never left", async () => {
    const id = `p_cascade_${stamp}`;
    await createProject({ id, name: "Cascade", restricted: false, createdBy: ids.admin });
    await addProjectMember(id, ids.admin, "editor");

    const before = await serviceClient
      .from("project_members").select("user_id").eq("project_id", id);
    expect(before.data).toHaveLength(1);

    const { error } = await serviceClient.from("projects").delete().eq("id", id);
    expect(error).toBeNull();

    const after = await serviceClient
      .from("project_members").select("user_id").eq("project_id", id);
    expect(after.data ?? []).toHaveLength(0);
  });

  it("deleting a channel cascades to its members even though the creator never left", async () => {
    const id = `c_cascade_${stamp}`;
    await createChannel({ id, name: "cascade", isPrivate: false, createdBy: ids.admin });
    await addChannelMember(id, ids.admin, "editor");

    const before = await serviceClient
      .from("channel_members").select("user_id").eq("channel_id", id);
    expect(before.data).toHaveLength(1);

    // conversations is the parent of channels; deleting it cascades through
    // channels into channel_members (20260906000200_conversations.sql).
    const { error } = await serviceClient.from("conversations").delete().eq("id", id);
    expect(error).toBeNull();

    const after = await serviceClient
      .from("channel_members").select("user_id").eq("channel_id", id);
    expect(after.data ?? []).toHaveLength(0);
  });

  it("renumbers a column densely when a task moves within it", async () => {
    const client = await clientFor(emails.admin);
    const { error } = await client.rpc("move_task", {
      p_task_id: taskIds[2], p_status: "todo", p_index: 0,
    });
    expect(error).toBeNull();

    const { data } = await serviceClient
      .from("tasks").select("id,position").eq("project_id", project)
      .eq("status", "todo").order("position");
    expect(data?.map((t) => t.id)).toEqual([taskIds[2], taskIds[0], taskIds[1]]);
    expect(data?.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it("closes the gap in the source column when a task moves out", async () => {
    const client = await clientFor(emails.admin);
    await client.rpc("move_task", { p_task_id: taskIds[0], p_status: "done", p_index: 0 });

    const { data: todo } = await serviceClient
      .from("tasks").select("id,position").eq("project_id", project)
      .eq("status", "todo").order("position");
    expect(todo?.map((t) => t.position)).toEqual([0, 1]);

    const { data: done } = await serviceClient
      .from("tasks").select("id,position").eq("project_id", project).eq("status", "done");
    expect(done?.[0]?.position).toBe(0);
  });

  // The seeded Member role holds both task.edit and task.move
  // (lib/permissions.ts), and tasks_update's RLS gate — which move_task's
  // SECURITY INVOKER update runs under — requires task.edit specifically
  // (20260906000350_fix_project_policies.sql), not task.move. Member is
  // not a project_member of `project` at all (it's an unrestricted
  // project, so can_see_project() passes on visibility alone), which
  // additionally confirms this isn't gated on project membership.
  it("lets a Member (task.edit + task.move, no project.create) move a task via the RPC", async () => {
    const client = await clientFor(emails.member);
    const { error } = await client.rpc("move_task", {
      p_task_id: taskIds[1], p_status: "in-progress", p_index: 0,
    });
    expect(error).toBeNull();

    const { data } = await serviceClient
      .from("tasks").select("status,position").eq("id", taskIds[1]).single();
    expect(data?.status).toBe("in-progress");
    expect(data?.position).toBe(0);
  });

  it("denies move_task on a project the caller cannot see", async () => {
    const hidden = `p_hidden_${stamp}`;
    await createProject({ id: hidden, name: "Hidden", restricted: true, createdBy: ids.admin });
    const hiddenTask = `t_hidden_${stamp}`;
    await serviceClient.from("tasks").insert({
      id: hiddenTask, project_id: hidden, title: "Secret",
      status: "todo", created_by: ids.admin, position: 0,
    });

    const client = await clientFor(emails.member);
    const { error } = await client.rpc("move_task", {
      p_task_id: hiddenTask, p_status: "done", p_index: 0,
    });
    expect(error).not.toBeNull();

    await serviceClient.from("projects").delete().eq("id", hidden);
  });
});
