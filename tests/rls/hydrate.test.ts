import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import type { AppState } from "@/lib/types";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import {
  addChannelMember, addProjectMember, addTaskCollaborator, createChannel, createProject,
  seedRoles,
} from "../helpers/workspace";

// Task 4 — `SupabaseBackend.hydrate()` against lumina-dev, which is the test
// that actually closes QA-001. Everything else in this plan is a claim about
// what the client *asks* for; this is the only place we find out what the
// database is willing to *give*.
//
// The shape: two ordinary Members hydrate the same workspace. `outsider` is a
// member of nothing; `insider` is in the private channel and the restricted
// project. Each is the other's control — every row `outsider` must not hold is
// a row `insider` does hold, from the same code path, in the same run. A
// hydrate that returned nothing at all, or one that crashed and produced an
// empty AppState, fails half these assertions rather than passing them all.
//
// Assertions are on ids and counts, never on the absence of a display name:
// "no project called Secret" is satisfied by a project called Secret arriving
// with a different name, and by a `projects` array that is silently `[]`.
//
// Frugal like every file here: Supabase rate-limits signInWithPassword per
// project across the whole `npm run test:rls` run and these files execute in
// parallel forks. Exactly TWO identities are ever signed in. `mate` exists to
// be the far side of a DM and a project collaborator, and never authenticates.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const pubChannel = `c_hy_pub_${stamp}`;
const privChannel = `c_hy_priv_${stamp}`;
const openProject = `p_hy_open_${stamp}`;
const secretProject = `p_hy_secret_${stamp}`;
const openTask = `t_hy_open_${stamp}`;
const secretTask = `t_hy_secret_${stamp}`;
const dmOutsiderMate = `dm_hy_a_${stamp}`;
const dmInsiderMate = `dm_hy_b_${stamp}`;
const msgPub = `m_hy_pub_${stamp}`;
const msgPriv = `m_hy_priv_${stamp}`;
const msgDmA = `m_hy_dma_${stamp}`;
const msgDmB = `m_hy_dmb_${stamp}`;

const emails = {
  outsider: `hyout-${stamp}@lumina.test`,
  insider: `hyin-${stamp}@lumina.test`,
  mate: `hymate-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

const OUTSIDER_READ_AT = "2026-09-08T10:00:00+00:00";
const INSIDER_READ_AT = "2026-09-08T11:00:00+00:00";

async function insert(table: string, rows: unknown): Promise<void> {
  // Untyped on purpose: these are fixture inserts through the service key,
  // and several take shapes (`conversations`) the app never writes.
  const { error } = await (serviceClient as never as {
    from: (t: string) => { insert: (r: unknown) => Promise<{ error: { message: string } | null }> };
  }).from(table).insert(rows);
  if (error) throw new Error(`seed ${table} failed: ${error.message}`);
}

async function createDm(id: string, a: string, b: string): Promise<void> {
  await insert("conversations", { id, kind: "dm" });
  await insert("dms", { id });
  // Two rows, so the pair_key trigger sees a complete pair.
  await insert("dm_members", [{ dm_id: id, user_id: a }, { dm_id: id, user_id: b }]);
}

/** What the app itself would hold after signing in as this person. */
async function hydrateAs(email: string): Promise<AppState> {
  const client = await clientFor(email);
  return new SupabaseBackend(client).hydrate();
}

beforeAll(async () => {
  await seedRoles();

  // All three are plain Members: `members.manage` short-circuits
  // can_see_conversation and can_see_project, so an admin fixture would make
  // every negative below pass for the wrong reason.
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Ozzy", handle: `hyout${stamp}`, roleId: "member",
  });
  ids.insider = await createTestUser({
    email: emails.insider, password: TEST_PASSWORD,
    name: "Ines", handle: `hyin${stamp}`, roleId: "member",
  });
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Mo", handle: `hymate${stamp}`, roleId: "member",
  });

  await createChannel({
    id: pubChannel, name: `hy-open-${stamp}`, isPrivate: false, createdBy: ids.insider,
  });
  await createChannel({
    id: privChannel, name: `hy-shut-${stamp}`, isPrivate: true, createdBy: ids.insider,
  });
  await addChannelMember(privChannel, ids.insider, "editor");

  await createProject({
    id: openProject, name: `hy-open-${stamp}`, restricted: false, createdBy: ids.insider,
  });
  await createProject({
    id: secretProject, name: `hy-secret-${stamp}`, restricted: true, createdBy: ids.insider,
  });
  await addProjectMember(secretProject, ids.insider, "editor");
  await addProjectMember(secretProject, ids.mate, "editor");

  // Every row in a PostgREST bulk insert must name the SAME columns: the
  // request is one CSV-shaped payload, so a key present on one row and absent
  // on another is sent as NULL rather than falling back to the column default.
  // `labels` and `assignee_id` are spelled out on both rows for that reason.
  await insert("tasks", [
    {
      id: openTask, project_id: openProject, title: "Open work", status: "todo",
      priority: "medium", position: 3, created_by: ids.insider, assignee_id: null,
      due_date: "2026-09-08T10:00:00+00:00", labels: ["visible"],
    },
    {
      id: secretTask, project_id: secretProject, title: "Secret work", status: "in-review",
      priority: "high", position: 7, created_by: ids.insider, assignee_id: ids.insider,
      due_date: null, labels: [],
    },
  ]);
  // Two collaborator join rows on one task — the multi-row case the mapping
  // has to fold into a single `collaboratorIds` array.
  await addTaskCollaborator(secretTask, ids.mate);

  await createDm(dmOutsiderMate, ids.outsider, ids.mate);
  await createDm(dmInsiderMate, ids.insider, ids.mate);

  await insert("messages", [
    { id: msgPub, conversation_id: pubChannel, author_id: ids.insider, content: "anyone can read this" },
    { id: msgPriv, conversation_id: privChannel, author_id: ids.insider, content: "offer terms" },
    { id: msgDmA, conversation_id: dmOutsiderMate, author_id: ids.mate, content: "hi ozzy" },
    { id: msgDmB, conversation_id: dmInsiderMate, author_id: ids.insider, content: "hi mo" },
  ]);

  await insert("read_state", [
    { user_id: ids.outsider, conversation_id: pubChannel, last_read_at: OUTSIDER_READ_AT },
    { user_id: ids.insider, conversation_id: pubChannel, last_read_at: INSIDER_READ_AT },
  ]);

  // Warm both sessions here: signInAs's rate-limit backoff can span ~45s,
  // which fits this hook's 60s allowance but not a test's 30s one.
  await clientFor(emails.outsider);
  await clientFor(emails.insider);
});

afterAll(async () => {
  await serviceClient.from("projects").delete().in("id", [openProject, secretProject]);
  await serviceClient.from("conversations").delete().in("id", [
    pubChannel, privChannel, dmOutsiderMate, dmInsiderMate,
  ]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

// ---------------------------------------------------------------------------

describe("hydrate() as a member of nothing", () => {
  let state: AppState;
  beforeAll(async () => {
    state = await hydrateAs(emails.outsider);
  });

  it("holds no restricted project — by id and by count", () => {
    expect(state.projects.map((p) => p.id)).not.toContain(secretProject);
    expect(state.projects.filter((p) => p.restricted)).toHaveLength(0);
  });

  it("holds no task from a restricted project, and no collaborator of one", () => {
    expect(state.tasks.map((t) => t.id)).not.toContain(secretTask);
    expect(state.tasks.filter((t) => t.projectId === secretProject)).toHaveLength(0);
    // The join table is a separate policy from `tasks`: a leak here would
    // expose who is working on a project this user cannot see.
    expect(state.tasks.flatMap((t) => t.collaboratorIds)).not.toContain(ids.mate);
  });

  it("holds no private channel they are not in — by id and by count", () => {
    expect(state.channels.map((c) => c.id)).not.toContain(privChannel);
    expect(state.channels.filter((c) => c.isPrivate)).toHaveLength(0);
  });

  it("holds none of another pair's DM, thread or messages", () => {
    expect(state.dms.map((d) => d.id)).not.toContain(dmInsiderMate);
    expect(state.messages.map((m) => m.id)).not.toContain(msgDmB);
    // Nothing at all from either conversation they are outside of.
    expect(
      state.messages.filter((m) => m.channelId === dmInsiderMate || m.channelId === privChannel)
    ).toHaveLength(0);
  });

  it("holds nobody else's read positions", () => {
    const keys = Object.keys(state.lastRead);
    expect(keys).toContain(`${ids.outsider}:${pubChannel}`);
    expect(keys).not.toContain(`${ids.insider}:${pubChannel}`);
    expect(keys.every((k) => k.startsWith(`${ids.outsider}:`))).toBe(true);
    expect(state.lastRead[`${ids.outsider}:${pubChannel}`]).toBe(Date.parse(OUTSIDER_READ_AT));
  });

  // -- the positive controls. Without these, a hydrate() that threw away every
  // -- row (or returned an empty AppState) would pass everything above.
  it("does hold everything they are entitled to", () => {
    expect(state.currentUserId).toBe(ids.outsider);
    expect(state.users.map((u) => u.id)).toContain(ids.outsider);
    expect(state.roles.length).toBeGreaterThan(0);

    expect(state.channels.map((c) => c.id)).toContain(pubChannel);
    expect(state.messages.map((m) => m.id)).toContain(msgPub);

    expect(state.projects.map((p) => p.id)).toContain(openProject);
    expect(state.tasks.map((t) => t.id)).toContain(openTask);

    // Their own DM, and the message in it.
    expect(state.dms.map((d) => d.id)).toContain(dmOutsiderMate);
    expect(state.messages.map((m) => m.id)).toContain(msgDmA);
    const dm = state.dms.find((d) => d.id === dmOutsiderMate)!;
    expect([...dm.memberIds].sort()).toEqual([ids.outsider, ids.mate].sort());
  });

  it("maps the real rows it did get, not just their ids", () => {
    // The mapping unit tests use fixtures; this proves the same conversions
    // hold against columns Postgres actually produced.
    const task = state.tasks.find((t) => t.id === openTask)!;
    expect(task.order).toBe(3); // tasks.position
    expect(task.dueDate).toBe(Date.parse("2026-09-08T10:00:00+00:00"));
    expect(task.labels).toEqual(["visible"]);
    expect(task.status).toBe("todo");

    const message = state.messages.find((m) => m.id === msgPub)!;
    expect(message.channelId).toBe(pubChannel); // messages.conversation_id
    expect(message.authorId).toBe(ids.insider);
    expect(Number.isFinite(message.createdAt)).toBe(true);

    // The signed-in user resolves to a real profile — the Task 3 carry-over.
    const me = state.users.find((u) => u.id === state.currentUserId)!;
    expect(me.handle).toBe(`hyout${stamp}`);
    // Task 4: hydrate no longer guesses presence from the session — even the
    // signed-in user starts `offline` until a `{ kind: "presence" }` event off
    // the realtime channel says otherwise. See mapping.ts's `toUser`.
    expect(me.presence).toBe("offline");
  });
});

describe("hydrate() as a member of both restricted resources", () => {
  let state: AppState;
  beforeAll(async () => {
    state = await hydrateAs(emails.insider);
  });

  it("does hold the restricted project and its task, with collaborators", () => {
    expect(state.projects.map((p) => p.id)).toContain(secretProject);
    const project = state.projects.find((p) => p.id === secretProject)!;
    expect(project.restricted).toBe(true);
    expect(project.members.map((m) => m.userId).sort()).toEqual(
      [ids.insider, ids.mate].sort()
    );

    const task = state.tasks.find((t) => t.id === secretTask)!;
    expect(task).toBeDefined();
    expect(task.order).toBe(7);
    expect(task.assigneeId).toBe(ids.insider);
    expect(task.collaboratorIds).toContain(ids.mate);
  });

  it("does hold the private channel and its message", () => {
    expect(state.channels.map((c) => c.id)).toContain(privChannel);
    const channel = state.channels.find((c) => c.id === privChannel)!;
    expect(channel.isPrivate).toBe(true);
    expect(channel.members.map((m) => m.userId)).toContain(ids.insider);
    expect(state.messages.map((m) => m.id)).toContain(msgPriv);
  });

  it("still cannot see the other pair's DM — the boundary cuts both ways", () => {
    expect(state.dms.map((d) => d.id)).toContain(dmInsiderMate);
    expect(state.dms.map((d) => d.id)).not.toContain(dmOutsiderMate);
    expect(state.messages.map((m) => m.id)).toContain(msgDmB);
    expect(state.messages.map((m) => m.id)).not.toContain(msgDmA);
  });

  it("holds their own read position and not the outsider's", () => {
    expect(state.lastRead[`${ids.insider}:${pubChannel}`]).toBe(Date.parse(INSIDER_READ_AT));
    expect(state.lastRead[`${ids.outsider}:${pubChannel}`]).toBeUndefined();
  });
});
