// @vitest-environment jsdom
//
// Completing a recurring task, from the store's side.
//
// The store has no single place that knows a task became done — `moveTask` and
// `updateTask` each detect it separately — so the cases here are run through
// BOTH, and `nextOccurrenceOf` is the one helper they share precisely so they
// cannot drift.
//
// The case that matters most is the last one: when the elevated RPC is refused,
// the completion must be REFUSED, not quietly downgraded to an ordinary one.
// A downgrade would leave a finished task still carrying its rule and no
// successor — a recurrence destroyed silently, which no later fix could
// notice.
import { afterEach, describe, expect, it } from "vitest";

import { FailingBackend } from "./_support";
import { addProject, addTask, adminState, asUser, mount, run } from "./_support";
import type { AppState, RepeatRule } from "@/lib/types";

afterEach(() => {
  localStorage.clear();
});

const SYD = "Australia/Sydney";
const WEEKLY: RepeatRule = { unit: "week", interval: 1, anchorDay: null, timeZone: SYD };
/** Local midnight in Sydney, a fortnight ago — safely in the past. */
const DUE = new Date("2026-06-01T00:00:00+10:00").getTime();

function workspace(rule: RepeatRule | null, status = "todo"): AppState {
  let state = addProject(adminState(), {
    id: "p_rec",
    name: "Recurring",
    createdBy: "u_vlad",
    restricted: false,
  });
  state = addTask(state, {
    id: "t_rec",
    projectId: "p_rec",
    title: "Weekly report",
    createdBy: "u_vlad",
    assigneeId: "u_maya",
    status,
    dueDate: DUE,
    repeat: rule,
  });
  return state;
}

const doneId = (state: AppState) => state.statuses.find((s) => s.isDone)!.id;
const openId = (state: AppState) => state.statuses.find((s) => !s.isDone)!.id;

describe("completing a recurring task", () => {
  it("through moveTask, appends a successor and moves the rule onto it", async () => {
    const state = workspace(WEEKLY);
    const store = (await mount(state)).result;
    await run(() => store.current.moveTask("t_rec", doneId(state), Number.MAX_SAFE_INTEGER));

    const tasks = store.current.state.tasks.filter((t) => t.projectId === "p_rec");
    expect(tasks).toHaveLength(2);

    const source = tasks.find((t) => t.id === "t_rec")!;
    const next = tasks.find((t) => t.id !== "t_rec")!;

    expect(source.status).toBe(doneId(state));
    expect(source.repeat).toBeNull();          // the rule moved on
    expect(next.status).toBe(openId(state));
    expect(next.repeat).toEqual(WEEKLY);       // including its timezone
    expect(next.title).toBe("Weekly report");
    expect(next.assigneeId).toBe("u_maya");
    expect(next.attachments).toEqual([]);
    // Measured from the due date, not from today, and strictly in the future.
    expect(next.dueDate).toBeGreaterThan(Date.now());
    expect((next.dueDate! - DUE) % (7 * 86_400_000)).toBe(0);
  });

  it("through updateTask, does the same thing", async () => {
    const state = workspace(WEEKLY);
    const store = (await mount(state)).result;
    await run(() => store.current.updateTask("t_rec", { status: doneId(state) }));

    const tasks = store.current.state.tasks.filter((t) => t.projectId === "p_rec");
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === "t_rec")!.repeat).toBeNull();
    expect(tasks.find((t) => t.id !== "t_rec")!.repeat).toEqual(WEEKLY);
  });

  it("CONTROL: a task with no rule creates nothing", async () => {
    // Without this, every assertion above would pass just as happily if the
    // store appended a copy of any task it completed.
    const state = workspace(null);
    const store = (await mount(state)).result;
    await run(() => store.current.moveTask("t_rec", doneId(state), 0));
    expect(store.current.state.tasks.filter((t) => t.projectId === "p_rec")).toHaveLength(1);
  });

  it("reopening a completed occurrence creates nothing, and it has no rule to repeat", async () => {
    const state = workspace(WEEKLY);
    const store = (await mount(state)).result;
    await run(() => store.current.moveTask("t_rec", doneId(state), 0));
    await run(() => store.current.moveTask("t_rec", openId(state), 0));
    // Two rows, not three: reopening is not a completion.
    expect(store.current.state.tasks.filter((t) => t.projectId === "p_rec")).toHaveLength(2);

    // And completing it AGAIN still creates nothing, because its rule left
    // with its first completion. This is what stops a drag that jitters across
    // the done column from minting a second occurrence.
    await run(() => store.current.moveTask("t_rec", doneId(state), 0));
    expect(store.current.state.tasks.filter((t) => t.projectId === "p_rec")).toHaveLength(2);
  });

  it("an open-to-open move creates nothing", async () => {
    const state = workspace(WEEKLY);
    const store = (await mount(state)).result;
    const anotherOpen = state.statuses.filter((s) => !s.isDone)[1]!.id;
    await run(() => store.current.moveTask("t_rec", anotherOpen, 0));
    expect(store.current.state.tasks.filter((t) => t.projectId === "p_rec")).toHaveLength(1);
  });

  it("regenerates for someone who cannot create tasks", async () => {
    // The client-side half of the decision the database enforces. Asserted as
    // its own case so a future `guard("task.create")` in this path cannot
    // creep in unnoticed.
    let state = workspace(WEEKLY);
    state = {
      ...asUser(state, "u_maya"),
      roles: state.roles.map((r) =>
        r.id === "member"
          ? { ...r, permissions: r.permissions.filter((p) => p !== "task.create") }
          : r
      ),
    };
    const store = (await mount(state)).result;
    expect(store.current.can("task.create")).toBe(false);

    await run(() => store.current.moveTask("t_rec", doneId(state), 0));
    expect(store.current.state.tasks.filter((t) => t.projectId === "p_rec")).toHaveLength(2);
  });
});

describe("when the elevated path is refused", () => {
  it("REFUSES the completion rather than downgrading it to an ordinary one", async () => {
    // This is the kill switch's behaviour: with EXECUTE revoked, the RPC
    // rejects. The task must stay open WITH its rule, so that re-granting is
    // all the recovery anyone needs. Falling through to `moveTask` would
    // finish it and strand the recurrence for ever.
    const state = workspace(WEEKLY);
    const backend = new FailingBackend("completeTask");
    const store = (await mount(state, backend)).result;

    const ok = await run(() => store.current.moveTask("t_rec", doneId(state), 0));
    expect(ok).toBe(false);

    const tasks = store.current.state.tasks.filter((t) => t.projectId === "p_rec");
    expect(tasks).toHaveLength(1);                       // nothing created
    expect(tasks[0].status).toBe("todo");                // and NOT completed
    expect(tasks[0].repeat).toEqual(WEEKLY);             // rule intact

    // The proof it did not silently take the ordinary path instead.
    expect(backend.attempted).toContain("completeTask");
    expect(backend.attempted).not.toContain("moveTask");
  });

  it("CONTROL: an ordinary completion still goes through moveTask", async () => {
    // So the assertion above means "recurring completions use the elevated
    // path" rather than "this store never calls moveTask".
    const state = workspace(null);
    const backend = new FailingBackend("completeTask");
    const store = (await mount(state, backend)).result;
    await run(() => store.current.moveTask("t_rec", doneId(state), 0));
    expect(backend.attempted).toContain("moveTask");
    expect(backend.attempted).not.toContain("completeTask");
  });
});
