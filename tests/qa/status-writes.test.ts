// @vitest-environment jsdom
//
// The store's rules for editing the board's columns, and who may.
//
// Every refusal here is ALSO enforced by the database — a foreign key with
// `on delete restrict` for "still holds work", a partial unique index for
// "exactly one finished column", and `statuses_write` gated on
// `workspace.statuses` for who. These tests are not the rule; they are the
// explanation. A person removing a column deserves "3 tasks are still in
// Backlog" rather than a Postgres constraint error, and that sentence is
// what this file pins.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { addProject, addTask, adminState, asUser, mount, run } from "./_support";
import type { AppState } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.error.mockClear();
});

/**
 * The seeded workspace with NO tasks, viewed by the Owner.
 *
 * Emptied deliberately: the seed puts work in Backlog, In Review and Done, so
 * a test asserting "1 task is still in In Review" against it would be reading
 * the fixture's contents rather than its own. Each test below adds exactly
 * the tasks it means to talk about.
 */
function asOwner(state: AppState = adminState()): AppState {
  return { ...asUser(state, "u_owner"), tasks: [] };
}

const lastError = () => toastMock.error.mock.calls.at(-1);

describe("who may edit the board's columns", () => {
  it("refuses an admin — this is the one power that separates Owner from Admin", async () => {
    // `adminState()` puts the seeded admin in the chair. If this ever passes,
    // the boundary the whole feature rests on has gone.
    const { result } = await mount(adminState());
    const before = result.current.state.statuses.length;

    const created = await run(() =>
      result.current.createStatus({ name: "Blocked", color: "#ef4444" })
    );

    expect(created).toBeNull();
    expect(result.current.state.statuses).toHaveLength(before);
    expect(lastError()?.[0]).toBe("Not allowed");
  });

  it("CONTROL: allows the owner", async () => {
    // Without this the rule could be refusing everybody and the test above
    // would still pass.
    const { result } = await mount(asOwner());
    const created = await run(() =>
      result.current.createStatus({ name: "Blocked", color: "#ef4444" })
    );

    expect(created).not.toBeNull();
    expect(result.current.state.statuses.map((s) => s.name)).toContain("Blocked");
  });
});

describe("removing a column", () => {
  it("refuses while tasks are still in it, and says how many", async () => {
    let state = addProject(asOwner(), {
      id: "p_cols",
      name: "Columns",
      createdBy: "u_owner",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_a",
      projectId: "p_cols",
      title: "Still here",
      status: "in-review",
      createdBy: "u_owner",
    });
    const { result } = await mount(state);

    const ok = await run(() => result.current.deleteStatus("in-review"));

    expect(ok).toBe(false);
    // The count is the point: "you can't do that" sends someone hunting.
    expect(lastError()?.[1]?.description ?? "").toMatch(/1 task is still in In Review/);
    expect(result.current.state.statuses.some((s) => s.id === "in-review")).toBe(true);
  });

  it("refuses to remove the finished column", async () => {
    const { result } = await mount(asOwner());
    const ok = await run(() => result.current.deleteStatus("done"));

    expect(ok).toBe(false);
    expect(lastError()?.[1]?.description ?? "").toMatch(/another column as done/i);
  });

  it("CONTROL: removes an empty, non-finished column", async () => {
    // Without this, a `deleteStatus` that refused everything would pass both
    // negatives above while making the feature useless.
    const { result } = await mount(asOwner());
    const ok = await run(() => result.current.deleteStatus("backlog"));

    expect(ok).toBe(true);
    expect(result.current.state.statuses.some((s) => s.id === "backlog")).toBe(false);
  });
});

describe("the finished column", () => {
  it("moves rather than multiplies — the old one gives it up", async () => {
    // A partial unique index permits exactly one. If this patch produced two,
    // the database would refuse the write and the user would see a constraint
    // error instead of a board.
    const { result } = await mount(asOwner());
    const ok = await run(() => result.current.updateStatus("in-review", { isDone: true }));

    expect(ok).toBe(true);
    const done = result.current.state.statuses.filter((s) => s.isDone);
    expect(done.map((s) => s.id)).toEqual(["in-review"]);
  });

  it("cannot simply be switched off, leaving a board with none", async () => {
    const { result } = await mount(asOwner());
    const ok = await run(() => result.current.updateStatus("done", { isDone: false }));

    expect(ok).toBe(false);
    expect(result.current.state.statuses.filter((s) => s.isDone)).toHaveLength(1);
  });
});

describe("renaming", () => {
  it("changes the name and never the id — which is what keeps tasks resolving", async () => {
    const { result } = await mount(asOwner());
    const ok = await run(() => result.current.updateStatus("done", { name: "Shipped" }));

    expect(ok).toBe(true);
    const renamed = result.current.state.statuses.find((s) => s.id === "done");
    expect(renamed?.name).toBe("Shipped");
    // The load-bearing half: every task still points at `done`.
    expect(renamed?.id).toBe("done");
  });

  it("refuses a name another column already has", async () => {
    const { result } = await mount(asOwner());
    const ok = await run(() => result.current.updateStatus("todo", { name: "Done" }));

    expect(ok).toBe(false);
    expect(lastError()?.[1]?.description ?? "").toMatch(/already exists/);
  });
});

describe("reordering", () => {
  it("renumbers positions to match the order given", async () => {
    const { result } = await mount(asOwner());
    const reversed = [...result.current.state.statuses]
      .sort((a, b) => b.position - a.position)
      .map((s) => s.id);

    const ok = await run(() => result.current.reorderStatuses(reversed));

    expect(ok).toBe(true);
    const after = [...result.current.state.statuses]
      .sort((a, b) => a.position - b.position)
      .map((s) => s.id);
    expect(after).toEqual(reversed);
  });
});
