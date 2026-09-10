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
import { act, cleanup, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  EventBackend,
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
import type { AppState, Message, Task } from "@/lib/types";

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

// ---------------------------------------------------------------------
// QA-102 — TWO WRITES IN FLIGHT AT ONCE.
//
// Everything above drives one write at a time (the `serverTruth` pair drives
// two, but only one of them fails), and one write can never show this: the
// rollback rule's failure mode needs a SECOND write that took its number
// after something landed and settles after the first one has already asked
// for a reload. `commit`'s re-hydrate obeyed neither rule the other three
// whole-state adopts obey — it did not bump `writeSeq` and it did not wait
// for the writes still in flight — so:
//
//  - the second failure saw its own number unchanged, concluded nothing had
//    landed, and restored a snapshot taken BEFORE the reload, silently
//    discarding everything the reload recovered;
//  - and while it was in flight, the un-gated reload landed on top of it, so
//    a second write that SUCCEEDED had its optimistic patch wiped with
//    nothing to put it back.
//
// One test for each half. Both need the writes held open by hand, which is
// what `TwoInFlightBackend` is for.
// ---------------------------------------------------------------------
describe("two writes in flight at once", () => {
  /** The project only a reload can produce — it is in no snapshot any write
   *  could have taken, so "re-hydrated" cannot be confused with "restored". */
  const SERVER_ONLY = "p_only_the_server_knows";

  /** A colleague's message, delivered while W1 is in flight. This is the
   *  bump: it lands between the two writes taking their numbers, which is the
   *  only ordering that makes the second one believe nothing has landed. */
  const LIVE: Message = {
    id: "m_from_a_colleague",
    channelId: CHANNEL,
    authorId: "u_maya",
    content: "landed between the two writes",
    createdAt: Date.now(),
    reactions: [],
    attachments: [],
  };

  /**
   * A backend that holds `sendMessage` and `createTask` open until the test
   * settles each by hand — the only way to have two writes genuinely in
   * flight at the same time — and whose `hydrate()` answers with what the
   * SERVER knows rather than what the screen shows:
   *
   *  - a marker project from the second call on, so a reload is visible;
   *  - plus every task it actually ACCEPTED. That last part is what makes the
   *    successful-neighbour test honest: a real reload returns the write that
   *    landed while it was waiting, and returns nothing for a write it
   *    refused, so the assertion is about the store's ordering rather than
   *    about a double that always answers the same thing.
   */
  class TwoInFlightBackend extends EventBackend {
    private readonly gates = new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void }
    >();
    private readonly accepted: Task[] = [];
    /** Reload answers this backend is sitting on — see `holdReloads`. */
    private readonly heldReloads: Array<(state: AppState) => void> = [];

    /** While true, every reload (`hydrate()` from the second call on) is held
     *  open until `releaseReload()`. That window — the reload issued, not yet
     *  landed — is the only place a write can take a `writeSeq` number that
     *  the reload will invalidate. */
    holdReloads = false;

    constructor(private readonly server: AppState) {
      super();
    }

    /** What the server would answer: the workspace, the marker project, and
     *  every task this backend actually accepted. */
    private truth(): AppState {
      const base = clone(this.server);
      return addProject({ ...base, tasks: [...base.tasks, ...clone(this.accepted)] }, {
        id: SERVER_ONLY,
        name: "From the server",
        createdBy: "u_vlad",
      });
    }

    releaseReload(): void {
      const waiting = this.heldReloads.shift();
      if (!waiting) throw new Error("no reload is in flight");
      waiting(this.truth());
    }

    private gate(name: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        this.gates.set(name, { resolve, reject });
      });
    }

    /** Lets one held write finish. Throws rather than no-opping if the write
     *  is not actually in flight — a test that settles nothing would
     *  otherwise assert against a store where nothing ever happened. */
    settle(name: "sendMessage" | "createTask", ok: boolean): void {
      const gate = this.gates.get(name);
      if (!gate) throw new Error(`${name} is not in flight`);
      this.gates.delete(name);
      if (ok) gate.resolve();
      else gate.reject(new Error(`${name} refused`));
    }

    override hydrate(): Promise<AppState> {
      this.hydrateCalls += 1;
      if (this.hydrateCalls === 1) return Promise.resolve(clone(this.server));
      if (!this.holdReloads) return Promise.resolve(this.truth());
      return new Promise<AppState>((resolve) => {
        this.heldReloads.push(resolve);
      });
    }

    override sendMessage(message: Message): Promise<Message> {
      return this.gate("sendMessage").then(() => message);
    }

    override createTask(task: Task): Promise<Task> {
      return this.gate("createTask").then(() => {
        this.accepted.push(task);
        return task;
      });
    }
  }

  /** Starts W1, lands a live event on top of it, then starts W2 — so W2's
   *  `writeSeq` number is taken AFTER the bump and W1's is from before it. */
  async function twoInFlight() {
    const backend = new TwoInFlightBackend(adminState());
    const { result } = await mount(adminState(), backend);
    expect(backend.hydrateCalls).toBe(1);

    let w1!: Promise<boolean>;
    act(() => {
      w1 = result.current.sendMessage(CHANNEL, "w1");
    });

    backend.emit({ kind: "message-insert", message: LIVE });
    await waitFor(() => {
      expect(result.current.state.messages.some((m) => m.id === LIVE.id)).toBe(true);
    });

    let w2!: Promise<Task | null>;
    act(() => {
      w2 = result.current.createTask(taskInput("w2"));
    });

    return { backend, result, w1, w2 };
  }

  it("the second failure does not discard what the first one's reload recovered", async () => {
    const { backend, result, w1, w2 } = await twoInFlight();

    // W1 fails first. Its snapshot predates the live message, so it must
    // re-hydrate rather than restore — and that reload has to wait, because
    // W2 is still in flight.
    await act(async () => {
      backend.settle("sendMessage", false);
    });

    // W2 fails second, reading a `writeSeq` its own write set and nothing has
    // touched since. Restoring here is the bug: its snapshot predates the
    // reload W1 has already committed to.
    await act(async () => {
      backend.settle("createTask", false);
      await Promise.all([w1, w2]);
    });

    expect(await w1).toBe(false);
    expect(await w2).toBeNull();
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
    // One reload answered both failures...
    expect(backend.hydrateCalls).toBe(2);
    // ...and the second rollback did not throw it away.
    expect(result.current.state.projects.some((p) => p.id === SERVER_ONLY)).toBe(true);
    // Neither failed write is still claiming to have been saved.
    expect(result.current.state.messages.some((m) => m.content === "w1")).toBe(false);
    expect(result.current.state.tasks.some((t) => t.title === "w2")).toBe(false);
  });

  it("the reload does not land on top of the write still in flight beside it", async () => {
    const { backend, result, w1, w2 } = await twoInFlight();

    await act(async () => {
      backend.settle("sendMessage", false);
    });

    // This one SUCCEEDS. A reload issued while it was in flight would have
    // replaced its optimistic card with a server state that did not have it
    // yet, and nothing would put it back — the card vanishes moments after
    // the user is told it was created.
    await act(async () => {
      backend.settle("createTask", true);
      await Promise.all([w1, w2]);
    });

    expect(await w2).not.toBeNull();
    expect(backend.hydrateCalls).toBe(2);
    expect(result.current.state.projects.some((p) => p.id === SERVER_ONLY)).toBe(true);
    expect(result.current.state.tasks.some((t) => t.title === "w2")).toBe(true);
  });

  it("a write that began while the reload was in flight cannot restore over it", async () => {
    // This is the half the `writeSeq` bump answers, and the only window in
    // which it can be seen: the reload has been ISSUED — so it is past the
    // wait for the writes in flight — but has not LANDED. A write that starts
    // here takes a number the reload is about to invalidate. If the reload
    // adopts without bumping, that write's failure sees its own number
    // unchanged, concludes nothing landed, and rewinds the whole workspace to
    // a snapshot from before the reload.
    const { backend, result, w1, w2 } = await twoInFlight();
    backend.holdReloads = true;

    await act(async () => {
      backend.settle("sendMessage", false);
    });
    await act(async () => {
      backend.settle("createTask", false);
    });
    // Issued, and sitting unanswered.
    expect(backend.hydrateCalls).toBe(2);
    expect(result.current.state.projects.some((p) => p.id === SERVER_ONLY)).toBe(false);

    let w3!: Promise<boolean>;
    act(() => {
      w3 = result.current.sendMessage(CHANNEL, "w3");
    });

    backend.holdReloads = false;
    await act(async () => {
      backend.releaseReload();
      await Promise.all([w1, w2]);
    });
    expect(result.current.state.projects.some((p) => p.id === SERVER_ONLY)).toBe(true);

    await act(async () => {
      backend.settle("sendMessage", false);
      await w3;
    });

    expect(await w3).toBe(false);
    // It asked the backend what is true rather than rewinding to its own
    // snapshot...
    expect(backend.hydrateCalls).toBe(3);
    // ...so what the reload recovered is still there.
    expect(result.current.state.projects.some((p) => p.id === SERVER_ONLY)).toBe(true);
    expect(result.current.state.messages.some((m) => m.content === "w3")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Deleting must not claim success for a write the backend refused.
// Both deletes returned Promise<void>, so all three call sites toasted
// "deleted" and two of them navigated away — a failed delete sent the user
// to the home page having told them it worked. The actions now report, and
// the callers honour it.
// ---------------------------------------------------------------------
describe("deleteChannel / deleteProject report a failed write", () => {
  it("deleteChannel resolves false and restores the channel when the backend rejects", async () => {
    const backend = new FailingBackend("deleteChannel");
    const { result } = await mount(adminState(), backend);
    const channel = result.current.state.channels.find((c) => !c.isTeam)!;
    const before = result.current.state.channels.length;

    const ok = await run(() => result.current.deleteChannel(channel.id));

    expect(ok).toBe(false);
    expect(result.current.state.channels).toHaveLength(before);
    expect(result.current.state.channels.some((c) => c.id === channel.id)).toBe(true);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  it("deleteProject resolves false and restores the project when the backend rejects", async () => {
    const backend = new FailingBackend("deleteProject");
    const { result } = await mount(adminState(), backend);
    const project = result.current.state.projects[0];
    const before = result.current.state.projects.length;

    const ok = await run(() => result.current.deleteProject(project.id));

    expect(ok).toBe(false);
    expect(result.current.state.projects).toHaveLength(before);
    expect(result.current.state.projects.some((p) => p.id === project.id)).toBe(true);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  // final-review.md finding 9: `switchUser` was the one write action with no
  // `FailingOp` entry and no override, so its rollback path could not be
  // driven from a test at all — a "failing" backend quietly succeeded. This
  // test exists to keep the union and the overrides in step; it fails
  // (currentUserId stays switched, no toast) the moment the override is
  // removed again.
  it("switchUser restores the previous user and toasts when the backend rejects", async () => {
    const backend = new FailingBackend("switchUser");
    const { result } = await mount(adminState(), backend);
    const before = result.current.state.currentUserId;
    const other = result.current.state.users.find((u) => u.id !== before)!;

    await run(() => result.current.switchUser(other.id));

    expect(result.current.state.currentUserId).toBe(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  it("POSITIVE CONTROL: switchUser sticks when the backend accepts it", async () => {
    const { result } = await mount(adminState());
    const before = result.current.state.currentUserId;
    const other = result.current.state.users.find((u) => u.id !== before)!;

    await run(() => result.current.switchUser(other.id));

    expect(result.current.state.currentUserId).toBe(other.id);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("both resolve true on the happy path, so the caller may report success", async () => {
    const { result } = await mount(adminState());
    const channel = result.current.state.channels.find((c) => !c.isTeam)!;
    const project = result.current.state.projects[0];

    expect(await run(() => result.current.deleteChannel(channel.id))).toBe(true);
    expect(await run(() => result.current.deleteProject(project.id))).toBe(true);
    expect(result.current.state.channels.some((c) => c.id === channel.id)).toBe(false);
    expect(result.current.state.projects.some((p) => p.id === project.id)).toBe(false);
  });
});
