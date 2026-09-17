// `complete_task_with_next`, attacked from real sessions.
//
// THE SECURITY ARGUMENT IS ONE PAIR. A user who does NOT hold `task.create`
// completes a recurring task and gets two rows — and that same user, in the
// same session, is refused a direct insert into `tasks`. The first without the
// second would only prove the function works; the second without the first
// would only prove RLS works. Together they say the elevation is real and
// goes no further than the one thing it exists for.
//
// Everything else here is that boundary's edges: a task that does not repeat,
// a replay, two calls at once, a stale reopening, an id collision.
//
// Sign-ins are rate-limited project-wide, so exactly two identities ever
// authenticate (tests/rls/task-writes.test.ts:13-36 explains the rule). `mate`
// deliberately holds a custom role with `task.edit` and `task.move` but NOT
// `task.create` — that role is the entire point of the file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestUser,
  deleteTestUser,
  serviceClient,
  signInAs,
  TEST_PASSWORD,
} from "../helpers/supabase";
import {
  addProjectMember,
  createProject,
  removeProjectMember,
  seedRoles,
} from "../helpers/workspace";
import { nextDueDate } from "@/lib/recurrence";
import type { RepeatRule } from "@/lib/types";

const stamp = Date.now();
const SYD = "Australia/Sydney";
const NO_CREATE_ROLE = `role_edit_only_${stamp}`;

const emails = {
  own: `rec-own-${stamp}@lumina.test`,
  mate: `rec-mate-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

/** Local midnight in the series' zone, as the app stores it. */
const dueAt = (ymd: string): string =>
  new Date(`${ymd}T00:00:00+10:00`).toISOString();

async function makeTask(opts: {
  id: string;
  projectId: string;
  due: string | null;
  rule: Partial<RepeatRule> | null;
  assignee?: string | null;
  status?: string;
}) {
  const { error } = await serviceClient.from("tasks").insert({
    id: opts.id,
    project_id: opts.projectId,
    title: opts.id,
    description: "",
    status: opts.status ?? "todo",
    priority: "medium",
    assignee_id: opts.assignee ?? null,
    due_date: opts.due,
    labels: [],
    created_by: ids.own,
    repeat_unit: opts.rule?.unit ?? null,
    repeat_interval: opts.rule?.interval ?? null,
    repeat_anchor_day: opts.rule?.anchorDay ?? null,
    repeat_tz: opts.rule?.timeZone ?? null,
  });
  if (error) throw new Error(`fixture ${opts.id}: ${error.message}`);
}

const rowsOf = async (projectId: string) => {
  const { data, error } = await serviceClient
    .from("tasks")
    .select("id,status,due_date,assignee_id,repeat_unit,recurred_from,position")
    .eq("project_id", projectId);
  if (error) throw new Error(error.message);
  return data ?? [];
};

const taskRow = async (id: string) => {
  const { data } = await serviceClient
    .from("tasks")
    .select("id,status,due_date,assignee_id,repeat_unit,repeat_tz,recurred_from")
    .eq("id", id)
    .maybeSingle();
  return data;
};

let doneStatus = "";
let openStatus = "";

beforeAll(async () => {
  await seedRoles();

  // A role that can finish work but not create it. Everything in this file
  // turns on the difference.
  const { error: roleErr } = await serviceClient.from("roles").upsert({
    id: NO_CREATE_ROLE,
    name: `Edit only ${stamp}`,
    permissions: ["task.edit", "task.move", "project.view"],
    locked: false,
    is_system: false,
  });
  if (roleErr) throw new Error(`role: ${roleErr.message}`);

  ids.own = await createTestUser({
    email: emails.own, password: TEST_PASSWORD,
    name: "Rec Owner", handle: `recown${stamp}`, roleId: "admin",
  });
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Rec Mate", handle: `recmate${stamp}`, roleId: NO_CREATE_ROLE,
  });

  const st = await serviceClient.from("statuses").select("id,is_done,position").order("position");
  doneStatus = st.data!.find((s) => s.is_done)!.id;
  openStatus = st.data!.find((s) => !s.is_done)!.id;
}, 120_000);

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id).catch(() => {});
  await serviceClient.from("roles").delete().eq("id", NO_CREATE_ROLE);
}, 120_000);

describe("the elevation, and its limit", () => {
  it("lets someone WITHOUT task.create complete a recurring task into a successor", async () => {
    const p = `p_rec_a_${stamp}`;
    await createProject({ id: p, name: "Rec A", restricted: false, createdBy: ids.own });
    await makeTask({
      id: `t_rec_a_${stamp}`, projectId: p, due: dueAt("2026-06-01"),
      rule: { unit: "week", interval: 1, anchorDay: null, timeZone: SYD },
    });

    const mate = await clientFor(emails.mate);
    const { data, error } = await mate.rpc("complete_task_with_next", {
      p_task_id: `t_rec_a_${stamp}`, p_index: 0, p_next_id: `t_rec_a_next_${stamp}`,
    });
    expect(error).toBeNull();
    expect(data?.[0]?.created).toBe(true);

    const rows = await rowsOf(p);
    expect(rows).toHaveLength(2);
    const source = rows.find((r) => r.id === `t_rec_a_${stamp}`)!;
    const succ = rows.find((r) => r.id === `t_rec_a_next_${stamp}`)!;
    expect(source.status).toBe(doneStatus);
    expect(source.repeat_unit).toBeNull();     // the rule moved on
    expect(succ.status).toBe(openStatus);
    expect(succ.repeat_unit).toBe("week");
    expect(succ.recurred_from).toBe(`t_rec_a_${stamp}`);
  });

  it("CONTROL: the same user, same session, cannot insert a task directly", async () => {
    // This is the half that makes the test above mean something. Without it,
    // "the elevated path worked" would be indistinguishable from "this user
    // could have created the row anyway".
    const p = `p_rec_a_${stamp}`;
    const mate = await clientFor(emails.mate);
    const id = `t_rec_direct_${stamp}`;
    const { error } = await mate.from("tasks").insert({
      id, project_id: p, title: "direct", description: "",
      status: openStatus, priority: "medium", labels: [],
    });
    expect(error).not.toBeNull();
    expect(await taskRow(id)).toBeNull();
  });

  it("REFUSES a task that does not repeat, creating nothing", async () => {
    // Without this guard the function is a way to create tasks without
    // task.create, against any row the caller can edit.
    const p = `p_rec_b_${stamp}`;
    await createProject({ id: p, name: "Rec B", restricted: false, createdBy: ids.own });
    await makeTask({ id: `t_plain_${stamp}`, projectId: p, due: dueAt("2026-06-01"), rule: null });

    const mate = await clientFor(emails.mate);
    const { error } = await mate.rpc("complete_task_with_next", {
      p_task_id: `t_plain_${stamp}`, p_index: 0, p_next_id: `t_plain_next_${stamp}`,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/does not repeat/i);
    expect(await taskRow(`t_plain_next_${stamp}`)).toBeNull();
    const src = await taskRow(`t_plain_${stamp}`);
    expect(src!.status).not.toBe(doneStatus);   // and it did not complete it either
  });
});

describe("one successor per occurrence", () => {
  it("TWO CALLS AT ONCE with different ids produce exactly one", async () => {
    // True concurrency, not sequential replay: both promises are in flight
    // before either resolves. `for update` serialises them and the second
    // finds the first's successor.
    const p = `p_rec_par_${stamp}`;
    await createProject({ id: p, name: "Rec Par", restricted: false, createdBy: ids.own });
    await makeTask({
      id: `t_par_${stamp}`, projectId: p, due: dueAt("2026-06-01"),
      rule: { unit: "day", interval: 1, anchorDay: null, timeZone: SYD },
    });

    const mate = await clientFor(emails.mate);
    const [a, b] = await Promise.all([
      mate.rpc("complete_task_with_next", {
        p_task_id: `t_par_${stamp}`, p_index: 0, p_next_id: `t_par_x_${stamp}`,
      }),
      mate.rpc("complete_task_with_next", {
        p_task_id: `t_par_${stamp}`, p_index: 0, p_next_id: `t_par_y_${stamp}`,
      }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();

    const rows = await rowsOf(p);
    expect(rows.filter((r) => r.recurred_from === `t_par_${stamp}`)).toHaveLength(1);
    expect(rows).toHaveLength(2);
    // Exactly one call reports having created it.
    expect([a.data?.[0]?.created, b.data?.[0]?.created].filter(Boolean)).toHaveLength(1);
  });

  it("a sequential second call with a different id returns the first successor, created:false", async () => {
    const p = `p_rec_seq_${stamp}`;
    await createProject({ id: p, name: "Rec Seq", restricted: false, createdBy: ids.own });
    await makeTask({
      id: `t_seq_${stamp}`, projectId: p, due: dueAt("2026-06-01"),
      rule: { unit: "day", interval: 1, anchorDay: null, timeZone: SYD },
    });
    const mate = await clientFor(emails.mate);
    const first = await mate.rpc("complete_task_with_next", {
      p_task_id: `t_seq_${stamp}`, p_index: 0, p_next_id: `t_seq_a_${stamp}`,
    });
    const second = await mate.rpc("complete_task_with_next", {
      p_task_id: `t_seq_${stamp}`, p_index: 5, p_next_id: `t_seq_b_${stamp}`,
    });
    expect(first.data?.[0]?.created).toBe(true);
    expect(second.data?.[0]?.created).toBe(false);
    expect(await taskRow(`t_seq_b_${stamp}`)).toBeNull();
    expect(await rowsOf(p)).toHaveLength(2);
  });

  it("A REPLAY DOES NOT UNDO A LATER REOPENING", async () => {
    // The retry path must mutate nothing. If it re-applied the caller's move,
    // a delayed retry would silently re-complete a task somebody deliberately
    // reopened — and with a different p_index, shove it somewhere else.
    const p = `p_rec_reopen_${stamp}`;
    await createProject({ id: p, name: "Rec Reopen", restricted: false, createdBy: ids.own });
    await makeTask({
      id: `t_reopen_${stamp}`, projectId: p, due: dueAt("2026-06-01"),
      rule: { unit: "day", interval: 1, anchorDay: null, timeZone: SYD },
    });
    const mate = await clientFor(emails.mate);
    await mate.rpc("complete_task_with_next", {
      p_task_id: `t_reopen_${stamp}`, p_index: 0, p_next_id: `t_reopen_n_${stamp}`,
    });
    // Somebody reopens it.
    await serviceClient.from("tasks").update({ status: openStatus }).eq("id", `t_reopen_${stamp}`);

    // A stale client retries the original completion.
    const replay = await mate.rpc("complete_task_with_next", {
      p_task_id: `t_reopen_${stamp}`, p_index: 99, p_next_id: `t_reopen_n_${stamp}`,
    });
    expect(replay.error).toBeNull();
    expect(replay.data?.[0]?.created).toBe(false);

    const src = await taskRow(`t_reopen_${stamp}`);
    expect(src!.status).toBe(openStatus);  // the reopening survived
    expect(await rowsOf(p)).toHaveLength(2);
  });

  it("REFUSES an id that collides with an unrelated task, leaving the source untouched", async () => {
    const p = `p_rec_col_${stamp}`;
    await createProject({ id: p, name: "Rec Col", restricted: false, createdBy: ids.own });
    await makeTask({
      id: `t_col_${stamp}`, projectId: p, due: dueAt("2026-06-01"),
      rule: { unit: "day", interval: 1, anchorDay: null, timeZone: SYD },
    });
    await makeTask({ id: `t_col_other_${stamp}`, projectId: p, due: null, rule: null });

    const mate = await clientFor(emails.mate);
    const { error } = await mate.rpc("complete_task_with_next", {
      p_task_id: `t_col_${stamp}`, p_index: 0, p_next_id: `t_col_other_${stamp}`,
    });
    expect(error).not.toBeNull();

    const src = await taskRow(`t_col_${stamp}`);
    expect(src!.status).not.toBe(doneStatus);
    expect(src!.repeat_unit).toBe("day");   // the rule was NOT lost
  });
});

describe("the date the database computes", () => {
  it("agrees with lib/recurrence.ts across units, intervals, anchors and zones", async () => {
    // Two implementations of one algorithm. This is what holds them together.
    const cases: Array<{ due: string; rule: RepeatRule }> = [
      { due: "2026-06-01", rule: { unit: "day", interval: 1, anchorDay: null, timeZone: SYD } },
      { due: "2026-06-01", rule: { unit: "day", interval: 10, anchorDay: null, timeZone: SYD } },
      { due: "2026-06-01", rule: { unit: "week", interval: 2, anchorDay: null, timeZone: SYD } },
      { due: "2026-01-31", rule: { unit: "month", interval: 1, anchorDay: 31, timeZone: SYD } },
      { due: "2026-06-15", rule: { unit: "month", interval: 3, anchorDay: 15, timeZone: SYD } },
      { due: "2026-06-01", rule: { unit: "week", interval: 1, anchorDay: null, timeZone: "America/New_York" } },
    ];
    const p = `p_rec_agree_${stamp}`;
    await createProject({ id: p, name: "Rec Agree", restricted: false, createdBy: ids.own });
    const mate = await clientFor(emails.mate);

    for (const [i, c] of cases.entries()) {
      const id = `t_ag_${i}_${stamp}`;
      await makeTask({
        id, projectId: p,
        due: new Date(`${c.due}T00:00:00${c.rule.timeZone === SYD ? "+10:00" : "-04:00"}`).toISOString(),
        rule: c.rule,
      });
      const src = await taskRow(id);
      const { data, error } = await mate.rpc("complete_task_with_next", {
        p_task_id: id, p_index: 0, p_next_id: `t_ag_${i}_n_${stamp}`,
      });
      expect(error, `case ${i}`).toBeNull();

      const fromSql = Date.parse(data![0].next_due as string);
      const fromTs = nextDueDate(Date.parse(src!.due_date as string), c.rule);
      expect(fromSql, `case ${i} (${c.rule.unit}/${c.rule.interval})`).toBe(fromTs);
    }
  }, 120_000);
});

describe("who may call it", () => {
  it("REFUSES a project the caller cannot see, with the same message as a missing task", async () => {
    const p = `p_rec_secret_${stamp}`;
    await createProject({ id: p, name: "Rec Secret", restricted: true, createdBy: ids.own });
    await makeTask({
      id: `t_secret_${stamp}`, projectId: p, due: dueAt("2026-06-01"),
      rule: { unit: "day", interval: 1, anchorDay: null, timeZone: SYD },
    });

    const mate = await clientFor(emails.mate);
    const { error } = await mate.rpc("complete_task_with_next", {
      p_task_id: `t_secret_${stamp}`, p_index: 0, p_next_id: `t_secret_n_${stamp}`,
    });
    expect(error).not.toBeNull();
    // Not an existence oracle: identical to the message for a task that is
    // simply not there.
    expect(error!.message).toMatch(/does not exist/i);
    expect(await taskRow(`t_secret_n_${stamp}`)).toBeNull();

    const missing = await mate.rpc("complete_task_with_next", {
      p_task_id: `t_nope_${stamp}`, p_index: 0, p_next_id: `t_nope_n_${stamp}`,
    });
    expect(missing.error!.message).toBe(error!.message);
  });

  it("CONTROL: an admin who can see it completes the same task", async () => {
    const own = await clientFor(emails.own);
    const { data, error } = await own.rpc("complete_task_with_next", {
      p_task_id: `t_secret_${stamp}`, p_index: 0, p_next_id: `t_secret_ok_${stamp}`,
    });
    expect(error).toBeNull();
    expect(data?.[0]?.created).toBe(true);
  });
});

describe("what the successor carries", () => {
  it("prunes an owner who can no longer see the project, rather than failing the completion", async () => {
    const p = `p_rec_prune_${stamp}`;
    await createProject({ id: p, name: "Rec Prune", restricted: true, createdBy: ids.own });
    // Assign while they CAN see it, then revoke — the real sequence, and the
    // only one the database allows: `tasks_check_assignee` is a trigger, so it
    // fires on the service client too and refuses the shortcut of assigning
    // somebody who already cannot see the project.
    await addProjectMember(p, ids.mate, "editor");
    await makeTask({
      id: `t_prune_${stamp}`, projectId: p, due: dueAt("2026-06-01"),
      rule: { unit: "day", interval: 1, anchorDay: null, timeZone: SYD },
      assignee: ids.mate,
    });
    await removeProjectMember(p, ids.mate);

    const own = await clientFor(emails.own);
    const { data, error } = await own.rpc("complete_task_with_next", {
      p_task_id: `t_prune_${stamp}`, p_index: 0, p_next_id: `t_prune_n_${stamp}`,
    });
    expect(error).toBeNull();
    expect(data?.[0]?.next_assignee).toBeNull();
    const succ = await taskRow(`t_prune_n_${stamp}`);
    expect(succ!.assignee_id).toBeNull();
  });

  it("carries the rule, including its timezone, to the successor", async () => {
    const succ = await taskRow(`t_rec_a_next_${stamp}`);
    expect(succ!.repeat_tz).toBe(SYD);
  });
});
