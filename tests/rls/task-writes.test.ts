import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import type { Task } from "@/lib/types";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import {
  addProjectMember, createProject, removeProjectMember, seedRoles,
} from "../helpers/workspace";

// Task 7 — `SupabaseBackend`'s four task writes against lumina-dev, under the
// real policies and the real triggers.
//
// tests/qa/task-writes.test.ts proves what the STORE does with a resolved or
// rejected promise, and tests/qa/supabase-backend.test.ts proves what this
// backend SENDS. This file is the only place the two claims that matter can
// actually be observed:
//
//   * the server owns `position` and the reordering, so two people dragging at
//     once cannot both claim a slot;
//   * the four findings from the collaborators review (final-review.md F1-F4)
//     still hold now that the store defers to the database. They were proven
//     against the store, whose guards these writes now run *in front of* rather
//     than instead of.
//
// Every negative is paired with a positive control on the SAME client and the
// SAME method, so a backend that had simply stopped working could not pass by
// failing everything.
//
// Frugal like every file here: Supabase rate-limits signInWithPassword per
// project across the whole run and these files execute in parallel forks.
// Exactly TWO identities ever sign in — `own` (an admin) and `mate` (a plain
// Member, who holds task.create/edit/move but NOT task.delete and NOT
// members.manage). `stray` exists to be assigned, refused and pruned, and never
// authenticates.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const emails = {
  own: `twown-${stamp}@lumina.test`,
  mate: `twmate-${stamp}@lumina.test`,
  stray: `twstray-${stamp}@lumina.test`,
  ghost: `twghost-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};
const createdProjects = new Set<string>();

async function backendFor(email: string): Promise<SupabaseBackend> {
  return new SupabaseBackend(await clientFor(email));
}

/** A `Task` shaped as the store would hand it over. `order` is deliberately a
 *  nonsense value: the trigger assigns the real one and the backend must not
 *  send this. */
function task(id: string, projectId: string, over: Partial<Task> = {}): Task {
  return {
    id, projectId, title: `TW ${id}`, description: "", status: "todo",
    priority: "medium", assigneeId: null, dueDate: null, startTime: null,
    durationMinutes: null, reminderMinutes: null, labels: [], attachments: [],
    order: 999, createdAt: Date.now(), createdBy: ids.own, collaboratorIds: [],
    ...over,
  };
}

async function project(id: string, restricted: boolean): Promise<string> {
  createdProjects.add(id);
  await createProject({ id, name: `TW ${id}`, restricted, createdBy: ids.own });
  await addProjectMember(id, ids.own, "editor");
  return id;
}

/** Positions in one column, by task id, read past RLS. */
async function column(projectId: string, status: string): Promise<Record<string, number>> {
  const { data, error } = await serviceClient
    .from("tasks").select("id,position").eq("project_id", projectId).eq("status", status);
  if (error) throw new Error(`column failed: ${error.message}`);
  return Object.fromEntries((data ?? []).map((t) => [t.id, t.position]));
}

async function collaboratorsOn(taskId: string): Promise<string[]> {
  const { data, error } = await serviceClient
    .from("task_collaborators").select("user_id").eq("task_id", taskId);
  if (error) throw new Error(`collaboratorsOn failed: ${error.message}`);
  return (data ?? []).map((r) => r.user_id).sort();
}

async function taskRow(taskId: string) {
  const { data } = await serviceClient
    .from("tasks").select("project_id,status,position,assignee_id,title").eq("id", taskId)
    .maybeSingle();
  return data;
}

beforeAll(async () => {
  await seedRoles();
  ids.own = await createTestUser({
    email: emails.own, password: TEST_PASSWORD,
    name: "Ola", handle: `twola${stamp}`, roleId: "admin",
  });
  // Plain Member: task.create, task.edit and task.move, but NOT task.delete and
  // NOT members.manage. Every refusal aimed at this identity is therefore the
  // policy talking, not an admin fixture papering over it.
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Mio", handle: `twmio${stamp}`, roleId: "member",
  });
  ids.stray = await createTestUser({
    email: emails.stray, password: TEST_PASSWORD,
    name: "Stu", handle: `twstu${stamp}`, roleId: "member",
  });
  // A second outsider, needed only because the obvious candidate for "somebody
  // new who cannot see this project" is already the task's owner, and the
  // owner-is-never-a-collaborator rule would answer first and mask the one
  // being tested.
  ids.ghost = await createTestUser({
    email: emails.ghost, password: TEST_PASSWORD,
    name: "Gus", handle: `twgus${stamp}`, roleId: "member",
  });

  await clientFor(emails.own);
  await clientFor(emails.mate);
}, 60_000);

afterAll(async () => {
  await serviceClient.from("projects").delete().in("id", [...createdProjects]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

// ---------------------------------------------------------------------------
// The server owns the position.
// ---------------------------------------------------------------------------
describe("createTask — position comes from the trigger", () => {
  it("appends each new card to the end of its own column, ignoring what the client guessed", async () => {
    const p = await project(`p_tw_pos_${stamp}`, false);
    const backend = await backendFor(emails.own);

    const first = await backend.createTask(task(`t_tw_pos_a_${stamp}`, p));
    const second = await backend.createTask(task(`t_tw_pos_b_${stamp}`, p));
    // A different column of the SAME project starts again at zero.
    const other = await backend.createTask(
      task(`t_tw_pos_c_${stamp}`, p, { status: "in-progress" })
    );

    // The resolved Task carries the server's number, which is what the store
    // adopts — not the 999 it was handed.
    expect([first.order, second.order, other.order]).toEqual([0, 1, 0]);
    expect(await column(p, "todo")).toEqual({
      [`t_tw_pos_a_${stamp}`]: 0,
      [`t_tw_pos_b_${stamp}`]: 1,
    });
  });

  it("REFUSES a task in a project the caller cannot see, and writes no row", async () => {
    // The positive control is the test above: same method, same client.
    const p = await project(`p_tw_pos_locked_${stamp}`, true);
    const backend = await backendFor(emails.mate);
    const id = `t_tw_pos_denied_${stamp}`;

    await expect(backend.createTask(task(id, p))).rejects.toThrow();
    expect(await taskRow(id)).toBeNull();
  });
});

describe("moveTask — the RPC renumbers, not the client", () => {
  it("reorders within a column and closes the gap in the source column", async () => {
    const p = await project(`p_tw_move_${stamp}`, false);
    const backend = await backendFor(emails.own);
    const a = `t_tw_move_a_${stamp}`;
    const b = `t_tw_move_b_${stamp}`;
    const c = `t_tw_move_c_${stamp}`;
    for (const id of [a, b, c]) await backend.createTask(task(id, p));
    expect(await column(p, "todo")).toEqual({ [a]: 0, [b]: 1, [c]: 2 });

    await expect(backend.moveTask(c, "todo", 0)).resolves.toBeUndefined();
    expect(await column(p, "todo")).toEqual({ [c]: 0, [a]: 1, [b]: 2 });

    // MAX_SAFE_INTEGER is what the board's "move to done" buttons pass, and
    // `move_task(p_index integer)` cannot hold it — unclamped this is a 22003
    // rather than an append.
    await expect(
      backend.moveTask(c, "done", Number.MAX_SAFE_INTEGER)
    ).resolves.toBeUndefined();
    expect(await column(p, "done")).toEqual({ [c]: 0 });
    // Dense 0..n-1 again, with no hole where c used to be.
    expect(await column(p, "todo")).toEqual({ [a]: 0, [b]: 1 });
  });

  it("REFUSES a move on a project the caller cannot see", async () => {
    const p = await project(`p_tw_move_locked_${stamp}`, true);
    const owner = await backendFor(emails.own);
    const id = `t_tw_move_locked_${stamp}`;
    await owner.createTask(task(id, p));

    const backend = await backendFor(emails.mate);
    await expect(backend.moveTask(id, "done", 0)).rejects.toThrow();
    expect((await taskRow(id))!.status).toBe("todo");
  });
});

// ---------------------------------------------------------------------------
// F4 — the owner slot is checked exactly like the collaborator slot.
// ---------------------------------------------------------------------------
describe("F4 — assignment never grants access, in EITHER slot", () => {
  it("refuses a new task whose owner cannot see the project, leaving no row behind", async () => {
    const p = await project(`p_tw_f4_${stamp}`, true);
    await addProjectMember(p, ids.mate, "editor");
    const backend = await backendFor(emails.own);
    const id = `t_tw_f4_owner_${stamp}`;

    await expect(
      backend.createTask(task(id, p, { assigneeId: ids.stray }))
    ).rejects.toThrow(/cannot see this task's project/);
    // BEFORE INSERT, so the row never existed — not "inserted then swept".
    expect(await taskRow(id)).toBeNull();
  });

  it("refuses a new task whose COLLABORATOR cannot see it, and sweeps the task it had written", async () => {
    // The collaborator check is a different trigger on a different table, and
    // it fires after the task row already exists — hence the sweep, without
    // which the board would keep a task whose people were all rejected.
    const p = `p_tw_f4_${stamp}`;
    const backend = await backendFor(emails.own);
    const id = `t_tw_f4_collab_${stamp}`;

    await expect(
      backend.createTask(task(id, p, { collaboratorIds: [ids.stray] }))
    ).rejects.toThrow(/cannot see this task's project/);
    expect(await taskRow(id)).toBeNull();
  });

  it("ACCEPTS both slots when the people can see it — the positive control", async () => {
    // Same method, same client, same project. Without this, the two refusals
    // above would also pass against a createTask that never worked at all.
    const p = `p_tw_f4_${stamp}`;
    const backend = await backendFor(emails.own);
    const id = `t_tw_f4_ok_${stamp}`;

    await expect(
      backend.createTask(task(id, p, { assigneeId: ids.mate, collaboratorIds: [ids.own] }))
    ).resolves.toMatchObject({ id });
    expect((await taskRow(id))!.assignee_id).toBe(ids.mate);
    expect(await collaboratorsOn(id)).toEqual([ids.own]);
  });

  it("refuses REASSIGNING an existing task to somebody who cannot see the project", async () => {
    const backend = await backendFor(emails.own);
    const id = `t_tw_f4_ok_${stamp}`;

    await expect(
      backend.updateTask(id, { assigneeId: ids.stray })
    ).rejects.toThrow(/cannot see this task's project/);
    expect((await taskRow(id))!.assignee_id).toBe(ids.mate);
  });
});

// ---------------------------------------------------------------------------
// The rule the store and this backend have to agree on: only what a patch
// NEWLY assigns is re-checked. Both triggers are absolute about the people they
// see, so the backend's job is to not show them anybody who was already there.
// ---------------------------------------------------------------------------
describe("a stale assignment does not make a task uneditable", () => {
  const p = `p_tw_stale_${stamp}`;
  const id = `t_tw_stale_${stamp}`;

  beforeAll(async () => {
    // Built OPEN so `stray` can legitimately be put on the task, then closed
    // behind them WITHOUT deleting a project_members row — the one path that
    // leaves a stale collaborator, because the pruning trigger fires on a
    // project_members DELETE and there is nothing to delete.
    await project(p, false);
    const backend = await backendFor(emails.own);
    await backend.createTask(
      task(id, p, { assigneeId: ids.mate, collaboratorIds: [ids.stray] })
    );
    await addProjectMember(p, ids.mate, "editor");
    await serviceClient.from("projects").update({ restricted: true }).eq("id", p);
    // ...and now revoke the OWNER's access too, so both slots are stale.
    await removeProjectMember(p, ids.mate);
    expect(await collaboratorsOn(id)).toEqual([ids.stray]);
    expect((await taskRow(id))!.assignee_id).toBe(ids.mate);
  }, 30_000);

  it("CONTROL: the database really would refuse both of them today", async () => {
    // This is what makes the next test mean something. If either write were
    // somehow acceptable now, "the edit succeeded" would prove nothing about
    // what the backend chose to send.
    const owner = await serviceClient
      .from("tasks").update({ assignee_id: ids.mate }).eq("id", id);
    expect(owner.error?.message).toMatch(/cannot see this task's project/);

    const collaborator = await serviceClient
      .from("task_collaborators").insert({ task_id: id, user_id: ids.stray });
    // Already present, so the primary key answers first — the point is that it
    // cannot be re-created, whichever guard gets there.
    expect(collaborator.error).not.toBeNull();
  });

  it("saves an unrelated edit that RE-SENDS the same owner and collaborator", async () => {
    // components/task-dialog.tsx sends both on every save. Putting an unchanged
    // `assignee_id` in the SET list re-fires `tasks_check_assignee` (it triggers
    // on the column being written, not on it changing), and re-inserting a
    // collaborator re-fires `check_task_collaborator` — so a backend that
    // rewrote the whole assignment would make this task uneditable by everyone.
    const backend = await backendFor(emails.own);

    await expect(
      backend.updateTask(id, {
        title: "Salary bands 2027",
        assigneeId: ids.mate,
        collaboratorIds: [ids.stray],
      })
    ).resolves.toBeUndefined();

    const row = await taskRow(id);
    expect(row!.title).toBe("Salary bands 2027");
    expect(row!.assignee_id).toBe(ids.mate);
    expect(await collaboratorsOn(id)).toEqual([ids.stray]);
  });

  it("saves a patch that assigns nobody at all — the home page's quick-complete", async () => {
    const backend = await backendFor(emails.own);
    await expect(backend.updateTask(id, { status: "done" })).resolves.toBeUndefined();
    expect((await taskRow(id))!.status).toBe("done");
  });

  it("still REFUSES adding somebody NEW who cannot see the project", async () => {
    // The negative control for the two above: the guard is narrowed to new
    // assignments, not switched off.
    const backend = await backendFor(emails.own);

    // `ghost` is genuinely new to this task, so the diff inserts them and
    // `check_task_collaborator` gets to speak. `stray` rides along unchanged in
    // the same list and is NOT what raises — which is the distinction.
    await expect(
      backend.updateTask(id, { collaboratorIds: [ids.stray, ids.ghost] })
    ).rejects.toThrow(/cannot see this task's project/);
    expect(await collaboratorsOn(id)).toEqual([ids.stray]);
  });

  it("removes a collaborator when the patch really drops them", async () => {
    // Positive control for the diff: it is a diff, not a no-op.
    const backend = await backendFor(emails.own);
    await expect(backend.updateTask(id, { collaboratorIds: [] })).resolves.toBeUndefined();
    expect(await collaboratorsOn(id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F1 + F2 — revoking project access removes the collaborator rows, and the
// revoked person can no longer see the task.
// ---------------------------------------------------------------------------
describe("F1/F2 — revoking access takes the collaborator row AND the sight of it", () => {
  const p = `p_tw_revoke_${stamp}`;
  const id = `t_tw_revoke_${stamp}`;

  beforeAll(async () => {
    await project(p, true);
    await addProjectMember(p, ids.mate, "editor");
    const backend = await backendFor(emails.own);
    await backend.createTask(task(id, p, { collaboratorIds: [ids.mate] }));
  }, 30_000);

  it("CONTROL: the collaborator can see the task and their own row while they are a member", async () => {
    const client = await clientFor(emails.mate);
    const { data: tasks } = await client.from("tasks").select("id").eq("id", id);
    expect(tasks).toHaveLength(1);
    const { data: rows } = await client
      .from("task_collaborators").select("user_id").eq("task_id", id);
    expect(rows).toHaveLength(1);
  });

  it("F2 — setProjectAccess deletes the revoked collaborator's row", async () => {
    const backend = await backendFor(emails.own);
    await expect(
      backend.setProjectAccess(p, {
        restricted: true, members: [{ userId: ids.own, level: "editor" }],
      })
    ).resolves.toBeUndefined();
    expect(await collaboratorsOn(id)).toEqual([]);
  });

  it("F1 — and that person can no longer read the task at all", async () => {
    const client = await clientFor(emails.mate);
    const { data: tasks, error } = await client.from("tasks").select("id").eq("id", id);
    expect(error).toBeNull(); // filtered, not errored — the shape RLS produces
    expect(tasks).toEqual([]);
    const { data: rows } = await client
      .from("task_collaborators").select("user_id").eq("task_id", id);
    expect(rows).toEqual([]);
  });

  it("CONTROL: the task is still there for somebody who can see it", async () => {
    // Without this, a `tasks` table that had simply been emptied would satisfy
    // the assertion above.
    const client = await clientFor(emails.own);
    const { data } = await client.from("tasks").select("id").eq("id", id);
    expect(data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F3 — re-parenting must not strand collaborators.
// ---------------------------------------------------------------------------
describe("F3 — re-parenting a task", () => {
  const from = `p_tw_from_${stamp}`;
  const to = `p_tw_to_${stamp}`;
  const id = `t_tw_reparent_${stamp}`;

  beforeAll(async () => {
    await project(from, false);
    await project(to, true);
    const backend = await backendFor(emails.own);
    await backend.createTask(task(id, from, { collaboratorIds: [ids.stray, ids.own] }));
  }, 30_000);

  it("is refused by the backend outright — a task never changes project", async () => {
    // `TaskPatch` excludes `projectId`, so only a cast reaches this. Dropping
    // the key quietly would leave a caller believing the move happened.
    const backend = await backendFor(emails.own);
    await expect(
      backend.updateTask(id, { projectId: to } as never)
    ).rejects.toThrow(/different project/);
    expect((await taskRow(id))!.project_id).toBe(from);
  });

  it("and if one happens in Postgres anyway, the stranded collaborator is pruned", async () => {
    // The reviewer's own probe (final-review.md, "A1 re-parent") did exactly
    // this and found the row surviving. `own` is a member of the destination
    // and must be KEPT — a trigger that deleted every collaborator would pass a
    // one-sided assertion.
    expect(await collaboratorsOn(id)).toEqual([ids.own, ids.stray].sort());

    const { error } = await serviceClient
      .from("tasks").update({ project_id: to }).eq("id", id);
    expect(error).toBeNull();

    expect(await collaboratorsOn(id)).toEqual([ids.own]);
  });
});

// ---------------------------------------------------------------------------
// deleteTask — the boolean components/task-dialog.tsx honours.
// ---------------------------------------------------------------------------
describe("deleteTask", () => {
  it("REJECTS a caller without task.delete rather than reporting success", async () => {
    // `tasks_delete` filters the row away, which PostgREST reports as
    // `error: null` and zero rows. A backend that only checked `error` would
    // resolve, and the dialog would toast "Task deleted" and close over a card
    // that is still on the board.
    const p = await project(`p_tw_del_${stamp}`, false);
    const owner = await backendFor(emails.own);
    const id = `t_tw_del_${stamp}`;
    await owner.createTask(task(id, p, { collaboratorIds: [ids.mate] }));

    const backend = await backendFor(emails.mate);
    await expect(backend.deleteTask(id)).rejects.toThrow(/permission/i);
    expect(await taskRow(id)).not.toBeNull();
  });

  it("deletes the task and CASCADES to its collaborator rows", async () => {
    const id = `t_tw_del_${stamp}`;
    expect(await collaboratorsOn(id)).toEqual([ids.mate]);

    const backend = await backendFor(emails.own);
    await expect(backend.deleteTask(id)).resolves.toBeUndefined();

    expect(await taskRow(id)).toBeNull();
    // The client never deletes these; the foreign key does.
    expect(await collaboratorsOn(id)).toEqual([]);
  });
});
