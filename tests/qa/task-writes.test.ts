// @vitest-environment jsdom
//
// Suite — the four task writes against the backend seam (Plan "store-swap",
// Task 7: createTask, updateTask, moveTask, deleteTask).
//
// tests/qa/collaborators.test.ts already pins what the store REFUSES. This file
// is about what happens to a write the store allows: it is on screen before the
// backend answers, it is undone if the backend says no, and the caller can tell
// which of the two happened.
//
// `FailingBackend` gained a `deleteTask` override in this task — it had none,
// so naming it would have produced a "failing" backend that quietly succeeded
// and a rollback assertion that proved nothing. That is the third time this
// trap has been found in this plan; see the FailingOp union's comment.
//
// The other half of the file is the rule the review's F4 turns on: the store
// checks only the people a patch NEWLY assigns. A person already on the task
// who has since lost sight of the project must not block an unrelated edit —
// otherwise the task becomes uneditable by everybody, the home page's
// quick-complete included.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { LocalBackend } from "@/lib/backend/local";
import type { TaskPatch } from "@/lib/backend/types";
import type { AppState, Task, TaskStatus } from "@/lib/types";
import {
  FailingBackend,
  addProject,
  addTask,
  asUser,
  baseState,
  clone,
  mount,
  run,
} from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

const ME = "u_vlad"; // admin: holds every permission
const PROJECT = "p_website"; // unrestricted, created by ME, carries tasks

function adminState(): AppState {
  return asUser(baseState(), ME);
}

/** A restricted project whose task carries an owner and a collaborator who can
 *  BOTH no longer see it — the state F2/F3 leave behind, and the state the home
 *  page's quick-complete used to be refused over. */
function staleAssignmentState(): AppState {
  let state = addProject(adminState(), {
    id: "p_secret",
    name: "Payroll",
    createdBy: ME,
    restricted: true,
    members: [
      { userId: ME, level: "editor" },
      { userId: "u_maya", level: "editor" },
    ],
  });
  state = addTask(state, {
    id: "t_stale",
    projectId: "p_secret",
    title: "Salary bands",
    createdBy: ME,
    // Neither is a member, the creator, or an admin.
    assigneeId: "u_priya",
    collaboratorIds: ["u_jonas"],
  });
  return state;
}

/** Records the arguments each task write received, so a test can assert what
 *  the store RESOLVED a patch to rather than only what it left on screen. */
class RecordingBackend extends LocalBackend {
  created: Task[] = [];
  updated: Array<{ taskId: string; patch: TaskPatch }> = [];
  moved: Array<[string, TaskStatus, number]> = [];
  deleted: string[] = [];

  /** What the server decides the new card's position is. `-1` means "answer
   *  with whatever the store guessed", i.e. behave like `LocalBackend`. */
  constructor(private readonly serverOrder = -1) {
    super();
  }

  override createTask(task: Task): Promise<Task> {
    this.created.push(task);
    return Promise.resolve(
      this.serverOrder < 0 ? task : { ...task, order: this.serverOrder }
    );
  }
  // The parameters are optional only so these stay assignable to
  // `LocalBackend`'s, which declares none — the house style there is that a
  // method ignoring its arguments names none of them, and the contract's
  // parameters live in lib/backend/types.ts. Callers always pass them. Same
  // shape as `FailingBackend.putActivity` in ./_support.ts.
  override updateTask(taskId?: string, patch?: TaskPatch): Promise<void> {
    this.updated.push({ taskId: taskId!, patch: patch! });
    return Promise.resolve();
  }
  override moveTask(taskId?: string, toStatus?: TaskStatus, toIndex?: number): Promise<void> {
    this.moved.push([taskId!, toStatus!, toIndex!]);
    return Promise.resolve();
  }
  override deleteTask(taskId?: string): Promise<void> {
    this.deleted.push(taskId!);
    return Promise.resolve();
  }
}

function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    title: "Ship the thing",
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
    ...overrides,
  };
}

/** Starts a write inside a synchronous `act`, so React flushes the render the
 *  optimistic patch schedules but no microtask runs: whatever the store shows
 *  at that point, it showed before the promise settled. */
function startWrite<T>(fn: () => Promise<T>) {
  let promise!: Promise<T>;
  act(() => {
    promise = fn();
  });
  return promise;
}

async function finish<T>(promise: Promise<T>): Promise<T> {
  let out!: T;
  await act(async () => {
    out = await promise;
  });
  return out;
}

const lastErrorToast = () => toastMock.error.mock.calls.at(-1);

describe("createTask", () => {
  it("shows the card before the write settles", async () => {
    const { result } = await mount(adminState());
    const before = result.current.state.tasks.length;

    const promise = startWrite(() => result.current.createTask(taskInput()));
    expect(result.current.state.tasks).toHaveLength(before + 1);
    expect(result.current.state.tasks.at(-1)!.title).toBe("Ship the thing");

    await expect(finish(promise)).resolves.not.toBeNull();
  });

  it("adopts the position the SERVER chose, not the column length it guessed", async () => {
    // The store still guesses one so the card renders at the end of its column
    // immediately, but `tasks.position` is assigned by a before-insert trigger:
    // two people adding to the same column both counted the same length here.
    const backend = new RecordingBackend(41);
    const { result } = await mount(adminState(), backend);

    const created = await run(() => result.current.createTask(taskInput()));

    expect(created!.order).toBe(41);
    expect(result.current.state.tasks.find((t) => t.id === created!.id)!.order).toBe(41);
    // ...and the guess was never sent as an instruction — the backend is what
    // decides, so what it was handed does not matter, but what it returned does.
    expect(backend.created).toHaveLength(1);
  });

  it("keeps the store's own order when the backend hands one back unchanged", async () => {
    // Positive control for the adoption above: `LocalBackend` returns the task
    // as given, and the card must not jump.
    const { result } = await mount(adminState());
    const column = result.current.state.tasks.filter(
      (t) => t.projectId === PROJECT && t.status === "todo"
    ).length;

    const created = await run(() => result.current.createTask(taskInput()));

    expect(created!.order).toBe(column);
  });

  it("takes the card back off the board and resolves null when the write is refused", async () => {
    const { result } = await mount(adminState(), new FailingBackend("createTask"));
    const before = clone(result.current.state.tasks);

    const created = await run(() => result.current.createTask(taskInput()));

    expect(created).toBeNull();
    expect(result.current.state.tasks).toEqual(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  it("rolls the `created` feed line back with it", async () => {
    const { result } = await mount(adminState(), new FailingBackend("createTask"));
    const before = result.current.state.activities.length;

    await run(() => result.current.createTask(taskInput()));

    expect(result.current.state.activities).toHaveLength(before);
  });
});

describe("updateTask", () => {
  it("shows the edit before the write settles, and resolves true", async () => {
    const { result } = await mount(adminState());
    const task = result.current.state.tasks.find((t) => t.projectId === PROJECT)!;

    const promise = startWrite(() =>
      result.current.updateTask(task.id, { title: "Renamed" })
    );
    expect(result.current.state.tasks.find((t) => t.id === task.id)!.title).toBe("Renamed");

    await expect(finish(promise)).resolves.toBe(true);
  });

  it("restores the task and resolves FALSE when the write is refused", async () => {
    // The false is load-bearing: components/task-dialog.tsx only toasts "Task
    // updated" and closes — discarding what the user typed — on a truthy answer.
    const { result } = await mount(adminState(), new FailingBackend("updateTask"));
    const before = clone(result.current.state);
    const task = before.tasks.find((t) => t.projectId === PROJECT)!;

    const ok = await run(() => result.current.updateTask(task.id, { title: "Renamed" }));

    expect(ok).toBe(false);
    expect(result.current.state.tasks).toEqual(before.tasks);
    expect(result.current.state.activities).toEqual(before.activities);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  it("sends the RESOLVED collaborator list, not the raw patch", async () => {
    // The backend must write exactly what the guards approved — the owner is
    // dropped from the collaborator list before either side sees it.
    const backend = new RecordingBackend();
    const { result } = await mount(adminState(), backend);
    const task = result.current.state.tasks.find((t) => t.projectId === PROJECT)!;

    await run(() =>
      result.current.updateTask(task.id, {
        assigneeId: "u_maya",
        collaboratorIds: ["u_maya", "u_jonas", "u_jonas"],
      })
    );

    expect(backend.updated).toEqual([
      { taskId: task.id, patch: { assigneeId: "u_maya", collaboratorIds: ["u_jonas"] } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The distinction the review's F4 fix turns on, and the reason B-001 was a bug:
// only what a patch NEWLY assigns is checked. Somebody already on the task who
// has since lost sight of the project is not this caller's doing.
// ---------------------------------------------------------------------------
describe("updateTask — a stale assignment must not block an unrelated edit", () => {
  it("lets the home page's quick-complete finish a task whose owner AND collaborator lost access", async () => {
    // `{ status: "done" }` assigns nobody at all. Refusing it made the card
    // impossible to complete by clicking while dragging it still worked.
    const { result } = await mount(staleAssignmentState());

    const ok = await run(() => result.current.updateTask("t_stale", { status: "done" }));

    expect(ok).toBe(true);
    expect(result.current.state.tasks.find((t) => t.id === "t_stale")!.status).toBe("done");
  });

  it("lets the dialog re-send the SAME owner and collaborator with a new title", async () => {
    // components/task-dialog.tsx sends `assigneeId` and `collaboratorIds` on
    // every save, changed or not. Treating a re-sent assignment as a new one
    // would refuse every edit to this task.
    const backend = new RecordingBackend();
    const { result } = await mount(staleAssignmentState(), backend);

    const ok = await run(() =>
      result.current.updateTask("t_stale", {
        title: "Salary bands 2027",
        assigneeId: "u_priya",
        collaboratorIds: ["u_jonas"],
      })
    );

    expect(ok).toBe(true);
    // The stale pair travels to the backend untouched — it is not silently
    // dropped here, because the server is what decides whether the rows move.
    expect(backend.updated[0].patch).toMatchObject({
      assigneeId: "u_priya",
      collaboratorIds: ["u_jonas"],
    });
  });

  it("still REFUSES a person the patch newly assigns — the negative control", async () => {
    // Without this, an updateTask that had simply stopped checking anything
    // would pass both tests above.
    const backend = new RecordingBackend();
    const { result } = await mount(staleAssignmentState(), backend);

    const ok = await run(() =>
      result.current.updateTask("t_stale", { collaboratorIds: ["u_jonas", "u_sam"] })
    );

    expect(ok).toBe(false);
    // Refused before the backend was reached, so nothing was half-written.
    expect(backend.updated).toEqual([]);
    expect(result.current.state.tasks.find((t) => t.id === "t_stale")!.collaboratorIds).toEqual([
      "u_jonas",
    ]);
  });

  it("REFUSES newly assigning the owner slot to someone who cannot see the project", async () => {
    // F4: the owner is checked exactly like a collaborator.
    const backend = new RecordingBackend();
    const { result } = await mount(staleAssignmentState(), backend);

    const ok = await run(() =>
      result.current.updateTask("t_stale", { assigneeId: "u_sam" })
    );

    expect(ok).toBe(false);
    expect(backend.updated).toEqual([]);
  });
});

describe("moveTask", () => {
  it("moves the card before the write settles, and hands the backend the drop index", async () => {
    const backend = new RecordingBackend();
    const { result } = await mount(adminState(), backend);
    const task = result.current.state.tasks.find(
      (t) => t.projectId === PROJECT && t.status !== "done"
    )!;

    const promise = startWrite(() => result.current.moveTask(task.id, "done", 0));
    expect(result.current.state.tasks.find((t) => t.id === task.id)!.status).toBe("done");

    await finish(promise);
    // Renumbering is the RPC's job, not the store's — the index goes over
    // untouched rather than as a column of computed positions.
    expect(backend.moved).toEqual([[task.id, "done", 0]]);
  });

  it("snaps the card back when the move is refused", async () => {
    // No success toast on this path (it is drag-and-drop), so the rollback IS
    // the report: the card returns to where it was and `commit` explains why.
    const { result } = await mount(adminState(), new FailingBackend("moveTask"));
    const before = clone(result.current.state.tasks);
    const task = before.find((t) => t.projectId === PROJECT && t.status !== "done")!;

    await run(() => result.current.moveTask(task.id, "done", 0));

    expect(result.current.state.tasks).toEqual(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });
});

describe("deleteTask", () => {
  it("takes the card off the board before the write settles, and resolves true", async () => {
    const { result } = await mount(adminState());
    const task = result.current.state.tasks.find((t) => t.projectId === PROJECT)!;

    const promise = startWrite(() => result.current.deleteTask(task.id));
    expect(result.current.state.tasks.some((t) => t.id === task.id)).toBe(false);

    await expect(finish(promise)).resolves.toBe(true);
  });

  it("puts the card back and resolves FALSE when the delete is refused", async () => {
    // components/task-dialog.tsx toasts "Task deleted" and closes only on a
    // truthy answer. Until this task `FailingBackend` had no `deleteTask`
    // override, so a test like this one would have watched a delete succeed.
    const { result } = await mount(adminState(), new FailingBackend("deleteTask"));
    const before = clone(result.current.state);
    const task = before.tasks.find((t) => t.projectId === PROJECT)!;

    const ok = await run(() => result.current.deleteTask(task.id));

    expect(ok).toBe(false);
    expect(result.current.state.tasks).toEqual(before.tasks);
    expect(result.current.state.activities).toEqual(before.activities);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });
});

// ---------------------------------------------------------------------------
// Activity persistence needed no plumbing in this task, and this is the
// assertion of that: `commit` DIFFS the patch for newly appended feed ids, so
// the `activity(...)` calls inside these four actions reach `putActivity`
// without any of them naming it.
// ---------------------------------------------------------------------------
describe("the feed lines these writes produce reach the backend by themselves", () => {
  // No task action calls createRole, so nothing below fails; the op is only
  // named because `FailingBackend`'s constructor requires one, and it is the
  // class that carries the `activityWrites` recorder.
  const recorder = () => new FailingBackend("createRole");

  it("persists `created` for a new task", async () => {
    const backend = recorder();
    const { result } = await mount(adminState(), backend);

    await run(() => result.current.createTask(taskInput({ title: "Audit" })));

    expect(backend.activityWrites.map((a) => a.text)).toEqual(["created “Audit”"]);
    expect(backend.activityWrites[0].projectId).toBe(PROJECT);
  });

  it("persists `deleted` for a removed task — unlike a deleted project", async () => {
    // `activities.project_id` cascades from `projects`, not from `tasks`, and
    // the project outlives the task, so this feed line really is storable.
    const backend = recorder();
    const { result } = await mount(adminState(), backend);
    const task = result.current.state.tasks.find((t) => t.projectId === PROJECT)!;

    await run(() => result.current.deleteTask(task.id));

    expect(backend.activityWrites.map((a) => a.text)).toEqual([`deleted “${task.title}”`]);
  });

  it("persists both lines when one save completes a task AND reassigns it", async () => {
    const backend = recorder();
    const { result } = await mount(adminState(), backend);
    const task = result.current.state.tasks.find(
      (t) => t.projectId === PROJECT && t.status !== "done" && t.assigneeId !== "u_maya"
    )!;

    await run(() =>
      result.current.updateTask(task.id, { status: "done", assigneeId: "u_maya" })
    );

    expect(backend.activityWrites.length).toBeGreaterThan(1);
    expect(backend.activityWrites[0].text).toBe(`completed “${task.title}”`);
  });

  it("writes NO feed line for a move that changes nothing but the column", async () => {
    // The negative control: moving a card is not an event, so an implementation
    // that logged every write would fail here.
    const backend = recorder();
    const { result } = await mount(adminState(), backend);
    const task = result.current.state.tasks.find(
      (t) => t.projectId === PROJECT && t.status !== "done" && t.status !== "todo"
    )!;

    await run(() => result.current.moveTask(task.id, "todo", 0));

    expect(backend.activityWrites).toEqual([]);
  });
});
