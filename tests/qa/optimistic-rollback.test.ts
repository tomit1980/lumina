// @vitest-environment jsdom
//
// Suite — the store's optimistic write sequence and its rollback rule
// (Plan "store-swap", Task 1; lib/store.tsx `commit`).
//
// Three properties, for one action per family (message, task, project, role):
//
//  1. The optimistic patch is on screen *before* the promise resolves. This
//     is what makes a fire-and-forget call site (chat send, reactions, drag &
//     drop) feel instant, and it is the half of the design that a naive
//     "await the backend, then patch" implementation would quietly drop.
//  2. A rejected write restores the pre-patch snapshot and toasts. Nothing is
//     left claiming to have been saved.
//  3. A write that fails *after a later optimistic write has already landed*
//     re-hydrates the whole AppState from the backend instead of restoring
//     its snapshot — restoring would silently discard the neighbour.
//
// The doubles live in ./_support: `FailingBackend` rejects one named
// operation and behaves like `LocalBackend` for the rest.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  FailingBackend,
  addProject,
  asUser,
  baseState,
  clone,
  mount,
  run,
  type FailingOp,
  type Store,
} from "./_support";
import type { AppState } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

const CHANNEL = "c_general";
const PROJECT = "p_rollback";

/** Admin (u_vlad) with a project of their own — enough permission to reach
 *  every action under test, so a refusal can only come from the backend. */
function adminState(): AppState {
  return asUser(
    addProject(baseState(), {
      id: PROJECT,
      name: "Rollback",
      createdBy: "u_vlad",
    }),
    "u_vlad"
  );
}

function taskInput(title: string) {
  return {
    projectId: PROJECT,
    title,
    description: "",
    status: "todo" as const,
    priority: "medium" as const,
    assigneeId: null,
    dueDate: null,
    startTime: null,
    durationMinutes: null,
    reminderMinutes: null,
    labels: [],
    attachments: [],
  };
}

/**
 * Starts a write inside a *synchronous* `act`, so React flushes the render
 * the optimistic patch schedules but no microtask gets to run: whatever the
 * store shows at that point, it showed before the promise settled.
 *
 * Returns the still-unsettled promise plus a `settled` probe that is read
 * synchronously — `await`ing anything here would defeat the point.
 */
function startWrite<T>(fn: () => Promise<T>) {
  let promise!: Promise<T>;
  act(() => {
    promise = fn();
  });
  const state = { settled: false, value: undefined as T | undefined };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return { promise, state };
}

/** Drains a started write (and the re-render its resolution schedules). */
async function finish<T>(promise: Promise<T>): Promise<T> {
  let out!: T;
  await act(async () => {
    out = await promise;
  });
  return out;
}

function lastErrorToast() {
  return toastMock.error.mock.calls.at(-1);
}

describe("the optimistic patch is visible before the promise resolves", () => {
  it("sendMessage — the message is on screen while the write is still in flight", async () => {
    const { result } = await mount(adminState());
    const before = result.current.state.messages.length;

    const { promise, state } = startWrite(() =>
      result.current.sendMessage(CHANNEL, "instant")
    );

    expect(state.settled).toBe(false);
    expect(result.current.state.messages.length).toBe(before + 1);
    expect(result.current.state.messages.at(-1)?.content).toBe("instant");

    expect(await finish(promise)).toBe(true);
  });

  it("createTask — the card exists while the write is still in flight", async () => {
    const { result } = await mount(adminState());

    const { promise, state } = startWrite(() =>
      result.current.createTask(taskInput("Optimistic task"))
    );

    expect(state.settled).toBe(false);
    expect(result.current.state.tasks.some((t) => t.title === "Optimistic task")).toBe(
      true
    );

    expect(await finish(promise)).not.toBeNull();
  });

  it("createProject — the project exists while the write is still in flight", async () => {
    const { result } = await mount(adminState());

    const { promise, state } = startWrite(() =>
      result.current.createProject({
        name: "Optimistic project",
        description: "",
        emoji: "🧪",
        color: "#000000",
        priority: "medium",
      })
    );

    expect(state.settled).toBe(false);
    expect(
      result.current.state.projects.some((p) => p.name === "Optimistic project")
    ).toBe(true);

    expect(await finish(promise)).not.toBeNull();
  });

  it("createRole — the role exists while the write is still in flight", async () => {
    const { result } = await mount(adminState());

    const { promise, state } = startWrite(() =>
      result.current.createRole({
        name: "Optimistic role",
        description: "",
        color: "#000000",
        permissions: [],
      })
    );

    expect(state.settled).toBe(false);
    expect(result.current.state.roles.some((r) => r.name === "Optimistic role")).toBe(
      true
    );

    expect(await finish(promise)).not.toBeNull();
  });
});

describe("a rejected write restores the snapshot and toasts", () => {
  async function expectRestored(
    failing: FailingOp,
    write: (store: Store) => Promise<unknown>,
    read: (s: AppState) => unknown
  ) {
    const backend = new FailingBackend(failing);
    const { result } = await mount(adminState(), backend);
    const before = clone(read(result.current.state));

    const outcome = await run(() => write(result.current));

    expect(outcome).toBeFalsy();
    expect(read(result.current.state)).toEqual(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
    // The snapshot was restored in place — no re-hydrate was needed.
    expect(backend.hydrateCalls).toBe(1);
  }

  it("sendMessage — the message is taken back off screen", async () => {
    await expectRestored(
      "sendMessage",
      (store) => store.sendMessage(CHANNEL, "doomed"),
      (s) => s.messages
    );
  });

  it("createTask — the card is taken back off the board", async () => {
    await expectRestored(
      "createTask",
      (store) => store.createTask(taskInput("Doomed task")),
      (s) => s.tasks
    );
  });

  it("updateTask — the edit is undone, activities included", async () => {
    const backend = new FailingBackend("updateTask");
    const state = adminState();
    const { result } = await mount(state, backend);
    const created = await run(() =>
      result.current.createTask(taskInput("Keeps its title"))
    );
    const before = clone(result.current.state);

    const ok = await run(() => result.current.updateTask(created!.id, { title: "Nope" }));

    expect(ok).toBe(false);
    expect(result.current.state.tasks).toEqual(before.tasks);
    expect(result.current.state.activities).toEqual(before.activities);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
    expect(backend.hydrateCalls).toBe(1);
  });

  it("createProject — the project is taken back off the sidebar", async () => {
    await expectRestored(
      "createProject",
      (store) =>
        store.createProject({
          name: "Doomed project",
          description: "",
          emoji: "🧪",
          color: "#000000",
          priority: "medium",
        }),
      (s) => s.projects
    );
  });

  it("createRole — the role is taken back off the roles list", async () => {
    await expectRestored(
      "createRole",
      (store) =>
        store.createRole({
          name: "Doomed role",
          description: "",
          color: "#000000",
          permissions: [],
        }),
      (s) => s.roles
    );
  });

  it("setUserRole — the member keeps the role they had", async () => {
    await expectRestored(
      "setUserRole",
      (store) => store.setUserRole("u_maya", "guest"),
      (s) => s.users
    );
  });
});

describe("a rejection with a later write already landed re-hydrates instead of restoring", () => {
  /** What the backend answers on the *re-hydrate*: recognisable, and not
   *  equal to any snapshot the failing write could have taken. */
  function serverTruth(): AppState {
    return addProject(adminState(), {
      id: "p_only_the_server_knows",
      name: "From the server",
      createdBy: "u_vlad",
    });
  }

  it("a failed message with a task created behind it re-hydrates the whole state", async () => {
    const backend = new FailingBackend("sendMessage", serverTruth);
    const { result } = await mount(adminState(), backend);
    expect(backend.hydrateCalls).toBe(1);

    // Both writes are dispatched in the same tick, so the second optimistic
    // patch lands before the first one's rejection is handled. Restoring the
    // first write's snapshot here would throw the task away.
    let doomed!: Promise<boolean>;
    let survivor!: Promise<unknown>;
    act(() => {
      doomed = result.current.sendMessage(CHANNEL, "doomed");
      survivor = result.current.createTask(taskInput("Landed second"));
    });

    await act(async () => {
      await Promise.all([doomed, survivor]);
    });

    expect(await doomed).toBe(false);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
    // The rollback asked the backend what is true rather than guessing.
    expect(backend.hydrateCalls).toBe(2);
    expect(
      result.current.state.projects.some((p) => p.id === "p_only_the_server_knows")
    ).toBe(true);
    // And it did not silently reinstate the failed write.
    expect(result.current.state.messages.some((m) => m.content === "doomed")).toBe(false);
  });

  it("the same failure on its own restores the snapshot and never re-hydrates", async () => {
    const backend = new FailingBackend("sendMessage", serverTruth);
    const { result } = await mount(adminState(), backend);
    const before = clone(result.current.state);

    expect(await run(() => result.current.sendMessage(CHANNEL, "doomed"))).toBe(false);

    expect(backend.hydrateCalls).toBe(1);
    expect(result.current.state.messages).toEqual(before.messages);
    expect(
      result.current.state.projects.some((p) => p.id === "p_only_the_server_knows")
    ).toBe(false);
  });
});
