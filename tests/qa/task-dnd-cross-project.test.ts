// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { COLUMN_PREFIX, indexWithinProject, orderColumn, useTaskDnd } from "@/components/kanban/use-task-dnd";
import { StoreProvider } from "@/lib/store";
import { LocalBackend, STORAGE_KEY } from "@/lib/backend/local";
import { addProject, addTask, adminState } from "./_support";
import type { AppState, Task, TaskStatus } from "@/lib/types";

const t = (id: string, projectId: string, order: number): Task =>
  ({ id, projectId, order, status: "todo", title: id, collaboratorIds: [], assigneeId: null } as unknown as Task);
const name = (x: Task) => ({ p_b: "Beta", p_a: "Alpha" }[x.projectId] ?? x.projectId);

describe("orderColumn", () => {
  it("in one project, sorts by order — exactly as before", () => {
    expect(orderColumn([t("x", "p_a", 2), t("y", "p_a", 0)], false, name).map((x) => x.id)).toEqual(["y", "x"]);
  });
  it("across projects, groups by project name and keeps each project's order inside the group", () => {
    const col = [t("b1", "p_b", 0), t("a2", "p_a", 1), t("b0", "p_b", 1), t("a1", "p_a", 0)];
    expect(orderColumn(col, true, name).map((x) => x.id)).toEqual(["a1", "a2", "b1", "b0"]);
  });
});

describe("indexWithinProject", () => {
  // `order` is dense only within project+status, so the index moveTask needs
  // is the position among the SAME project's tasks in the destination.
  const dest = [t("a1", "p_a", 0), t("a2", "p_a", 1), t("b1", "p_b", 0)];
  it("counts only the task's own project's cards before the drop point", () => {
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 0)).toBe(0);
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 1)).toBe(1);
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 3)).toBe(2);
  });
  it("appends when the project has nothing in that column yet", () => {
    expect(indexWithinProject(dest, t("c1", "p_c", 0), 1)).toBe(0);
  });
});

// Fix round 1 (D3): `onDragOver` computes its index over the same merged,
// display-ordered `byStatus[overStatus]` column as `onDragEnd` does, and on
// a cross-project board that column interleaves several projects' dense
// runs exactly the way `onDragEnd`'s does. Sending that raw, merged index
// straight to `moveTask` — which filters by the dragged task's own
// project — lands the card at the wrong slot within its own project (in
// practice: usually clamped to the end). These tests reproduce that on the
// hook itself, the way tests/qa/drag-moves.test.ts does, by recording the
// index a slow backend actually receives.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Records every `moveTask(status, index)` call and never resolves it,
 *  mirroring `SlowMoveBackend` in tests/qa/drag-moves.test.ts — enough to
 *  see what index `onDragOver` sent without needing the call to settle. */
class RecordingMoveBackend extends LocalBackend {
  readonly calls: Array<{ status: TaskStatus; index: number }> = [];

  override moveTask(...args: unknown[]): Promise<void> {
    this.calls.push({ status: args[1] as TaskStatus, index: args[2] as number });
    return new Promise<void>(() => {
      // Deliberately never resolves — nothing here awaits settlement,
      // only the index synchronously passed to the backend call.
    });
  }
}

// `adminState()` is the full seeded demo workspace — dozens of tasks and
// several projects that have nothing to do with this fixture. Passing
// `state.tasks` straight into the hook would let seed data leak into
// `byStatus["in-progress"]` alongside Alpha's and Beta's cards, exactly the
// interleaving this suite exists to pin down, so `mountDnd` (like
// `mountDnd` in drag-moves.test.ts) only hands the hook the tasks this test
// actually built.
async function mountDnd(
  state: AppState,
  tasks: Task[],
  backend: RecordingMoveBackend,
  opts?: { crossProject?: boolean; projectName?: (t: Task) => string }
) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(StoreProvider, { backend }, children);
  let handle!: ReturnType<typeof renderHook<ReturnType<typeof useTaskDnd>, unknown>>;
  await act(async () => {
    handle = renderHook(() => useTaskDnd(tasks, opts), { wrapper });
  });
  return handle;
}

const ourTasks = (state: AppState) =>
  state.tasks.filter((t) => t.projectId === "p_a" || t.projectId === "p_b");

describe("onDragOver on a cross-project board", () => {
  it("drops a card in front of its own project's slice, not at the merged position", async () => {
    // Alpha (p_a) has two in-progress cards, Beta (p_b) one, and — grouped
    // by project name the way `orderColumn` groups a cross-project column —
    // the merged display order is [a_ip1, a_ip2, b_ip1]. Hovering b_ip1
    // during a cross-column drag puts it at merged index 2, but Beta has NO
    // cards before it in Beta's own slice — the index `moveTask` should
    // receive is 0.
    let state = addProject(adminState(), { id: "p_a", name: "Alpha", createdBy: "u_vlad" });
    state = addProject(state, { id: "p_b", name: "Beta", createdBy: "u_vlad" });
    state = addTask(state, { id: "a_ip1", projectId: "p_a", title: "A1", createdBy: "u_vlad", status: "in-progress", order: 0 });
    state = addTask(state, { id: "a_ip2", projectId: "p_a", title: "A2", createdBy: "u_vlad", status: "in-progress", order: 1 });
    state = addTask(state, { id: "b_ip1", projectId: "p_b", title: "B1", createdBy: "u_vlad", status: "in-progress", order: 0 });
    state = addTask(state, { id: "b_todo1", projectId: "p_b", title: "B-todo", createdBy: "u_vlad", status: "todo", order: 0 });

    const backend = new RecordingMoveBackend();
    const { result } = await mountDnd(state, ourTasks(state), backend, { crossProject: true, projectName: name });

    await act(async () => {
      result.current.onDragStart({ active: { id: "b_todo1" } } as never);
      result.current.onDragOver({ active: { id: "b_todo1" }, over: { id: "b_ip1" } } as never);
    });

    // THE ASSERTION. This is 0 after the fix; observed as 2 beforehand,
    // because the un-converted call sent the position within the merged
    // [a_ip1, a_ip2, b_ip1] column rather than within Beta's own slice.
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]).toEqual({ status: "in-progress", index: 0 });
  });

  it("appends within the task's own project when hovering the column container itself", async () => {
    // Same board, but the drag hovers the `column:in-progress` container
    // rather than a specific card — the COLUMN_PREFIX branch. Converting
    // that branch's `overColumn.length` (3, the whole merged column) should
    // still land Beta's card at the end of Beta's own slice, i.e. index 1
    // (after Beta's single existing in-progress card), not 3.
    let state = addProject(adminState(), { id: "p_a", name: "Alpha", createdBy: "u_vlad" });
    state = addProject(state, { id: "p_b", name: "Beta", createdBy: "u_vlad" });
    state = addTask(state, { id: "a_ip1", projectId: "p_a", title: "A1", createdBy: "u_vlad", status: "in-progress", order: 0 });
    state = addTask(state, { id: "a_ip2", projectId: "p_a", title: "A2", createdBy: "u_vlad", status: "in-progress", order: 1 });
    state = addTask(state, { id: "b_ip1", projectId: "p_b", title: "B1", createdBy: "u_vlad", status: "in-progress", order: 0 });
    state = addTask(state, { id: "b_todo1", projectId: "p_b", title: "B-todo", createdBy: "u_vlad", status: "todo", order: 0 });

    const backend = new RecordingMoveBackend();
    const { result } = await mountDnd(state, ourTasks(state), backend, { crossProject: true, projectName: name });

    await act(async () => {
      result.current.onDragStart({ active: { id: "b_todo1" } } as never);
      result.current.onDragOver({
        active: { id: "b_todo1" },
        over: { id: `${COLUMN_PREFIX}in-progress` },
      } as never);
    });

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]).toEqual({ status: "in-progress", index: 1 });
  });

  // CONTROL: the coordinator's suggested single-project case (three same-
  // project cards, hover the third, expect the raw index unconverted)
  // cannot actually distinguish "sent raw" from "sent converted": during a
  // cross-status `onDragOver`, the active task is never already present in
  // the destination column (that only happens on `onDragEnd`'s same-status
  // path), so `indexWithinProject`'s only adjustment — excluding the
  // dragged task itself — never fires, and a single project's cards all
  // match `task.projectId` regardless. Raw and converted are the same
  // number for every single-project `onDragOver` case, by construction —
  // asserting one would be vacuous.
  //
  // This control instead proves the *guard*: with `crossProject` left
  // unset, a column whose merged (unconverted) order interleaves two
  // projects still gets its RAW merged index sent, not the per-project one,
  // even though the two demonstrably differ here. `byStatus` here is sorted
  // by `order` alone (no grouping, since `crossProject` is false), giving
  // merged order [a1, b1, a2]. Hovering a2 (merged index 2): the raw index
  // is 2; had the conversion run anyway it would have been 1 (only a1 is
  // Alpha's own card before that point). The call the backend receives is
  // the raw 2, showing the non-crossProject path is untouched by this fix.
  it("CONTROL: without crossProject, the raw merged index is sent even though it differs from what indexWithinProject would give", async () => {
    let state = addProject(adminState(), { id: "p_a", name: "Alpha", createdBy: "u_vlad" });
    state = addProject(state, { id: "p_b", name: "Beta", createdBy: "u_vlad" });
    state = addTask(state, { id: "a1", projectId: "p_a", title: "A1", createdBy: "u_vlad", status: "in-progress", order: 0 });
    state = addTask(state, { id: "b1", projectId: "p_b", title: "B1", createdBy: "u_vlad", status: "in-progress", order: 1 });
    state = addTask(state, { id: "a2", projectId: "p_a", title: "A2", createdBy: "u_vlad", status: "in-progress", order: 2 });
    state = addTask(state, { id: "a_todo1", projectId: "p_a", title: "A-todo", createdBy: "u_vlad", status: "todo", order: 0 });

    const tasks = ourTasks(state);
    const backend = new RecordingMoveBackend();
    // No opts at all: crossProject defaults to false, exactly as `Board`
    // leaves it for a single-project board.
    const { result } = await mountDnd(state, tasks, backend);

    // Sanity check on the fixture: prove the merged column really is
    // [a1, b1, a2] (order-only sort, not grouped by project) and that
    // indexWithinProject over it would give a different number (1) than
    // the raw position of a2 (2) — otherwise this control proves nothing.
    const destination = orderColumn(tasks.filter((x) => x.status === "in-progress"), false, name);
    expect(destination.map((x) => x.id)).toEqual(["a1", "b1", "a2"]);
    const draggedTask = tasks.find((x) => x.id === "a_todo1")!;
    expect(indexWithinProject(destination, draggedTask, 2)).toBe(1);

    await act(async () => {
      result.current.onDragStart({ active: { id: "a_todo1" } } as never);
      result.current.onDragOver({ active: { id: "a_todo1" }, over: { id: "a2" } } as never);
    });

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]).toEqual({ status: "in-progress", index: 2 });
  });
});
