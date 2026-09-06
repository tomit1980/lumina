import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addProjectMember, createProject, seedRoles } from "../helpers/workspace";

// Supabase's auth token endpoint rate-limits sign-ins per project; this
// file alone exercises six identities across ~20 assertions. Memoize one
// signed-in client per email and reuse it everywhere in this file instead
// of re-authenticating per test — the RLS behaviour under test depends on
// server-side data, not client-side session state, so a cached session is
// exactly as valid a probe as a fresh one.
const clientCache = new Map<string, Awaited<ReturnType<typeof signInAs>>>();
async function clientFor(email: string): Promise<Awaited<ReturnType<typeof signInAs>>> {
  const cached = clientCache.get(email);
  if (cached) return cached;
  const client = await signInAs(email, TEST_PASSWORD);
  clientCache.set(email, client);
  return client;
}

const stamp = Date.now();
const openProject = `p_open_${stamp}`;
const secretProject = `p_secret_${stamp}`;
const selfProject = `p_self_${stamp}`;
const spoofProject = `p_spoof_${stamp}`;
const bootstrapProject = `p_boot_${stamp}`;
const freezeProject = `p_freeze_${stamp}`;
const delNoVisProject = `p_del_novis_${stamp}`;
const delViewerProject = `p_del_viewer_${stamp}`;
const delEditorProject = `p_del_editor_${stamp}`;
// Custom role holding project.create but deliberately NOT members.manage,
// so the bootstrap regression test below exercises project_is_manageable's
// creator-bypass branch specifically, rather than its members.manage
// bypass (which admin, used elsewhere in this file, would satisfy
// trivially regardless of whether the creator bypass works at all). Reused
// below for the (finding 1) created_by-freeze test, for the same reason:
// with the seeded system roles this attack is unreachable (Member lacks
// project.create), so the test must hold project.create without
// members.manage to actually exercise the gap.
const creatorRoleId = `r_projcreator_${stamp}`;
// Custom role holding project.delete but deliberately NOT members.manage,
// for the (finding 3) projects_delete visibility-gate test — same
// reasoning: an admin's members.manage would make can_see_project() and
// project_is_viewer_only() trivially pass regardless of whether the fix
// works.
const deleterRoleId = `r_projdeleter_${stamp}`;
const emails = {
  admin: `padmin-${stamp}@lumina.test`,
  editor: `ped-${stamp}@lumina.test`,
  viewer: `pview-${stamp}@lumina.test`,
  outsider: `pout-${stamp}@lumina.test`,
  creator: `pcreator-${stamp}@lumina.test`,
  deleter: `pdeleter-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  const { error: roleError } = await serviceClient.from("roles").upsert({
    id: creatorRoleId,
    name: "Test Project Creator",
    description: "project.create only, no members.manage — test fixture",
    color: "#7c3aed",
    permissions: ["project.create"],
    is_system: false,
    locked: false,
  });
  if (roleError) throw new Error(`seed creator role failed: ${roleError.message}`);

  const { error: deleterRoleError } = await serviceClient.from("roles").upsert({
    id: deleterRoleId,
    name: "Test Project Deleter",
    description: "project.delete only, no members.manage — test fixture",
    color: "#7c3aed",
    permissions: ["project.delete"],
    is_system: false,
    locked: false,
  });
  if (deleterRoleError) throw new Error(`seed deleter role failed: ${deleterRoleError.message}`);

  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada", handle: `pada${stamp}`, roleId: "admin",
  });
  ids.editor = await createTestUser({
    email: emails.editor, password: TEST_PASSWORD,
    name: "Eve", handle: `peve${stamp}`, roleId: "member",
  });
  ids.viewer = await createTestUser({
    email: emails.viewer, password: TEST_PASSWORD,
    name: "Vic", handle: `pvic${stamp}`, roleId: "member",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Otto", handle: `potto${stamp}`, roleId: "member",
  });
  ids.creator = await createTestUser({
    email: emails.creator, password: TEST_PASSWORD,
    name: "Cara", handle: `pcara${stamp}`, roleId: creatorRoleId,
  });
  ids.deleter = await createTestUser({
    email: emails.deleter, password: TEST_PASSWORD,
    name: "Dana", handle: `pdana${stamp}`, roleId: deleterRoleId,
  });
  await createProject({ id: openProject, name: "Website", restricted: false, createdBy: ids.admin });
  await createProject({ id: secretProject, name: "Acquisition", restricted: true, createdBy: ids.admin });
  await addProjectMember(secretProject, ids.editor, "editor");
  await addProjectMember(secretProject, ids.viewer, "viewer");
  await serviceClient.from("tasks").insert({
    id: `t_secret_${stamp}`, project_id: secretProject,
    title: "Draft the offer", created_by: ids.admin, position: 0,
  });
});

afterAll(async () => {
  await serviceClient.from("projects").delete().in("id", [
    openProject, secretProject, selfProject, spoofProject, bootstrapProject,
    freezeProject, delNoVisProject, delViewerProject, delEditorProject,
  ]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
  await serviceClient.from("roles").delete().in("id", [creatorRoleId, deleterRoleId]);
});

describe("project RLS", () => {
  it("hides a restricted project from a non-member", async () => {
    const client = await clientFor(emails.outsider);
    const { data } = await client.from("projects").select("id").eq("id", secretProject);
    expect(data).toHaveLength(0);
  });

  it("withholds its tasks from a non-member too", async () => {
    const client = await clientFor(emails.outsider);
    const { data } = await client.from("tasks").select("id,title").eq("project_id", secretProject);
    expect(data).toHaveLength(0);
  });

  it("shows a restricted project to an invited editor", async () => {
    const client = await clientFor(emails.editor);
    const { data } = await client.from("projects").select("id").eq("id", secretProject);
    expect(data).toHaveLength(1);
  });

  it("lets an invited editor create a task", async () => {
    const client = await clientFor(emails.editor);
    const id = `t_ok_${stamp}`;
    const { error } = await client.from("tasks").insert({
      id, project_id: secretProject, title: "Editor task", created_by: ids.editor, position: 1,
    });
    expect(error).toBeNull();
    await serviceClient.from("tasks").delete().eq("id", id);
  });

  it("denies a viewer creating a task despite seeing the project", async () => {
    const client = await clientFor(emails.viewer);
    const { data: visible } = await client.from("projects").select("id").eq("id", secretProject);
    expect(visible).toHaveLength(1);

    const { error } = await client.from("tasks").insert({
      id: `t_viewer_${stamp}`, project_id: secretProject,
      title: "Viewer task", created_by: ids.viewer, position: 2,
    });
    expect(error).not.toBeNull();
  });

  it("denies a viewer editing an existing task", async () => {
    const client = await clientFor(emails.viewer);
    await client.from("tasks").update({ title: "Tampered" }).eq("id", `t_secret_${stamp}`);
    const { data } = await serviceClient
      .from("tasks").select("title").eq("id", `t_secret_${stamp}`).single();
    expect(data?.title).toBe("Draft the offer");
  });

  it("denies a member deleting a project without project.delete", async () => {
    const client = await clientFor(emails.editor);
    await client.from("projects").delete().eq("id", openProject);
    const { data } = await serviceClient.from("projects").select("id").eq("id", openProject);
    expect(data).toHaveLength(1);
  });

  it("shows every project to an admin", async () => {
    const client = await clientFor(emails.admin);
    const { data } = await client
      .from("projects").select("id").in("id", [openProject, secretProject]);
    expect(data).toHaveLength(2);
  });

  // --- Regression tests for the two defects fixed at the source in this
  // migration (see supabase/migrations/20260906000300_projects.sql). ---

  it("(defect 2) denies creating a project attributed to someone else, but allows attributing it to yourself", async () => {
    const client = await clientFor(emails.admin);

    // Positive control: the same client, the same insert shape, correctly
    // self-attributed, succeeds — proving the insert mechanism itself
    // works before we rely on it producing a denial below.
    const okInsert = await client.from("projects").insert({
      id: selfProject, name: "Self Attributed", description: "", emoji: "🎨",
      color: "#7c3aed", priority: "medium", restricted: false, created_by: ids.admin,
    });
    expect(okInsert.error).toBeNull();

    // Spoofed attribution: same admin, same permission, but created_by
    // names someone else. Defect 2 was that projects_insert never bound
    // created_by, so this would have silently succeeded.
    const spoofed = await client.from("projects").insert({
      id: spoofProject, name: "Spoofed", description: "", emoji: "🎨",
      color: "#7c3aed", priority: "medium", restricted: false, created_by: ids.editor,
    });
    expect(spoofed.error).not.toBeNull();

    const { data } = await serviceClient.from("projects").select("id").eq("id", spoofProject);
    expect(data).toHaveLength(0);
  });

  it("(defect 1 bootstrap) lets a restricted project's own creator add themselves as its first member", async () => {
    const client = await clientFor(emails.creator);

    // The creator role holds project.create but not members.manage, and
    // this project is restricted from the start — so once created, the
    // creator (not yet a project_members row) fails can_see_project() /
    // project_is_viewer_only() on membership alone. Only
    // project_is_manageable's creator-bypass branch can let them add
    // themselves as the first member.
    const created = await client.from("projects").insert({
      id: bootstrapProject, name: "Bootstrap", description: "", emoji: "🎨",
      color: "#7c3aed", priority: "medium", restricted: true, created_by: ids.creator,
    });
    expect(created.error).toBeNull();

    const { error } = await client.from("project_members")
      .insert({ project_id: bootstrapProject, user_id: ids.creator, level: "editor" });
    expect(error).toBeNull();

    const { data } = await serviceClient.from("project_members")
      .select("user_id").eq("project_id", bootstrapProject).eq("user_id", ids.creator);
    expect(data).toHaveLength(1);
  });

  it("(defect 1) denies a member inserting themselves into a restricted project's member list", async () => {
    const client = await clientFor(emails.outsider);
    const { error } = await client.from("project_members")
      .insert({ project_id: secretProject, user_id: ids.outsider, level: "editor" });
    expect(error).not.toBeNull();

    const { data } = await serviceClient.from("project_members")
      .select("user_id").eq("project_id", secretProject).eq("user_id", ids.outsider);
    expect(data).toHaveLength(0);
  });

  it("(defect 1) denies a non-member enumerating a restricted project's member list", async () => {
    const editorClient = await clientFor(emails.editor);
    const outsiderClient = await clientFor(emails.outsider);

    // Positive control: an actual member of the project can list its
    // roster — proving the query mechanism and read policy work at all.
    const { data: asMember } = await editorClient
      .from("project_members").select("user_id").eq("project_id", secretProject);
    expect(asMember?.length).toBeGreaterThan(0);

    // The outsider holds no permission and no membership row on this
    // restricted project. Under the brief's buggy `for all` policy, its
    // using clause (a global permission check only) would have governed
    // select too and could leak this roster to anyone holding
    // project.create; here it must come back empty regardless.
    const { data: asOutsider } = await outsiderClient
      .from("project_members").select("user_id").eq("project_id", secretProject);
    expect(asOutsider).toHaveLength(0);
  });

  // --- Regression tests for the three review findings fixed in
  // supabase/migrations/20260906000350_fix_project_policies.sql. ---

  it("(finding 1) freezes created_by against reassignment, even for a role with project.create", async () => {
    await createProject({ id: freezeProject, name: "Freeze Me", restricted: false, createdBy: ids.admin });

    // The creator-role user (project.create, no members.manage) can see
    // and edit this open project (non-restricted, so project_is_manageable
    // isn't even needed to reach projects_update's USING clause) — proving
    // the update mechanism works for this role before relying on a denial.
    const client = await clientFor(emails.creator);
    const rename = await client.from("projects").update({ name: "Renamed" }).eq("id", freezeProject);
    expect(rename.error).toBeNull();

    // Without the freeze_created_by trigger, projects_update's WITH CHECK
    // only re-tests has_permission('project.create') — it never re-tests
    // created_by — so this reassignment would have silently succeeded and
    // handed the creator role, via project_is_manageable's creator branch,
    // permanent unconditional control of a project it didn't create.
    const seize = await client.from("projects")
      .update({ created_by: ids.creator }).eq("id", freezeProject);
    expect(seize.error).not.toBeNull();

    const { data } = await serviceClient
      .from("projects").select("created_by").eq("id", freezeProject).single();
    expect(data?.created_by).toBe(ids.admin);
  });

  it("(finding 2) denies re-parenting a task into a project where you are only a viewer", async () => {
    const taskId = `t_reparent_${stamp}`;
    await serviceClient.from("tasks").insert({
      id: taskId, project_id: openProject, title: "Movable", created_by: ids.admin, position: 3,
    });

    // Positive control: an actual editor member of the secret project can
    // re-parent a task into it — proving project_id updates work at all,
    // so the denial below isn't just a blanket update failure.
    const editorClient = await clientFor(emails.editor);
    const editorMove = await editorClient.from("tasks")
      .update({ project_id: secretProject }).eq("id", taskId);
    expect(editorMove.error).toBeNull();
    await serviceClient.from("tasks").update({ project_id: openProject }).eq("id", taskId);

    // The viewer holds task.edit (member role) and can edit tasks in the
    // open source project, but is only a viewer on the destination —
    // exactly the case verified exploitable against the un-fixed policy.
    const viewerClient = await clientFor(emails.viewer);
    const viewerMove = await viewerClient.from("tasks")
      .update({ project_id: secretProject }).eq("id", taskId);
    expect(viewerMove.error).not.toBeNull();

    const { data } = await serviceClient
      .from("tasks").select("project_id").eq("id", taskId).single();
    expect(data?.project_id).toBe(openProject);

    await serviceClient.from("tasks").delete().eq("id", taskId);
  });

  it("(finding 3) gates projects_delete on visibility and the viewer-only exclusion, despite holding project.delete", async () => {
    await createProject({ id: delNoVisProject, name: "No Visibility", restricted: true, createdBy: ids.admin });
    await createProject({ id: delViewerProject, name: "Viewer Only", restricted: true, createdBy: ids.admin });
    await addProjectMember(delViewerProject, ids.deleter, "viewer");
    await createProject({ id: delEditorProject, name: "Editor Access", restricted: true, createdBy: ids.admin });
    await addProjectMember(delEditorProject, ids.deleter, "editor");

    // One sign-in reused for all three assertions below (rather than three
    // separate signInAs calls), all against a role holding project.delete
    // but deliberately not members.manage, so each assertion exercises the
    // fixed policy's own visibility/viewer-only gate rather than an
    // members.manage bypass.
    const client = await clientFor(emails.deleter);

    // A DELETE's USING clause only filters which rows are visible to the
    // delete — a denial matches zero rows and reports no error at all (unlike
    // an INSERT/UPDATE's WITH CHECK, which raises 42501). So denial here is
    // asserted the same way as the pre-existing
    // "denies a member deleting a project without project.delete" test:
    // by the row's survival via the service client below, not by .error.

    // Without projects_delete's added can_see_project(id), this project
    // the deleter cannot see at all would have been deletable purely on
    // the strength of the global project.delete permission.
    await client.from("projects").delete().eq("id", delNoVisProject);

    // Without the added viewer-only exclusion, being merely a viewer on a
    // restricted project (which does satisfy can_see_project) would still
    // have let this role delete the whole project.
    await client.from("projects").delete().eq("id", delViewerProject);

    // Positive control: the same permission, held by someone who can see
    // the project and is not viewer-only there, still works — proving the
    // two denials above are the fix, not a blanket delete failure.
    const editorDel = await client.from("projects").delete().eq("id", delEditorProject);
    expect(editorDel.error).toBeNull();

    const { data } = await serviceClient
      .from("projects").select("id").in("id", [delNoVisProject, delViewerProject, delEditorProject]);
    expect((data ?? []).map((p) => p.id).sort()).toEqual([delNoVisProject, delViewerProject].sort());
  });
});
