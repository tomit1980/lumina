// @vitest-environment jsdom
//
// The store's half of task sets.
//
// The rules are the database's — `task_sets_write` and `task_set_items_write`
// gate every write on `workspace.taskSets`, and tests/rls/task-sets.test.ts
// asserts that from real sessions. This file covers what the store owes the
// person at the keyboard: refusing early with a sentence, keeping the
// optimistic list honest, and putting everything back when a write is refused.
//
// One design point pinned here deliberately: `duplicateTaskSet` is not a
// backend method. It is `createTaskSet` with fresh ids, so there is no second
// path that could drift from the first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { FailingBackend, asUser, baseState, mount, run } from "./_support";
import type { AppState } from "@/lib/types";

/** The Owner holds `workspace.taskSets`; so does Admin. */
function asOwner(): AppState {
  return asUser(baseState(), "u_owner");
}

const ITEMS = [
  { title: "Collect client identification", description: "", priority: "high" as const, labels: [] },
  { title: "Verify eligibility", description: "", priority: "medium" as const, labels: [] },
  { title: "Close case", description: "", priority: "low" as const, labels: [] },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.error.mockClear();
});

describe("who may curate a set", () => {
  it("refuses a member before any network call", async () => {
    const { result } = await mount(asUser(baseState(), "u_maya"));
    const created = await run(() => result.current.createTaskSet({ name: "Pension Release" }));

    expect(created).toBeNull();
    expect(result.current.state.taskSets).toHaveLength(0);
  });

  it("CONTROL: an owner gets through and the set lands", async () => {
    const { result } = await mount(asOwner());
    const created = await run(() => result.current.createTaskSet({ name: "Pension Release" }));

    expect(created).not.toBeNull();
    expect(result.current.state.taskSets.map((t) => t.name)).toEqual(["Pension Release"]);
  });
});

describe("creating", () => {
  it("creates an empty set", async () => {
    const { result } = await mount(asOwner());

    await run(() => result.current.createTaskSet({ name: "Onboarding" }));

    expect(result.current.state.taskSets[0].items).toEqual([]);
  });

  it("creates a set with its lines, numbered in the order given", async () => {
    const { result } = await mount(asOwner());

    await run(() => result.current.createTaskSet({ name: "Pension Release", items: ITEMS }));

    const set = result.current.state.taskSets[0];
    expect(set.items.map((i) => i.title)).toEqual(ITEMS.map((i) => i.title));
    expect(set.items.map((i) => i.position)).toEqual([0, 1, 2]);
    // Ids are assigned by the store, not carried in from the caller.
    expect(new Set(set.items.map((i) => i.id)).size).toBe(3);
  });

  it("refuses a blank name, and a duplicate one", async () => {
    const { result } = await mount(asOwner());
    await run(() => result.current.createTaskSet({ name: "Onboarding" }));

    const blank = await run(() => result.current.createTaskSet({ name: "   " }));
    const dupe = await run(() => result.current.createTaskSet({ name: "onboarding" }));

    expect(blank).toBeNull();
    expect(dupe).toBeNull();
    expect(result.current.state.taskSets).toHaveLength(1);
  });
});

describe("editing the lines", () => {
  it("adds, edits, reorders and removes", async () => {
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "P", items: ITEMS }));
    const id = set!.id;

    await run(() => result.current.createTaskSetItem(id, { title: "Follow up" }));
    expect(current(result).items.map((i) => i.title)).toEqual([
      ...ITEMS.map((i) => i.title),
      "Follow up",
    ]);

    const second = current(result).items[1];
    await run(() => result.current.updateTaskSetItem(second.id, { title: "Check eligibility" }));
    expect(current(result).items[1].title).toBe("Check eligibility");

    const reversed = current(result).items.map((i) => i.id).reverse();
    await run(() => result.current.reorderTaskSetItems(id, reversed));
    expect(current(result).items.map((i) => i.position)).toEqual([3, 2, 1, 0]);

    await run(() => result.current.deleteTaskSetItem(second.id));
    expect(current(result).items.map((i) => i.title)).not.toContain("Check eligibility");
  });

  it("refuses a blank title rather than storing one", async () => {
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "P", items: ITEMS }));

    const added = await run(() => result.current.createTaskSetItem(set!.id, { title: "  " }));

    expect(added).toBeNull();
    expect(current(result).items).toHaveLength(3);
  });
});

describe("duplicating", () => {
  it("copies the content and gives everything new ids", async () => {
    const { result } = await mount(asOwner());
    const source = await run(() =>
      result.current.createTaskSet({ name: "Pension Release", items: ITEMS })
    );

    const copy = await run(() => result.current.duplicateTaskSet(source!.id));

    expect(copy!.name).toBe("Pension Release (copy)");
    expect(copy!.items.map((i) => i.title)).toEqual(ITEMS.map((i) => i.title));
    expect(copy!.id).not.toBe(source!.id);
    // The point of duplicating in the store: fresh ids everywhere, so editing
    // the copy can never reach the original.
    const sourceIds = new Set(source!.items.map((i) => i.id));
    expect(copy!.items.some((i) => sourceIds.has(i.id))).toBe(false);
  });

  it("keeps going past a name that is already taken", async () => {
    const { result } = await mount(asOwner());
    const source = await run(() => result.current.createTaskSet({ name: "Audit" }));

    await run(() => result.current.duplicateTaskSet(source!.id));
    await run(() => result.current.duplicateTaskSet(source!.id));

    // Compared as a set: lexicographic order puts "(copy 2)" before "(copy)"
    // because a space sorts below ")", which says nothing about the feature.
    expect(new Set(result.current.state.taskSets.map((t) => t.name))).toEqual(
      new Set(["Audit", "Audit (copy)", "Audit (copy 2)"])
    );
  });

  it("CONTROL: editing the copy leaves the original alone", async () => {
    const { result } = await mount(asOwner());
    const source = await run(() =>
      result.current.createTaskSet({ name: "Pension Release", items: ITEMS })
    );
    const copy = await run(() => result.current.duplicateTaskSet(source!.id));

    await run(() => result.current.updateTaskSetItem(copy!.items[0].id, { title: "Changed" }));

    const original = result.current.state.taskSets.find((t) => t.id === source!.id)!;
    expect(original.items[0].title).toBe(ITEMS[0].title);
  });
});

describe("archiving", () => {
  it("sets and clears the flag without losing the lines", async () => {
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "P", items: ITEMS }));

    await run(() => result.current.archiveTaskSet(set!.id, true));
    expect(current(result).archivedAt).not.toBeNull();
    expect(current(result).items).toHaveLength(3);

    await run(() => result.current.archiveTaskSet(set!.id, false));
    expect(current(result).archivedAt).toBeNull();
  });
});

describe("when the backend refuses", () => {
  it("puts the set back", async () => {
    const { result } = await mount(asOwner(), new FailingBackend("createTaskSet"));

    const created = await run(() => result.current.createTaskSet({ name: "Pension Release" }));

    expect(created).toBeNull();
    expect(result.current.state.taskSets).toHaveLength(0);
  });

  it("puts a removed line back", async () => {
    // The rollback that is easiest to get wrong: the optimistic patch removed
    // a row, so putting it back means restoring rather than deleting.
    const backend = new FailingBackend("deleteTaskSetItem");
    const { result } = await mount(asOwner(), backend);
    const set = await run(() => result.current.createTaskSet({ name: "P", items: ITEMS }));
    const doomed = current(result).items[1];

    await run(() => result.current.deleteTaskSetItem(doomed.id));

    expect(current(result).items.map((i) => i.title)).toEqual(ITEMS.map((i) => i.title));
  });

  it("CONTROL: the same removal sticks when the backend accepts it", async () => {
    // Without this, the rollback test above would pass against a delete that
    // never did anything in the first place.
    const { result } = await mount(asOwner());
    const set = await run(() => result.current.createTaskSet({ name: "P", items: ITEMS }));
    const doomed = current(result).items[1];

    await run(() => result.current.deleteTaskSetItem(doomed.id));

    expect(current(result).items).toHaveLength(2);
    expect(set).not.toBeNull();
  });
});

/** The first (and in these tests only) set in state. */
function current(result: { current: { state: AppState } }) {
  return result.current.state.taskSets[0];
}
