import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient, createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import {
  addProjectMember, addTaskCollaborator, createProject, removeProjectMember, seedRoles,
} from "../helpers/workspace";

// Supabase rate-limits sign-ups and sign-ins per IP across the WHOLE rls run,
// and the seven files here run in parallel forks against one project — so
// this file is deliberately frugal: five fixture users, and only three of
// them are ever signed in. signInAs itself now memoises by email and
// retries the rate-limit error with backoff (see tests/helpers/supabase.ts),
// so this file just calls it directly under the `clientFor` name it already
// used everywhere below.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const openProject = `p_tc_open_${stamp}`;
const secretProject = `p_tc_secret_${stamp}`;
// Restricted, created by `outsider`, and deliberately given NO project_members
// rows at all — the creator-parity case from the ledger's Task 2 ruling.
// `outsider` does double duty (an outsider to secretProject, the lone creator
// of this one) purely to spend one fewer sign-in against the shared limit.
const loneProject = `p_tc_lone_${stamp}`;

const secretTask = `t_tc_secret_${stamp}`;
const openTask = `t_tc_open_${stamp}`;
const loneTask = `t_tc_lone_${stamp}`;
const promoteTask = `t_tc_promote_${stamp}`;

const emails = {
  editor: `tced-${stamp}@lumina.test`,
  viewer: `tcview-${stamp}@lumina.test`,
  outsider: `tcout-${stamp}@lumina.test`,
  owner: `tcowner-${stamp}@lumina.test`,
  collab: `tccollab-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();

  // Every fixture holds the seeded Member role: task.edit yes, members.manage
  // no. That matters — members.manage short-circuits can_see_project /
  // project_is_viewer_only / user_can_see_project to true, so an admin fixture
  // would clear every gate below trivially and prove nothing about the
  // policies themselves.
  for (const who of ["editor", "viewer", "outsider", "owner", "collab"] as const) {
    ids[who] = await createTestUser({
      email: emails[who], password: TEST_PASSWORD,
      name: who, handle: `tc${who}${stamp}`, roleId: "member",
    });
  }

  await createProject({ id: openProject, name: "Website", restricted: false, createdBy: ids.owner });
  await createProject({ id: secretProject, name: "Acquisition", restricted: true, createdBy: ids.owner });
  await createProject({ id: loneProject, name: "Solo", restricted: true, createdBy: ids.outsider });

  await addProjectMember(secretProject, ids.editor, "editor");
  await addProjectMember(secretProject, ids.viewer, "viewer");
  await addProjectMember(secretProject, ids.owner, "editor");
  await addProjectMember(secretProject, ids.collab, "editor");
  // loneProject intentionally gets none, not even its creator.

  const tasks = await serviceClient.from("tasks").insert([
    { id: secretTask, project_id: secretProject, title: "Draft the offer",
      assignee_id: ids.owner, created_by: ids.owner, position: 0 },
    { id: openTask, project_id: openProject, title: "Public work",
      created_by: ids.owner, position: 0 },
    { id: loneTask, project_id: loneProject, title: "Solo work",
      created_by: ids.outsider, position: 0 },
  ]);
  if (tasks.error) throw new Error(`seed tasks failed: ${tasks.error.message}`);

  await addTaskCollaborator(secretTask, ids.collab);

  // Warm all three sessions here rather than lazily inside the tests. The
  // retry budget above can span ~45s when the shared auth limit is saturated,
  // which fits this hook's 60s allowance but not a test's 30s one — and doing
  // them sequentially, in one place, keeps this file's burst as small and as
  // late as it can be.
  for (const email of [emails.editor, emails.viewer, emails.outsider]) {
    await clientFor(email);
  }
});

afterAll(async () => {
  await serviceClient.from("projects").delete().in("id", [openProject, secretProject, loneProject]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("task_collaborators RLS", () => {
  it("hides a restricted project's collaborator rows from an outsider", async () => {
    const editorClient = await clientFor(emails.editor);
    const outsiderClient = await clientFor(emails.outsider);

    // Positive control: a real editor member of the project reads the row,
    // proving the query and the read policy work at all before a denial of
    // the same shape is asserted.
    const { data: asMember } = await editorClient
      .from("task_collaborators").select("user_id").eq("task_id", secretTask);
    expect(asMember).toHaveLength(1);

    const { data: targeted } = await outsiderClient
      .from("task_collaborators").select("user_id").eq("task_id", secretTask);
    expect(targeted).toHaveLength(0);

    // Unfiltered sweep too: an outsider who never names the task must not
    // find it by scanning the whole table.
    const { data: swept } = await outsiderClient.from("task_collaborators").select("task_id");
    expect((swept ?? []).some((r) => r.task_id === secretTask)).toBe(false);
  });

  it("lets a member with task.edit add a collaborator who can see the project", async () => {
    const client = await clientFor(emails.editor);
    const { error } = await client
      .from("task_collaborators").insert({ task_id: secretTask, user_id: ids.editor });
    expect(error).toBeNull();

    const { data } = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", secretTask).eq("user_id", ids.editor);
    expect(data).toHaveLength(1);

    const cleanup = await serviceClient.from("task_collaborators")
      .delete().eq("task_id", secretTask).eq("user_id", ids.editor);
    expect(cleanup.error).toBeNull();
  });

  it("refuses a collaborator who cannot see the project (trigger, not policy)", async () => {
    const client = await clientFor(emails.editor);
    const { error } = await client
      .from("task_collaborators").insert({ task_id: secretTask, user_id: ids.outsider });
    expect(error).not.toBeNull();
    // P0001 is a plpgsql raise; 42501 would mean the RLS policy stopped it.
    // The inserting editor clears every policy bar here — task.edit, project
    // visible, not viewer-only — so only the invariant trigger can be what
    // refuses, and asserting the code proves that is what happened.
    expect(error?.code).toBe("P0001");

    const { data } = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", secretTask).eq("user_id", ids.outsider);
    expect(data).toHaveLength(0);
  });

  it("refuses adding the task's own owner as a collaborator", async () => {
    const client = await clientFor(emails.editor);
    const { error } = await client
      .from("task_collaborators").insert({ task_id: secretTask, user_id: ids.owner });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("P0001");

    const { data } = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", secretTask).eq("user_id", ids.owner);
    expect(data).toHaveLength(0);
  });

  it("drops the collaborator row when that collaborator is promoted to owner", async () => {
    await serviceClient.from("tasks").insert({
      id: promoteTask, project_id: secretProject, title: "Promote me",
      assignee_id: ids.owner, created_by: ids.owner, position: 1,
    });
    await addTaskCollaborator(promoteTask, ids.editor);

    const before = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", promoteTask);
    expect(before.data).toHaveLength(1);

    const client = await clientFor(emails.editor);
    const { error } = await client.from("tasks")
      .update({ assignee_id: ids.editor }).eq("id", promoteTask);
    expect(error).toBeNull();

    const after = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", promoteTask);
    expect(after.data).toHaveLength(0);

    await serviceClient.from("tasks").delete().eq("id", promoteTask);
  });

  it("denies a viewer-only member adding a collaborator, despite holding task.edit", async () => {
    const client = await clientFor(emails.viewer);

    // Positive control: the viewer really can see this task's collaborator
    // rows, so the denial below is the insert bar rather than a blanket lack
    // of visibility.
    const { data: visible } = await client
      .from("task_collaborators").select("user_id").eq("task_id", secretTask);
    expect(visible).toHaveLength(1);

    // Adding THEMSELVES: they can see the project and are not the task's
    // owner, so the invariant trigger has nothing to object to and there is
    // no pre-existing row to collide with — the only thing that can refuse
    // is the viewer-only exclusion in task_collaborators_insert.
    const { error } = await client
      .from("task_collaborators").insert({ task_id: secretTask, user_id: ids.viewer });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");

    const { data } = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", secretTask).eq("user_id", ids.viewer);
    expect(data).toHaveLength(0);
  });

  it("has no update policy at all — a collaborator row cannot be rewritten in place", async () => {
    const client = await clientFor(emails.editor);

    // Rewriting user_id in place would swap a legitimate collaborator for
    // anyone at all while only the pre-image was ever checked, bypassing the
    // insert trigger entirely. Attempted by an editor who holds every
    // insert/delete right on this task, so a refusal can only be the absent
    // update policy.
    await client.from("task_collaborators")
      .update({ user_id: ids.outsider }).eq("task_id", secretTask).eq("user_id", ids.collab);

    const { data } = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", secretTask);
    expect((data ?? []).map((r) => r.user_id)).toEqual([ids.collab]);

    // Positive control: the same client CAN delete and re-insert that row, so
    // the frozen update above is the missing policy, not a broken client or
    // an unwritable table.
    const del = await client.from("task_collaborators")
      .delete().eq("task_id", secretTask).eq("user_id", ids.collab);
    expect(del.error).toBeNull();
    const { data: gone } = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", secretTask);
    expect(gone).toHaveLength(0);

    const re = await client.from("task_collaborators")
      .insert({ task_id: secretTask, user_id: ids.collab });
    expect(re.error).toBeNull();
  });

  it("denies an outsider deleting a collaborator row they cannot see", async () => {
    const client = await clientFor(emails.outsider);
    // A DELETE denied by a USING clause matches zero rows and reports no
    // error at all, so the row's survival is the assertion.
    await client.from("task_collaborators")
      .delete().eq("task_id", secretTask).eq("user_id", ids.collab);

    const { data } = await serviceClient.from("task_collaborators")
      .select("user_id").eq("task_id", secretTask);
    expect(data).toHaveLength(1);
  });

  // --- can_see_project / user_can_see_project creator parity. Ledger ruling
  // from Task 2: lib/store.tsx:245 gained a creator clause and the SQL side
  // had none, so a creator absent from project_members saw the project in the
  // UI and got zero rows from the API. ---

  it("shows a restricted project to its own creator even with no project_members row", async () => {
    // Guard the fixture: if the creator ever gained a membership row this
    // would pass through the ordinary member branch and prove nothing.
    const { data: members } = await serviceClient
      .from("project_members").select("user_id").eq("project_id", loneProject);
    expect(members).toHaveLength(0);

    const client = await clientFor(emails.outsider);
    const { data } = await client.from("projects").select("id").eq("id", loneProject);
    expect(data).toHaveLength(1);

    // Negative control, same table and query shape: a signed-in user who is
    // neither creator nor member still cannot see it, so the visibility above
    // is the creator clause and not the project quietly becoming public.
    const otherClient = await clientFor(emails.viewer);
    const { data: hidden } = await otherClient
      .from("projects").select("id").eq("id", loneProject);
    expect(hidden).toHaveLength(0);
  });

  it("lets that creator read collaborator rows on their own restricted project, while writes stay viewer-only", async () => {
    const client = await clientFor(emails.outsider);

    // The boundary this migration deliberately does NOT move, asserted first
    // because it needs a task with no collaborator row yet. Parity was
    // required for VISIBILITY (can_see_project / user_can_see_project);
    // project_is_viewer_only is left exactly as it was — which is itself
    // parity, because lib/store.tsx's projectIsViewerOnly (lines 206-210) has
    // no creator clause either. So a creator holding no editor membership row
    // can see their restricted project but cannot write to its tasks, on both
    // sides. Giving the creator a bypass here would widen a function shared
    // by tasks_insert / tasks_update / task_attachments, far beyond this
    // task's scope.
    //
    // The person being added is the creator themselves, deliberately: they
    // pass the insert trigger (they can see the project, and are not the
    // task's owner), so the refusal can only come from the policy's
    // viewer-only exclusion. That distinction matters because a BEFORE INSERT
    // trigger runs BEFORE the RLS WITH CHECK is evaluated — naming someone
    // the trigger rejects would raise P0001 and never reach the policy at all.
    const write = await client
      .from("task_collaborators").insert({ task_id: loneTask, user_id: ids.outsider });
    expect(write.error?.code).toBe("42501");

    // Now seeded service-side: this is what exercises user_can_see_project's
    // creator branch from inside the insert trigger — the person being added
    // is the project's creator with no membership row to fall back on, so only
    // that branch can satisfy the trigger's visibility check. Without the
    // creator clause this helper would throw P0001.
    await addTaskCollaborator(loneTask, ids.outsider);

    const { data } = await client
      .from("task_collaborators").select("user_id").eq("task_id", loneTask);
    expect(data).toHaveLength(1);

    const otherClient = await clientFor(emails.viewer);
    const { data: hidden } = await otherClient
      .from("task_collaborators").select("user_id").eq("task_id", loneTask);
    expect(hidden).toHaveLength(0);
  });

  it("keeps an anonymous client out entirely", async () => {
    // A collaborator row on the OPEN project: readable by any signed-in user,
    // so if anon can read anything at all it will be this one.
    await addTaskCollaborator(openTask, ids.collab);

    // Measured this session, refining progress.md's caution: a head request
    // returns error === null against a table that does not exist even WITH
    // `count: "exact"` (count comes back null, status 204) — the count option
    // is not itself the fix. What actually discriminates is that `count` is a
    // NUMBER only when the table exists and was really queried. So the
    // assertions below compare strictly and never coalesce with `?? 0`, and
    // the signed-in control proves the row is genuinely there to be leaked.
    const control = await (await clientFor(emails.outsider))
      .from("task_collaborators").select("*", { count: "exact", head: true })
      .eq("task_id", openTask);
    expect(control.error).toBeNull();
    expect(control.count).toBe(1);

    const anon = anonClient();
    const seen = await anon
      .from("task_collaborators").select("*", { count: "exact", head: true })
      .eq("task_id", openTask);
    expect(seen.count).toBe(0);

    const write = await anon
      .from("task_collaborators").insert({ task_id: openTask, user_id: ids.owner });
    expect(write.error).not.toBeNull();

    await serviceClient.from("task_collaborators").delete().eq("task_id", openTask);
  });
});

// ---------------------------------------------------------------------
// F4 (final-review.md) — "assignment never grants access" was enforced for
// the collaborator slot (check_task_collaborator above) but not the owner
// slot: tasks.assignee_id could be set to someone who cannot see the
// project, on both insert and update. 20260907000700_assignee_visibility.sql
// adds tasks_check_assignee to close this the same way.
// ---------------------------------------------------------------------
describe("tasks.assignee_id visibility trigger (F4)", () => {
  const assigneeInsertTask = `t_tc_assignee_ins_${stamp}`;
  const assigneeUpdateTask = `t_tc_assignee_upd_${stamp}`;

  afterAll(async () => {
    await serviceClient.from("tasks").delete()
      .in("id", [assigneeInsertTask, assigneeUpdateTask]);
  });

  it("refuses creating a task whose assignee cannot see the project", async () => {
    const client = await clientFor(emails.editor);
    const { error } = await client.from("tasks").insert({
      id: assigneeInsertTask, project_id: secretProject, title: "Bad assignee",
      assignee_id: ids.outsider, created_by: ids.editor, position: 5,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("P0001");

    const { data } = await serviceClient
      .from("tasks").select("id").eq("id", assigneeInsertTask);
    expect(data).toHaveLength(0);
  });

  it("lets a task be created with an assignee who can see the project", async () => {
    const client = await clientFor(emails.editor);
    const { error } = await client.from("tasks").insert({
      id: assigneeInsertTask, project_id: secretProject, title: "Fine assignee",
      assignee_id: ids.editor, created_by: ids.editor, position: 5,
    });
    expect(error).toBeNull();

    const { data } = await serviceClient
      .from("tasks").select("assignee_id").eq("id", assigneeInsertTask);
    expect(data).toHaveLength(1);
    expect(data?.[0].assignee_id).toBe(ids.editor);
  });

  it("refuses reassigning an existing task to someone who cannot see the project", async () => {
    await serviceClient.from("tasks").insert({
      id: assigneeUpdateTask, project_id: secretProject, title: "Reassign me",
      assignee_id: ids.owner, created_by: ids.owner, position: 6,
    });

    const client = await clientFor(emails.editor);
    const { error } = await client.from("tasks")
      .update({ assignee_id: ids.outsider }).eq("id", assigneeUpdateTask);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("P0001");

    const { data } = await serviceClient
      .from("tasks").select("assignee_id").eq("id", assigneeUpdateTask).single();
    expect(data?.assignee_id).toBe(ids.owner);
  });
});

// ---------------------------------------------------------------------
// F2 (final-review.md) — revoking a user's project_members row used to
// leave their task_collaborators rows behind. project_members_prune_
// collaborators (20260907000700_assignee_visibility.sql) deletes them.
// ---------------------------------------------------------------------
describe("project_members delete prunes stray task_collaborators (F2)", () => {
  const pruneProject = `p_tc_prune_${stamp}`;
  const pruneTask = `t_tc_prune_${stamp}`;

  afterAll(async () => {
    await serviceClient.from("projects").delete().eq("id", pruneProject);
  });

  it("deletes a revoked member's collaborator row, leaving another member's row intact", async () => {
    await createProject({ id: pruneProject, name: "Prune", restricted: true, createdBy: ids.owner });
    await addProjectMember(pruneProject, ids.viewer, "viewer");
    await addProjectMember(pruneProject, ids.editor, "editor");
    await serviceClient.from("tasks").insert({
      id: pruneTask, project_id: pruneProject, title: "Shared", created_by: ids.owner, position: 0,
    });
    await addTaskCollaborator(pruneTask, ids.viewer);
    await addTaskCollaborator(pruneTask, ids.editor);

    const before = await serviceClient
      .from("task_collaborators").select("user_id").eq("task_id", pruneTask);
    expect((before.data ?? []).map((r) => r.user_id).sort()).toEqual(
      [ids.editor, ids.viewer].sort()
    );

    await removeProjectMember(pruneProject, ids.viewer);

    const after = await serviceClient
      .from("task_collaborators").select("user_id").eq("task_id", pruneTask);
    expect((after.data ?? []).map((r) => r.user_id)).toEqual([ids.editor]);
  });

  it("does nothing when the removed member can still see the project another way (members.manage)", async () => {
    // A plain project_members row is not the only way to see a restricted
    // project — members.manage short-circuits user_can_see_project to true
    // regardless of membership. Removing this admin's membership row must
    // NOT prune their collaborator rows, because they can still see the
    // project through that role permission. A member-role fixture wouldn't
    // exercise this branch (that's why every OTHER fixture in this file is
    // deliberately kept off the admin role), so this test mints one small,
    // dedicated admin user via the admin API — no interactive sign-in, so it
    // doesn't touch this file's signInWithPassword rate-limit budget.
    const adminEmail = `tcadmin-${stamp}@lumina.test`;
    const adminId = await createTestUser({
      email: adminEmail, password: TEST_PASSWORD,
      name: "admin2", handle: `tcadmin${stamp}`, roleId: "admin",
    });
    const soloProject = `p_tc_prune_solo_${stamp}`;
    const soloTask = `t_tc_prune_solo_${stamp}`;
    try {
      await createProject({ id: soloProject, name: "Solo Prune", restricted: true, createdBy: ids.owner });
      await addProjectMember(soloProject, adminId, "editor");
      await serviceClient.from("tasks").insert({
        id: soloTask, project_id: soloProject, title: "Solo", created_by: ids.owner, position: 0,
      });
      await addTaskCollaborator(soloTask, adminId);

      await removeProjectMember(soloProject, adminId);

      const after = await serviceClient
        .from("task_collaborators").select("user_id").eq("task_id", soloTask);
      expect((after.data ?? []).map((r) => r.user_id)).toEqual([adminId]);
    } finally {
      await serviceClient.from("projects").delete().eq("id", soloProject);
      await deleteTestUser(adminId);
    }
  });
});

// ---------------------------------------------------------------------
// F3 (final-review.md) — nothing stopped tasks.project_id from changing and
// stranding a collaborator who cannot see the destination project.
// tasks_prune_collaborators_on_reparent (20260907000700_assignee_visibility.sql)
// deletes the stray rows when that happens.
// ---------------------------------------------------------------------
describe("re-parenting a task prunes collaborators who can't see the new project (F3)", () => {
  const reparentSrc = `p_tc_rp_src_${stamp}`;
  const reparentDst = `p_tc_rp_dst_${stamp}`;
  const reparentTask = `t_tc_rp_${stamp}`;

  afterAll(async () => {
    await serviceClient.from("projects").delete().in("id", [reparentSrc, reparentDst]);
  });

  it("drops a collaborator who can't see the destination, keeps one who can", async () => {
    await createProject({ id: reparentSrc, name: "Reparent Src", restricted: false, createdBy: ids.owner });
    await createProject({ id: reparentDst, name: "Reparent Dst", restricted: true, createdBy: ids.owner });
    await addProjectMember(reparentDst, ids.collab, "editor"); // collab CAN see the destination

    await serviceClient.from("tasks").insert({
      id: reparentTask, project_id: reparentSrc, title: "Movable",
      created_by: ids.owner, position: 0,
    });
    // Both can see the (open) source project at the time they're added.
    await addTaskCollaborator(reparentTask, ids.editor); // cannot see reparentDst
    await addTaskCollaborator(reparentTask, ids.collab); // can see reparentDst

    const before = await serviceClient
      .from("task_collaborators").select("user_id").eq("task_id", reparentTask);
    expect((before.data ?? []).map((r) => r.user_id).sort()).toEqual(
      [ids.collab, ids.editor].sort()
    );

    const { error } = await serviceClient.from("tasks")
      .update({ project_id: reparentDst }).eq("id", reparentTask);
    expect(error).toBeNull();

    const after = await serviceClient
      .from("task_collaborators").select("user_id").eq("task_id", reparentTask);
    expect((after.data ?? []).map((r) => r.user_id)).toEqual([ids.collab]);
  });
});
