// @vitest-environment jsdom
//
// Suite A5 — task ordering in lib/store.tsx: createTask appends at the end
// of its status column, and moveTask's renumbering of `Task.order` (the
// client field — the database `position` column is a separate layer, not
// tested here).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import { addProject, addTask, asUser, baseState, mount, run } from "./_support";
import type { TaskStatus } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const PROJECT_ID = "p_ordering";

function seedProjectWithTasks(count: number, status: TaskStatus = "todo") {
  let state = addProject(baseState(), { id: PROJECT_ID, name: "Ordering Project", createdBy: "u_vlad" });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `t_${status}_${i}`;
    ids.push(id);
    state = addTask(state, {
      id,
      projectId: PROJECT_ID,
      title: `Task ${i}`,
      createdBy: "u_vlad",
      status,
      order: i,
    });
  }
  return { state, ids };
}

/** Orders (sorted) of every task in a given project/status column. */
function ordersOf(tasks: { projectId: string; status: TaskStatus; order: number }[], status: TaskStatus) {
  return tasks
    .filter((t) => t.projectId === PROJECT_ID && t.status === status)
    .sort((a, b) => a.order - b.order)
    .map((t) => t.order);
}

describe("createTask appends at the end of its status column", () => {
  it("the persisted task gets order === the column size at the time of creation", async () => {
    const { state } = seedProjectWithTasks(3, "todo");
    const { result } = mount(asUser(state, "u_vlad"));
    const created = await run(() =>
      result.current.createTask({
        projectId: PROJECT_ID,
        title: "Fourth",
        description: "",
        status: "todo",
        priority: "medium",
        assigneeId: null,
        dueDate: null,
        startTime: null,
        durationMinutes: null,
        reminderMinutes: null,
        labels: [],
        attachments: [],
      })
    );
    expect(created).not.toBeNull();
    const persisted = result.current.state.tasks.find((t) => t.id === created!.id)!;
    expect(persisted.order).toBe(3);
    expect(ordersOf(result.current.state.tasks, "todo")).toEqual([0, 1, 2, 3]);
  });

  it("a new task in an empty column gets order 0, independent of other columns' counts", async () => {
    const { state } = seedProjectWithTasks(5, "todo");
    const { result } = mount(asUser(state, "u_vlad"));
    const created = await run(() =>
      result.current.createTask({
        projectId: PROJECT_ID,
        title: "First in-progress",
        description: "",
        status: "in-progress",
        priority: "medium",
        assigneeId: null,
        dueDate: null,
        startTime: null,
        durationMinutes: null,
        reminderMinutes: null,
        labels: [],
        attachments: [],
      })
    );
    expect(created).not.toBeNull();
    const persisted = result.current.state.tasks.find((t) => t.id === created!.id)!;
    expect(persisted.order).toBe(0);
  });

  // L1-010 (Low): createTask builds the `Task` object it returns to the
  // caller *before* calling update() — with `order: 0` hardcoded — and
  // returns that same pre-update object. The version actually written to
  // state (inside the update() callback) recomputes the real `order` as the
  // column's current size, but the caller never sees that corrected value:
  // the returned Task's `order` is always 0, regardless of how many tasks
  // are already in the column. Expected: the returned Task's `order` matches
  // what actually gets persisted. Actual: it's always 0.
  it(
    "L1-010: createTask's return value should carry the real order, but always reports 0",
    async () => {
      const { state } = seedProjectWithTasks(3, "todo");
      const { result } = mount(asUser(state, "u_vlad"));
      const created = await run(() =>
        result.current.createTask({
          projectId: PROJECT_ID,
          title: "Fourth",
          description: "",
          status: "todo",
          priority: "medium",
          assigneeId: null,
          dueDate: null,
          startTime: null,
          durationMinutes: null,
          reminderMinutes: null,
          labels: [],
          attachments: [],
        })
      );
      expect(created?.order).toBe(3); // actual: 0
    }
  );
});

describe("moveTask within a single column produces a dense 0..n-1 sequence", () => {
  it("moving the last task to the front renumbers everyone densely", async () => {
    const { state, ids } = seedProjectWithTasks(4, "todo");
    const { result } = mount(asUser(state, "u_vlad"));
    await run(() => result.current.moveTask(ids[3], "todo", 0));

    const tasks = result.current.state.tasks;
    expect(ordersOf(tasks, "todo")).toEqual([0, 1, 2, 3]);
    const byId = (id: string) => tasks.find((t) => t.id === id)!;
    expect(byId(ids[3]).order).toBe(0);
    expect(byId(ids[0]).order).toBe(1);
    expect(byId(ids[1]).order).toBe(2);
    expect(byId(ids[2]).order).toBe(3);
  });

  it("moving the first task to the end renumbers everyone densely", async () => {
    const { state, ids } = seedProjectWithTasks(4, "todo");
    const { result } = mount(asUser(state, "u_vlad"));
    await run(() => result.current.moveTask(ids[0], "todo", 3));

    const tasks = result.current.state.tasks;
    expect(ordersOf(tasks, "todo")).toEqual([0, 1, 2, 3]);
    const byId = (id: string) => tasks.find((t) => t.id === id)!;
    expect(byId(ids[1]).order).toBe(0);
    expect(byId(ids[2]).order).toBe(1);
    expect(byId(ids[3]).order).toBe(2);
    expect(byId(ids[0]).order).toBe(3);
  });

  it("moveTask clamps an out-of-range destination index to the column bounds", async () => {
    const { state, ids } = seedProjectWithTasks(3, "todo");
    const { result } = mount(asUser(state, "u_vlad"));
    await run(() => result.current.moveTask(ids[0], "todo", 999));
    const tasks = result.current.state.tasks;
    expect(ordersOf(tasks, "todo")).toEqual([0, 1, 2]);
    expect(tasks.find((t) => t.id === ids[0])!.order).toBe(2); // clamped to the end

    await run(() => result.current.moveTask(ids[0], "todo", -5));
    const tasks2 = result.current.state.tasks;
    expect(ordersOf(tasks2, "todo")).toEqual([0, 1, 2]);
    expect(tasks2.find((t) => t.id === ids[0])!.order).toBe(0); // clamped to the front
  });
});

describe("moveTask across columns opens a dense slot in the destination", () => {
  it("the destination column is a dense 0..n-1 sequence after the move", async () => {
    const { state, ids } = seedProjectWithTasks(3, "todo");
    const { result } = mount(asUser(state, "u_vlad"));
    await run(() => result.current.moveTask(ids[1], "in-progress", 0));

    const tasks = result.current.state.tasks;
    expect(ordersOf(tasks, "in-progress")).toEqual([0]);
    expect(tasks.find((t) => t.id === ids[1])!.status).toBe("in-progress");
  });

  // L1-007: the assignment brief for this suite states that moving a task
  // across columns "closes the gap in the source" column. moveTask's
  // `reordered` map is built only from tasks in the *destination* status
  // (`s.tasks.filter(t => t.status === toStatus && t.id !== taskId)`), so
  // source-column siblings are never touched — they keep their original
  // `order` values, leaving a hole where the moved task used to be. Expected:
  // the source column renumbers to a dense 0..n-1 run, same as the
  // within-column case. Actual: a gap remains (e.g. [0, 2] instead of [0, 1]
  // for a 3-task column after removing the middle task).
  it(
    "L1-007: moving a task out of a column should close the gap left behind, but does not",
    async () => {
      const { state, ids } = seedProjectWithTasks(3, "todo"); // orders 0, 1, 2
      const { result } = mount(asUser(state, "u_vlad"));
      await run(() => result.current.moveTask(ids[1], "in-progress", 0)); // remove the middle task

      const tasks = result.current.state.tasks;
      expect(ordersOf(tasks, "todo")).toEqual([0, 1]); // dense — but actually [0, 2]
    }
  );
});

describe("ordering is stable under repeated moves", () => {
  it("a sequence of moves never produces duplicate or out-of-range orders in the destination column", async () => {
    const { state, ids } = seedProjectWithTasks(5, "todo");
    const { result } = mount(asUser(state, "u_vlad"));

    await run(() => result.current.moveTask(ids[2], "todo", 0));
    await run(() => result.current.moveTask(ids[4], "todo", 2));
    await run(() => result.current.moveTask(ids[0], "todo", 4));

    const orders = ordersOf(result.current.state.tasks, "todo");
    expect(orders).toEqual([0, 1, 2, 3, 4]); // dense, no duplicates
  });

  it("moving a task back to the same index twice is idempotent", async () => {
    const { state, ids } = seedProjectWithTasks(4, "todo");
    const { result } = mount(asUser(state, "u_vlad"));
    await run(() => result.current.moveTask(ids[1], "todo", 2));
    const after1 = [...result.current.state.tasks]
      .filter((t) => t.projectId === PROJECT_ID && t.status === "todo")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);

    await run(() => result.current.moveTask(ids[1], "todo", 2));
    const after2 = [...result.current.state.tasks]
      .filter((t) => t.projectId === PROJECT_ID && t.status === "todo")
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);

    expect(after2).toEqual(after1);
  });

  it("moving a nonexistent task id is a silent no-op that leaves every column untouched", async () => {
    const { state } = seedProjectWithTasks(3, "todo");
    const { result } = mount(asUser(state, "u_vlad"));
    const before = [...result.current.state.tasks];
    await run(() => result.current.moveTask("t_does_not_exist", "in-progress", 0));
    expect(result.current.state.tasks).toEqual(before);
  });
});
