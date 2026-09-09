import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import { DEFAULT_ROLES } from "@/lib/permissions";
import { canUserSeeProject } from "@/lib/store";
import type { AppState, Project } from "@/lib/types";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import {
  addProjectMember, addTaskCollaborator, createChannel, createProject, seedRoles,
} from "../helpers/workspace";

// Task 6 — `SupabaseBackend`'s seven workspace writes against lumina-dev, under
// the real policies and the real triggers.
//
// The unit suite (tests/qa/workspace-writes.test.ts) proves what the STORE does
// with a resolved or rejected promise. This file is the other half, and it is
// where the two claims that matter can actually be observed:
//
//   * a member without `members.manage` cannot seize a restricted project
//     (QA-004, a Critical finding);
//   * the collaborator pruning the store does client-side and the pruning the
//     database does server-side produce the SAME surviving rows. The store's
//     rule is imported and run here, so this is a comparison of two
//     implementations, not a comparison against a hard-coded expectation.
//
// Every negative is paired with a positive control on the SAME client and the
// SAME method, so a backend that had simply stopped working could not pass by
// failing everything.
//
// Frugal like every file here: Supabase rate-limits signInWithPassword per
// project across the whole run and these files execute in parallel forks.
// Exactly TWO identities ever sign in — `owner` (an admin) and `plain` (a
// Member, who holds task.edit but NOT project.create or members.manage).
// `mate` and `stranger` exist to be pruned or kept and never authenticate.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const emails = {
  owner: `wwown-${stamp}@lumina.test`,
  plain: `wwplain-${stamp}@lumina.test`,
  mate: `wwmate-${stamp}@lumina.test`,
  stranger: `wwstr-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

/** Everything this file creates through the backend, torn down in afterAll. */
const createdProjects = new Set<string>();
const createdConversations = new Set<string>();

async function backendFor(email: string): Promise<SupabaseBackend> {
  return new SupabaseBackend(await clientFor(email));
}

/**
 * The `AppState` the store would be holding for the same workspace — enough of
 * one for `canUserSeeProject`, which reads `users`, `roles` and the project it
 * is handed. Built from `DEFAULT_ROLES` (the same source `seedRoles` inserts
 * from) so the client rule and the database rule are looking at identical role
 * definitions rather than two hand-written approximations.
 */
function storeState(project: Project): AppState {
  return {
    version: 0,
    currentUserId: ids.owner,
    users: [
      { id: ids.owner, roleId: "admin" },
      { id: ids.plain, roleId: "member" },
      { id: ids.mate, roleId: "member" },
      { id: ids.stranger, roleId: "member" },
    ].map((u) => ({
      ...u, name: u.id, handle: u.id, title: "", color: "#000", presence: "offline" as const,
    })),
    roles: DEFAULT_ROLES.map((r) => ({ ...r, permissions: [...r.permissions] })),
    channels: [], dms: [], messages: [], tasks: [], activities: [], lastRead: {},
    projects: [project],
  };
}

function project(id: string, restricted: boolean, createdBy: string): Project {
  return {
    id, name: `WW ${id}`, description: "", emoji: "🎨", color: "#7c3aed",
    priority: "medium", restricted, members: [], attachments: [],
    createdBy, createdAt: Date.now(),
  };
}

async function seedTask(id: string, projectId: string): Promise<void> {
  const { error } = await serviceClient.from("tasks").insert({
    id, project_id: projectId, title: "Salary bands", status: "todo", position: 0,
  });
  if (error) throw new Error(`seedTask failed: ${error.message}`);
}

async function collaboratorsOn(taskId: string): Promise<string[]> {
  const { data, error } = await serviceClient
    .from("task_collaborators").select("user_id").eq("task_id", taskId);
  if (error) throw new Error(`collaboratorsOn failed: ${error.message}`);
  return (data ?? []).map((r) => r.user_id).sort();
}

beforeAll(async () => {
  await seedRoles();

  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ora", handle: `wwora${stamp}`, roleId: "admin",
  });
  // Plain Member: holds channel.create, task.create, task.edit and task.move,
  // but NOT project.create and NOT members.manage. Every project denial below
  // is therefore the policy talking, not an admin fixture papering over it.
  ids.plain = await createTestUser({
    email: emails.plain, password: TEST_PASSWORD,
    name: "Pim", handle: `wwpim${stamp}`, roleId: "member",
  });
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Mae", handle: `wwmae${stamp}`, roleId: "member",
  });
  ids.stranger = await createTestUser({
    email: emails.stranger, password: TEST_PASSWORD,
    name: "Stu", handle: `wwstu${stamp}`, roleId: "member",
  });

  await clientFor(emails.owner);
  await clientFor(emails.plain);
}, 60_000);

afterAll(async () => {
  await serviceClient.from("projects").delete().in("id", [...createdProjects]);
  await serviceClient.from("conversations").delete().in("id", [...createdConversations]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("createChannel / deleteChannel", () => {
  it("creates the conversation and the channel together", async () => {
    const backend = await backendFor(emails.plain);
    const id = `c_ww_new_${stamp}`;
    createdConversations.add(id);

    await expect(
      backend.createChannel({
        id, name: `ww-new-${stamp}`, description: "shipping", isPrivate: false,
        isTeam: false, members: [], createdBy: ids.plain, createdAt: Date.now(),
      })
    ).resolves.toMatchObject({ id });

    // Both rows, not just the channel: `channels.id` references
    // `conversations(id)`, and a channel without its parent is unreachable.
    const { data: conv } = await serviceClient
      .from("conversations").select("kind").eq("id", id).single();
    expect(conv?.kind).toBe("channel");
    const { data: chan } = await serviceClient
      .from("channels").select("created_by,is_team").eq("id", id).single();
    expect(chan?.created_by).toBe(ids.plain);
    expect(chan?.is_team).toBe(false);
  });

  it("CASCADES a delete to the channel's messages", async () => {
    const id = `c_ww_del_${stamp}`;
    const message = `m_ww_del_${stamp}`;
    await createChannel({
      id, name: `ww-del-${stamp}`, isPrivate: false, createdBy: ids.plain,
    });
    const seeded = await serviceClient.from("messages").insert({
      id: message, conversation_id: id, author_id: ids.plain, content: "goodbye",
    });
    expect(seeded.error).toBeNull();
    // The control: the child really is there before the delete, so its absence
    // afterwards means the cascade ran and not that it was never written.
    expect(await serviceClient.from("messages").select("id").eq("id", message))
      .toMatchObject({ data: [{ id: message }] });

    const backend = await backendFor(emails.plain);
    await expect(backend.deleteChannel(id)).resolves.toBeUndefined();

    const { data: channel } = await serviceClient.from("channels").select("id").eq("id", id);
    expect(channel).toEqual([]);
    const { data: messages } = await serviceClient
      .from("messages").select("id").eq("id", message);
    expect(messages).toEqual([]);
    const { data: conv } = await serviceClient
      .from("conversations").select("id").eq("id", id);
    expect(conv).toEqual([]);
  });

  it("REJECTS deleting a channel the caller neither created nor may delete", async () => {
    // `conversations_delete` filters the row away, which PostgREST reports as
    // error: null and zero rows — the false-success shape. A backend that only
    // checked `error` would resolve, and app-shell.tsx would toast "deleted"
    // and navigate away from a channel that is still there.
    const id = `c_ww_theirs_${stamp}`;
    createdConversations.add(id);
    await createChannel({
      id, name: `ww-theirs-${stamp}`, isPrivate: false, createdBy: ids.owner,
    });

    const backend = await backendFor(emails.plain);
    await expect(backend.deleteChannel(id)).rejects.toThrow();

    const { data } = await serviceClient.from("channels").select("id").eq("id", id);
    expect(data).toHaveLength(1);
  });
});

describe("setChannelAccess", () => {
  const id = `c_ww_access_${stamp}`;

  beforeAll(async () => {
    createdConversations.add(id);
    await createChannel({
      id, name: `ww-access-${stamp}`, isPrivate: false, createdBy: ids.plain,
    });
  });

  it("privatises a channel and writes its member list", async () => {
    const backend = await backendFor(emails.plain);

    await expect(
      backend.setChannelAccess(id, {
        isPrivate: true,
        members: [
          { userId: ids.plain, level: "editor" },
          { userId: ids.mate, level: "viewer" },
        ],
      })
    ).resolves.toBeUndefined();

    const { data: channel } = await serviceClient
      .from("channels").select("is_private").eq("id", id).single();
    expect(channel?.is_private).toBe(true);

    const { data: members } = await serviceClient
      .from("channel_members").select("user_id,level").eq("channel_id", id);
    expect((members ?? []).map((m) => `${m.user_id}:${m.level}`).sort()).toEqual(
      [`${ids.plain}:editor`, `${ids.mate}:viewer`].sort()
    );
  });

  it("removes a member without delete-and-reinserting the ones who stay", async () => {
    const backend = await backendFor(emails.plain);

    await expect(
      backend.setChannelAccess(id, {
        isPrivate: true, members: [{ userId: ids.plain, level: "editor" }],
      })
    ).resolves.toBeUndefined();

    const { data } = await serviceClient
      .from("channel_members").select("user_id").eq("channel_id", id);
    expect((data ?? []).map((m) => m.user_id)).toEqual([ids.plain]);
  });

  it("REFUSES a member trying to privatise somebody else's channel", async () => {
    const theirs = `c_ww_lock_${stamp}`;
    createdConversations.add(theirs);
    await createChannel({
      id: theirs, name: `ww-lock-${stamp}`, isPrivate: false, createdBy: ids.owner,
    });

    // Positive control above: the same client, the same method, on a channel
    // this user created — so the refusal here is `channel_is_manageable`, not a
    // broken backend.
    const backend = await backendFor(emails.plain);
    await expect(
      backend.setChannelAccess(theirs, {
        isPrivate: true, members: [{ userId: ids.plain, level: "editor" }],
      })
    ).rejects.toThrow();

    const { data: channel } = await serviceClient
      .from("channels").select("is_private").eq("id", theirs).single();
    expect(channel?.is_private).toBe(false);
    // And no membership row was written on the way to being refused — that is
    // the escalation the split channel_members policies exist to stop.
    const { data: members } = await serviceClient
      .from("channel_members").select("user_id").eq("channel_id", theirs);
    expect(members).toEqual([]);
  });
});

describe("createProject / updateProject / deleteProject", () => {
  it("creates a project attributed to its creator", async () => {
    const backend = await backendFor(emails.owner);
    const id = `p_ww_new_${stamp}`;
    createdProjects.add(id);

    await expect(backend.createProject(project(id, false, ids.owner))).resolves.toMatchObject({ id });

    const { data } = await serviceClient
      .from("projects").select("created_by,restricted").eq("id", id).single();
    expect(data?.created_by).toBe(ids.owner);
    expect(data?.restricted).toBe(false);
  });

  it("saves an edit, and CASCADES a delete to the project's tasks", async () => {
    const backend = await backendFor(emails.owner);
    const id = `p_ww_gone_${stamp}`;
    const task = `t_ww_gone_${stamp}`;
    createdProjects.add(id);
    await createProject({ id, name: "Doomed", restricted: false, createdBy: ids.owner });
    await seedTask(task, id);

    await expect(backend.updateProject(id, { name: "Renamed" })).resolves.toBeUndefined();
    const { data: renamed } = await serviceClient
      .from("projects").select("name").eq("id", id).single();
    expect(renamed?.name).toBe("Renamed");

    // Control: the child really is there before the delete, so its absence
    // afterwards means the cascade ran and not that it was never written.
    const { data: before } = await serviceClient.from("tasks").select("id").eq("id", task);
    expect(before).toHaveLength(1);

    await expect(backend.deleteProject(id)).resolves.toBeUndefined();

    const { data: gone } = await serviceClient.from("projects").select("id").eq("id", id);
    expect(gone).toEqual([]);
    const { data: tasks } = await serviceClient.from("tasks").select("id").eq("id", task);
    // The client never deletes these; the foreign key does.
    expect(tasks).toEqual([]);
  });

  it("REFUSES a plain member renaming or deleting a project", async () => {
    const id = `p_ww_theirs_${stamp}`;
    createdProjects.add(id);
    await createProject({ id, name: "Payroll", restricted: false, createdBy: ids.owner });

    const backend = await backendFor(emails.plain);
    await expect(backend.updateProject(id, { name: "Seized" })).rejects.toThrow();
    await expect(backend.deleteProject(id)).rejects.toThrow();

    const { data } = await serviceClient
      .from("projects").select("name").eq("id", id).single();
    expect(data?.name).toBe("Payroll");
  });
});

describe("setProjectAccess — QA-004: a member cannot seize a restricted project", () => {
  const locked = `p_ww_locked_${stamp}`;

  beforeAll(async () => {
    createdProjects.add(locked);
    await createProject({ id: locked, name: "Board only", restricted: true, createdBy: ids.owner });
    await addProjectMember(locked, ids.owner, "editor");
  });

  it("REFUSES a member adding themselves to a restricted project they cannot see", async () => {
    const backend = await backendFor(emails.plain);

    await expect(
      backend.setProjectAccess(locked, {
        restricted: true,
        members: [
          { userId: ids.owner, level: "editor" },
          { userId: ids.plain, level: "editor" },
        ],
      })
    ).rejects.toThrow();

    // The assertion that matters: no membership row was written. If one had
    // been, `can_see_project` would trust it and hand this user the project and
    // every task in it.
    const { data } = await serviceClient
      .from("project_members").select("user_id").eq("project_id", locked);
    expect((data ?? []).map((m) => m.user_id)).toEqual([ids.owner]);
  });

  it("REFUSES the same member un-restricting it to get in", async () => {
    const backend = await backendFor(emails.plain);
    await expect(
      backend.setProjectAccess(locked, { restricted: false, members: [] })
    ).rejects.toThrow();

    const { data } = await serviceClient
      .from("projects").select("restricted").eq("id", locked).single();
    expect(data?.restricted).toBe(true);
  });

  it("lets a holder of members.manage do it — the positive control", async () => {
    // Same method, same project, different role. Without this the two
    // refusals above would also pass against a setProjectAccess that never
    // worked for anyone.
    const backend = await backendFor(emails.owner);

    await expect(
      backend.setProjectAccess(locked, {
        restricted: true,
        members: [
          { userId: ids.owner, level: "editor" },
          { userId: ids.mate, level: "viewer" },
        ],
      })
    ).resolves.toBeUndefined();

    const { data } = await serviceClient
      .from("project_members").select("user_id,level").eq("project_id", locked);
    expect((data ?? []).map((m) => `${m.user_id}:${m.level}`).sort()).toEqual(
      [`${ids.owner}:editor`, `${ids.mate}:viewer`].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// The pruning agreement — the reason this task's brief calls for a test at all.
//
// `lib/store.tsx`'s setProjectAccess prunes collaborators client-side so the
// board is right immediately. The database prunes too, from
// `project_members_prune_collaborators` plus the sweep in
// lib/backend/supabase/workspace.ts. If they ever disagree, the optimistic
// state is a lie until the next reload — so both are run against the same input
// and their answers compared. `canUserSeeProject` is imported, not restated.
// ---------------------------------------------------------------------------
describe("setProjectAccess — client and server prune the same collaborators", () => {
  async function scenario(suffix: string, restricted: boolean) {
    const id = `p_ww_prune_${suffix}_${stamp}`;
    const task = `t_ww_prune_${suffix}_${stamp}`;
    createdProjects.add(id);
    await createProject({ id, name: "Payroll", restricted, createdBy: ids.owner });
    await addProjectMember(id, ids.owner, "editor");
    if (restricted) {
      // Both must be able to see it before they can be collaborators at all —
      // task_collaborators_check_insert enforces exactly that.
      await addProjectMember(id, ids.mate, "editor");
      await addProjectMember(id, ids.stranger, "editor");
    }
    await seedTask(task, id);
    await addTaskCollaborator(task, ids.mate);
    await addTaskCollaborator(task, ids.stranger);
    return { id, task };
  }

  it("agrees when a listed member is REVOKED (the trigger's path)", async () => {
    const { id, task } = await scenario("revoke", true);
    expect(await collaboratorsOn(task)).toEqual([ids.mate, ids.stranger].sort());

    const members = [
      { userId: ids.owner, level: "editor" as const },
      { userId: ids.mate, level: "editor" as const },
    ];

    // What the store shows the moment the dialog closes.
    const state = storeState({ ...project(id, true, ids.owner), members });
    const updated = state.projects[0];
    const clientKept = [ids.mate, ids.stranger]
      .filter((u) => canUserSeeProject(state, updated, u))
      .sort();

    const backend = await backendFor(emails.owner);
    await expect(
      backend.setProjectAccess(id, { restricted: true, members })
    ).resolves.toBeUndefined();

    expect(await collaboratorsOn(task)).toEqual(clientKept);
    // And the substance: `stranger` lost access and went, `mate` stayed. A
    // prune that removed everybody would satisfy the equality alone.
    expect(clientKept).toEqual([ids.mate]);
  });

  it("agrees when an OPEN project is restricted and nobody's member row is deleted", async () => {
    // The case the trigger cannot see: it fires on a project_members DELETE,
    // and an unrestricted project has no rows for these two to delete. Without
    // the sweep in workspace.ts the database would keep both collaborators
    // while the store showed one — the exact divergence this test exists for.
    const { id, task } = await scenario("restrict", false);
    expect(await collaboratorsOn(task)).toEqual([ids.mate, ids.stranger].sort());

    const members = [
      { userId: ids.owner, level: "editor" as const },
      { userId: ids.mate, level: "editor" as const },
    ];
    const state = storeState({ ...project(id, true, ids.owner), members });
    const clientKept = [ids.mate, ids.stranger]
      .filter((u) => canUserSeeProject(state, state.projects[0], u))
      .sort();

    const backend = await backendFor(emails.owner);
    await expect(
      backend.setProjectAccess(id, { restricted: true, members })
    ).resolves.toBeUndefined();

    expect(await collaboratorsOn(task)).toEqual(clientKept);
    expect(clientKept).toEqual([ids.mate]);
  });

  it("agrees that OPENING a project prunes nobody — the positive control", async () => {
    // Everyone can see an unrestricted project, so both implementations must
    // leave every collaborator alone. Without this, a sweep that deleted
    // everything would pass both tests above.
    const { id, task } = await scenario("open", true);

    const state = storeState({ ...project(id, false, ids.owner), members: [] });
    const clientKept = [ids.mate, ids.stranger]
      .filter((u) => canUserSeeProject(state, state.projects[0], u))
      .sort();
    expect(clientKept).toEqual([ids.mate, ids.stranger].sort());

    const backend = await backendFor(emails.owner);
    await expect(
      backend.setProjectAccess(id, { restricted: false, members: [] })
    ).resolves.toBeUndefined();

    expect(await collaboratorsOn(task)).toEqual(clientKept);
    // The project's own creator keeps their membership row: Invariant 3 forbids
    // deleting it, and the backend skips it rather than raising and turning a
    // legal change into a reported failure.
    const { data } = await serviceClient
      .from("project_members").select("user_id").eq("project_id", id);
    expect((data ?? []).map((m) => m.user_id)).toEqual([ids.owner]);
  });

  it("keeps a collaborator who is staying — membership is not delete-and-reinsert", async () => {
    // If setProjectAccess cleared the member list and wrote it back, the
    // trigger would fire for `mate` too, see them momentarily unlisted on a
    // restricted project, and delete a collaborator row nobody asked to lose.
    const { id, task } = await scenario("keep", true);
    const members = [
      { userId: ids.owner, level: "editor" as const },
      { userId: ids.mate, level: "viewer" as const },
      { userId: ids.stranger, level: "editor" as const },
    ];

    const backend = await backendFor(emails.owner);
    await expect(
      backend.setProjectAccess(id, { restricted: true, members })
    ).resolves.toBeUndefined();

    // Nobody left the project, so nobody left the task.
    expect(await collaboratorsOn(task)).toEqual([ids.mate, ids.stranger].sort());
    // ...and the level change still landed, through an UPDATE rather than a
    // delete-plus-insert.
    const { data } = await serviceClient
      .from("project_members").select("level").eq("project_id", id).eq("user_id", ids.mate)
      .single();
    expect(data?.level).toBe("viewer");
  });
});
