// @vitest-environment jsdom
//
// Creating a project from a task set, at the store.
//
// The transaction is the database's and tests/rls/project-instantiation.test.ts
// drives it directly. What this file pins is the part that only exists here:
// what the optimistic patch contains, and — the reason the feature was asked
// for in this shape — that a set and the projects made from it never touch
// each other again.
//
// "A task set is NOT a project" is a claim about three separate directions,
// and each one gets its own test:
//
//   * editing a generated task changes no definition;
//   * editing a definition changes no project already created;
//   * a project created afterwards gets the edited definition.
//
// The third is what makes the first two meaningful. Without it, a store that
// had quietly stopped reading task sets at all would pass both.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { FailingBackend, asUser, baseState, mount, run } from "./_support";
import { firstOpenStatus } from "@/lib/statuses";
import type { AppState, TaskSet } from "@/lib/types";

const TITLES = ["Collect client ID", "Verify eligibility", "Submit application", "Close case"];
const ITEMS = TITLES.map((title) => ({
  title,
  description: "",
  priority: "medium" as const,
  labels: [],
}));

/** The Owner both curates sets and creates projects. */
function asOwner(): AppState {
  return asUser(baseState(), "u_owner");
}

const PROJECT = {
  name: "Pension Release — John Smith",
  description: "",
  emoji: "📁",
  color: "#7c3aed",
  priority: "medium" as const,
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.error.mockClear();
});

describe("what instantiation creates", () => {
  it("creates one task per line, in the definition's order", async () => {
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "Standard", items: ITEMS }));

    const project = await run(() =>
      result.current.createProject({ ...PROJECT, taskSetId: set!.id })
    );

    const tasks = tasksOf(result, project!.id);
    expect(tasks.map((t) => t.title)).toEqual(TITLES);
    expect(tasks.map((t) => t.order)).toEqual([0, 1, 2, 3]);
    expect(project!.createdFromTaskSetId).toBe(set!.id);
  });

  it("CONTROL: with no task set it creates none", async () => {
    // Without this, a build that always instantiated something — or never did
    // — would be indistinguishable from a working picker.
    const { result } = await mount(asOwner());
    await run(() => result.current.createTaskSet({ name: "Standard", items: ITEMS }));

    const project = await run(() => result.current.createProject(PROJECT));

    expect(tasksOf(result, project!.id)).toHaveLength(0);
    expect(project!.createdFromTaskSetId).toBeNull();
  });

  it("puts them in the first open column, with fresh ids and no due dates", async () => {
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "Standard", items: ITEMS }));

    const project = await run(() =>
      result.current.createProject({ ...PROJECT, taskSetId: set!.id })
    );

    const tasks = tasksOf(result, project!.id);
    const column = firstOpenStatus(result.current.state.statuses);
    expect(tasks.every((t) => t.status === column)).toBe(true);
    expect(tasks.every((t) => t.dueDate === null)).toBe(true);
    // Ids are the task's own. Sharing them with the lines would make the two
    // editable through each other, which is the whole thing this avoids.
    const itemIds = new Set(set!.items.map((i) => i.id));
    expect(tasks.some((t) => itemIds.has(t.id))).toBe(false);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(TITLES.length);
  });

  it("writes exactly one activity line, not one per task", async () => {
    // Four tasks here, twelve in real use. Routing instantiation through
    // `createTask` would bury the feed on the day a new client arrives.
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "Standard", items: ITEMS }));
    const before = result.current.state.activities.length;

    await run(() => result.current.createProject({ ...PROJECT, taskSetId: set!.id }));

    expect(result.current.state.activities.length - before).toBe(1);
    // Found by content rather than by position: the feed's order is its own
    // business, and asserting an index would make this test about that.
    expect(
      result.current.state.activities.filter((a) => /from Standard \(4 tasks\)/.test(a.text))
    ).toHaveLength(1);
  });

  it("ignores an archived set rather than instantiating it", async () => {
    // The picker does not offer archived sets. This is the other half: passing
    // one anyway does nothing, so the list somebody chose from is the list
    // that applies.
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "Old", items: ITEMS }));
    await run(() => result.current.archiveTaskSet(set!.id, true));

    const project = await run(() =>
      result.current.createProject({ ...PROJECT, taskSetId: set!.id })
    );

    expect(tasksOf(result, project!.id)).toHaveLength(0);
    expect(project!.createdFromTaskSetId).toBeNull();
  });
});

describe("a set and its projects never touch again", () => {
  it("editing a generated task leaves the definition alone", async () => {
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "Standard", items: ITEMS }));
    const project = await run(() =>
      result.current.createProject({ ...PROJECT, taskSetId: set!.id })
    );

    const first = tasksOf(result, project!.id)[0];
    await run(() => result.current.updateTask(first.id, { title: "Collect ID — chased twice" }));

    expect(setOf(result, set!.id).items.map((i) => i.title)).toEqual(TITLES);
  });

  it("editing the definition leaves an existing project alone", async () => {
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "Standard", items: ITEMS }));
    const project = await run(() =>
      result.current.createProject({ ...PROJECT, taskSetId: set!.id })
    );

    await run(() => result.current.createTaskSetItem(set!.id, { title: "Chase the fund" }));
    await run(() =>
      result.current.updateTaskSetItem(setOf(result, set!.id).items[0].id, { title: "Renamed" })
    );

    const tasks = tasksOf(result, project!.id);
    expect(tasks.map((t) => t.title)).toEqual(TITLES);
    expect(tasks).toHaveLength(4);
  });

  it("CONTROL: a project created AFTERWARDS gets the edited definition", async () => {
    // The test that makes the two above mean something. If the store had
    // stopped reading task sets entirely, both would still pass and this
    // would not.
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "Standard", items: ITEMS }));
    await run(() => result.current.createProject({ ...PROJECT, taskSetId: set!.id }));

    await run(() => result.current.createTaskSetItem(set!.id, { title: "Chase the fund" }));
    const second = await run(() =>
      result.current.createProject({ ...PROJECT, name: "Second client", taskSetId: set!.id })
    );

    expect(tasksOf(result, second!.id).map((t) => t.title)).toEqual([
      ...TITLES,
      "Chase the fund",
    ]);
  });
});

describe("when the write is refused", () => {
  it("takes the project AND every task back", async () => {
    // The optimistic half of atomicity. `commit` rewinds to the pre-patch
    // snapshot, so both halves of one patch go together — asserted as counts
    // rather than a spot check, because "the project is gone" would pass with
    // four orphaned cards still on the board.
    const { result } = await mount(asOwner(), new FailingBackend("createProject"));
    const set = await run(() => result.current.createTaskSet({ name: "Standard", items: ITEMS }));
    const projectsBefore = result.current.state.projects.length;
    const tasksBefore = result.current.state.tasks.length;

    const project = await run(() =>
      result.current.createProject({ ...PROJECT, taskSetId: set!.id })
    );

    expect(project).toBeNull();
    expect(result.current.state.projects).toHaveLength(projectsBefore);
    expect(result.current.state.tasks).toHaveLength(tasksBefore);
    // And the definition is untouched: a refused project must not consume it.
    expect(setOf(result, set!.id).items).toHaveLength(4);
  });
});

function tasksOf(result: { current: { state: AppState } }, projectId: string) {
  return result.current.state.tasks
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => a.order - b.order);
}

function setOf(result: { current: { state: AppState } }, id: string): TaskSet {
  return result.current.state.taskSets.find((t) => t.id === id)!;
}
