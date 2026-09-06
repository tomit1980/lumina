import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addProjectMember, createProject, seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const openProject = `p_open_${stamp}`;
const secretProject = `p_secret_${stamp}`;
const selfProject = `p_self_${stamp}`;
const spoofProject = `p_spoof_${stamp}`;
const bootstrapProject = `p_boot_${stamp}`;
// Custom role holding project.create but deliberately NOT members.manage,
// so the bootstrap regression test below exercises project_is_manageable's
// creator-bypass branch specifically, rather than its members.manage
// bypass (which admin, used elsewhere in this file, would satisfy
// trivially regardless of whether the creator bypass works at all).
const creatorRoleId = `r_projcreator_${stamp}`;
const emails = {
  admin: `padmin-${stamp}@lumina.test`,
  editor: `ped-${stamp}@lumina.test`,
  viewer: `pview-${stamp}@lumina.test`,
  outsider: `pout-${stamp}@lumina.test`,
  creator: `pcreator-${stamp}@lumina.test`,
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
  await serviceClient.from("projects")
    .delete().in("id", [openProject, secretProject, selfProject, spoofProject, bootstrapProject]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
  await serviceClient.from("roles").delete().eq("id", creatorRoleId);
});

describe("project RLS", () => {
  it("hides a restricted project from a non-member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("projects").select("id").eq("id", secretProject);
    expect(data).toHaveLength(0);
  });

  it("withholds its tasks from a non-member too", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("tasks").select("id,title").eq("project_id", secretProject);
    expect(data).toHaveLength(0);
  });

  it("shows a restricted project to an invited editor", async () => {
    const client = await signInAs(emails.editor, TEST_PASSWORD);
    const { data } = await client.from("projects").select("id").eq("id", secretProject);
    expect(data).toHaveLength(1);
  });

  it("lets an invited editor create a task", async () => {
    const client = await signInAs(emails.editor, TEST_PASSWORD);
    const id = `t_ok_${stamp}`;
    const { error } = await client.from("tasks").insert({
      id, project_id: secretProject, title: "Editor task", created_by: ids.editor, position: 1,
    });
    expect(error).toBeNull();
    await serviceClient.from("tasks").delete().eq("id", id);
  });

  it("denies a viewer creating a task despite seeing the project", async () => {
    const client = await signInAs(emails.viewer, TEST_PASSWORD);
    const { data: visible } = await client.from("projects").select("id").eq("id", secretProject);
    expect(visible).toHaveLength(1);

    const { error } = await client.from("tasks").insert({
      id: `t_viewer_${stamp}`, project_id: secretProject,
      title: "Viewer task", created_by: ids.viewer, position: 2,
    });
    expect(error).not.toBeNull();
  });

  it("denies a viewer editing an existing task", async () => {
    const client = await signInAs(emails.viewer, TEST_PASSWORD);
    await client.from("tasks").update({ title: "Tampered" }).eq("id", `t_secret_${stamp}`);
    const { data } = await serviceClient
      .from("tasks").select("title").eq("id", `t_secret_${stamp}`).single();
    expect(data?.title).toBe("Draft the offer");
  });

  it("denies a member deleting a project without project.delete", async () => {
    const client = await signInAs(emails.editor, TEST_PASSWORD);
    await client.from("projects").delete().eq("id", openProject);
    const { data } = await serviceClient.from("projects").select("id").eq("id", openProject);
    expect(data).toHaveLength(1);
  });

  it("shows every project to an admin", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const { data } = await client
      .from("projects").select("id").in("id", [openProject, secretProject]);
    expect(data).toHaveLength(2);
  });

  // --- Regression tests for the two defects fixed at the source in this
  // migration (see supabase/migrations/20260906000300_projects.sql). ---

  it("(defect 2) denies creating a project attributed to someone else, but allows attributing it to yourself", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);

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
    const client = await signInAs(emails.creator, TEST_PASSWORD);

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
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("project_members")
      .insert({ project_id: secretProject, user_id: ids.outsider, level: "editor" });
    expect(error).not.toBeNull();

    const { data } = await serviceClient.from("project_members")
      .select("user_id").eq("project_id", secretProject).eq("user_id", ids.outsider);
    expect(data).toHaveLength(0);
  });

  it("(defect 1) denies a non-member enumerating a restricted project's member list", async () => {
    const editorClient = await signInAs(emails.editor, TEST_PASSWORD);
    const outsiderClient = await signInAs(emails.outsider, TEST_PASSWORD);

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
});
