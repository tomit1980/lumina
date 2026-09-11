// Shared harness for the QA suites in tests/qa/. Not a test file itself
// (doesn't match tests/**/*.test.ts), just imported by the ones that are.
import * as React from "react";
import { act, render, renderHook } from "@testing-library/react";

import { LocalBackend } from "@/lib/backend/local";
import type {
  AttachmentOwner,
  Backend,
  RealtimeEvent,
  Unsubscribe,
} from "@/lib/backend/types";
import { StoreProvider, useStore } from "@/lib/store";
import { createSeed } from "@/lib/seed";
import type {
  Activity,
  AppState,
  Attachment,
  Channel,
  DM,
  Message,
  Permission,
  Project,
  RoleDef,
  StatusDef,
  TaskSet,
  Task,
  TaskStatus,
  Priority,
  User,
} from "@/lib/types";

export const STORAGE_KEY = "lumina:v1";

export type Store = ReturnType<typeof useStore>;

/** Deep clone via JSON — safe since AppState is exactly what's persisted. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A fresh copy of the seeded demo workspace (u_vlad/admin, u_maya|u_jonas|
 *  u_priya|u_sam/member, u_elena/guest). Mutate the copy, don't share it. */
export function baseState(): AppState {
  return createSeed();
}

export function asUser(state: AppState, userId: string): AppState {
  return { ...state, currentUserId: userId };
}

/** The seeded workspace as u_vlad, the admin — enough permission to reach any
 *  action, so a refusal in a test can only have come from the backend. */
export function adminState(): AppState {
  return asUser(baseState(), "u_vlad");
}

export function addUser(
  state: AppState,
  user: { id: string; roleId: string } & Partial<Omit<User, "id" | "roleId">>
): AppState {
  const withDefaults: User = {
    name: user.id,
    handle: user.id,
    title: "",
    color: "#000000",
    presence: "online",
    ...user,
  };
  return { ...state, users: [...state.users, withDefaults] };
}

export function addRole(
  state: AppState,
  role: { id: string; name: string; permissions: Permission[] } & Partial<
    Omit<RoleDef, "id" | "name" | "permissions">
  >
): AppState {
  const withDefaults: RoleDef = {
    description: "",
    color: "#000000",
    ...role,
  };
  return { ...state, roles: [...state.roles, withDefaults] };
}

export function addChannel(
  state: AppState,
  channel: { id: string; name: string; createdBy: string } & Partial<
    Omit<Channel, "id" | "name" | "createdBy">
  >
): AppState {
  const withDefaults: Channel = {
    description: "",
    isPrivate: false,
    members: [],
    createdAt: Date.now(),
    ...channel,
  };
  return { ...state, channels: [...state.channels, withDefaults] };
}

export function addProject(
  state: AppState,
  project: { id: string; name: string; createdBy: string } & Partial<
    Omit<Project, "id" | "name" | "createdBy">
  >
): AppState {
  const withDefaults: Project = {
    description: "",
    emoji: "🧪",
    color: "#000000",
    priority: "medium",
    restricted: false,
    members: [],
    attachments: [],
    createdFromTaskSetId: null,
    createdAt: Date.now(),
    ...project,
  };
  return { ...state, projects: [...state.projects, withDefaults] };
}

export function addTask(
  state: AppState,
  task: { id: string; projectId: string; title: string; createdBy: string } & Partial<
    Omit<Task, "id" | "projectId" | "title" | "createdBy">
  >
): AppState {
  const withDefaults: Task = {
    description: "",
    status: "todo" as TaskStatus,
    priority: "medium" as Priority,
    assigneeId: null,
    dueDate: null,
    startTime: null,
    durationMinutes: null,
    reminderMinutes: null,
    labels: [],
    attachments: [],
    order: 0,
    createdAt: Date.now(),
    collaboratorIds: [],
    ...task,
  };
  return { ...state, tasks: [...state.tasks, withDefaults] };
}

/** Teaches jsdom the three browser APIs Radix's popper-backed menus need
 *  before they will open. Opt-in — call it at the top of a suite that opens a
 *  dropdown; suites that don't are left alone.
 *
 *  Two things to know when driving one of those menus from a test:
 *  - open it with a plain `fireEvent.keyDown(trigger, { key: "Enter" })`.
 *    Wrapping that in an async `act()` hangs: floating-ui keeps repositioning
 *    the open menu, `act` keeps draining the work it schedules, and the test
 *    times out ~30s later having done everything correctly.
 *  - unmount before the test ends, so that loop stops. */
export function installMenuShims() {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  // Deliberately NOT shimming requestAnimationFrame. Replacing jsdom's 16ms
  // repaint clock with a setTimeout(0) turns the popper's frame loop into a
  // busy loop that starves the whole worker — every later render times out.
}

/** `render()` plus the microtask that resolves `backend.hydrate()`, for the
 *  suites that render real components under a `StoreProvider` rather than
 *  taking the hook handle. Without this the store is still showing its
 *  loading screen — and rendering none of its children — when the first
 *  synchronous query runs. */
export async function renderHydrated(ui: React.ReactElement) {
  let out!: ReturnType<typeof render>;
  await act(async () => {
    out = render(ui);
  });
  return out;
}

/** Mounts StoreProvider and waits for `backend.hydrate()` to resolve.
 *
 *  Awaiting is required, not cosmetic: `StoreProvider` renders its loading
 *  screen — and no context, so `useStore()` never runs — until hydration
 *  resolves, and that is a promise now that the store reads through the
 *  `Backend` seam. `act` flushes both the microtask and the render it
 *  schedules, so `result.current` is a live store by the time this returns. */
async function mountWith(backend?: Backend) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(StoreProvider, { backend }, children);
  }
  let handle!: ReturnType<typeof renderHook<Store, unknown>>;
  await act(async () => {
    handle = renderHook(() => useStore(), { wrapper: Wrapper });
  });
  return { result: handle.result, unmount: handle.unmount };
}

/** Seeds localStorage and mounts StoreProvider, returning the live
 *  (auto-refreshing) store handle. Wrap actions in `run()` to flush them. */
export function mount(state: AppState, backend?: Backend) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return mountWith(backend);
}

/** Mounts StoreProvider against whatever is already in localStorage,
 *  without writing to it first — for tests that craft a raw (pre-migration
 *  shaped) payload by hand and want to see how `migrate()` handles it. */
export function mountFromExistingStorage() {
  return mountWith();
}

/**
 * A `LocalBackend` that can also push events — the store's *second writer*.
 *
 * `LocalBackend.subscribe` is inert by design (the demo has no server), so a
 * test that wants to drive the apply core in lib/store.tsx needs a double that
 * can actually emit. This is it.
 */
export class EventBackend extends LocalBackend {
  private listener: ((event: RealtimeEvent) => void) | null = null;

  /** How many events this double has pushed.
   *
   *  NOT a barrier. This is incremented synchronously by `emit()`, before the
   *  store has looked at the event — the apply core defers every event by a
   *  macrotask — so `waitFor(() => backend.emitted === n)` resolves on the
   *  first tick and proves nothing about the apply path. A test that needs to
   *  give the apply path its chance to be wrong should emit a second, distinct
   *  event and wait for THAT to land; the deferrals run in order, so the
   *  earlier event has necessarily had its turn. See the echo test in
   *  tests/qa/realtime-apply.test.ts, which was vacuous until it did. */
  emitted = 0;

  /** Every hydrate() this backend has answered, for assertions about whether
   *  a rollback re-hydrated or restored a snapshot, and about how many
   *  reloads a burst of `stale` events cost. */
  hydrateCalls = 0;

  override subscribe(onEvent: (event: RealtimeEvent) => void): Unsubscribe {
    this.listener = onEvent;
    return () => {
      this.listener = null;
    };
  }

  override hydrate(): Promise<AppState> {
    this.hydrateCalls += 1;
    return super.hydrate();
  }

  emit(event: RealtimeEvent): void {
    this.emitted += 1;
    this.listener?.(event);
  }
}

/** A `Backend` that behaves exactly like `LocalBackend` except for the one
 *  operation named in `failing`, which rejects. Used to drive the store's
 *  rollback rule (lib/store.tsx `commit`) from the tests.
 *
 *  `hydrate()` is the *re-hydrate* path's answer as well as the initial one,
 *  so `hydrateWith` lets a test hand back a state distinguishable from any
 *  snapshot — that is how "re-hydrated" is told apart from "restored".
 *
 *  Extends `EventBackend`, not `LocalBackend`, so a test can hold a write in
 *  flight AND push a live update through the same double — which is what the
 *  second-writer case (tests/qa/realtime-apply.test.ts) needs. `hydrateCalls`
 *  and the counting `hydrate()` now live on the base class. */
export class FailingBackend extends EventBackend {
  constructor(
    private readonly failing: FailingOp,
    /** Returned by `hydrate()` from the second call onward. Omit to keep
     *  reading localStorage like `LocalBackend` does. */
    private readonly hydrateWith?: () => AppState
  ) {
    super();
  }

  private run<T>(op: FailingOp, value: T): Promise<T> {
    return op === this.failing
      ? Promise.reject(new Error(`${op} failed`))
      : Promise.resolve(value);
  }

  override reset(): Promise<AppState> {
    return this.run("reset", createSeed());
  }

  override createUser(): Promise<string> {
    return this.run("createUser", "u_added");
  }

  override createStatus(status: StatusDef): Promise<StatusDef> {
    return this.run("createStatus", status);
  }

  override updateStatus(): Promise<void> {
    return this.run("updateStatus", undefined);
  }

  override deleteStatus(): Promise<void> {
    return this.run("deleteStatus", undefined);
  }

  override reorderStatuses(): Promise<void> {
    return this.run("reorderStatuses", undefined);
  }

  // Task sets. The union above is only half of it: an op listed there but not
  // overridden here falls through to LocalBackend's resolve, and a test naming
  // it would pass against a backend that never failed.
  override createTaskSet(set: TaskSet): Promise<TaskSet> {
    return this.run("createTaskSet", set);
  }

  override updateTaskSet(): Promise<void> {
    return this.run("updateTaskSet", undefined);
  }

  override archiveTaskSet(): Promise<void> {
    return this.run("archiveTaskSet", undefined);
  }

  override createTaskSetItem(): Promise<void> {
    return this.run("createTaskSetItem", undefined);
  }

  override updateTaskSetItem(): Promise<void> {
    return this.run("updateTaskSetItem", undefined);
  }

  override deleteTaskSetItem(): Promise<void> {
    return this.run("deleteTaskSetItem", undefined);
  }

  override reorderTaskSetItems(): Promise<void> {
    return this.run("reorderTaskSetItems", undefined);
  }

  override hydrate(): Promise<AppState> {
    // `super.hydrate()` is what counts the call, so it runs either way.
    const stored = super.hydrate();
    if (this.hydrateWith && this.hydrateCalls > 1) {
      return Promise.resolve(this.hydrateWith());
    }
    return stored;
  }

  override sendMessage(message: Message): Promise<Message> {
    return this.run("sendMessage", message);
  }

  override sendToUser(dm: DM): Promise<DM> {
    return this.run("sendToUser", dm);
  }

  override editMessage(): Promise<void> {
    return this.run("editMessage", undefined);
  }

  override deleteMessage(): Promise<void> {
    return this.run("deleteMessage", undefined);
  }

  override toggleReaction(): Promise<void> {
    return this.run("toggleReaction", undefined);
  }

  override markChannelRead(): Promise<void> {
    return this.run("markChannelRead", undefined);
  }

  override openDm(dm: DM): Promise<DM> {
    return this.run("openDm", dm);
  }

  override createTask(task: Task): Promise<Task> {
    return this.run("createTask", task);
  }

  override deleteChannel(): Promise<void> {
    return this.run("deleteChannel", undefined);
  }

  override deleteProject(): Promise<void> {
    return this.run("deleteProject", undefined);
  }

  override updateTask(): Promise<void> {
    return this.run("updateTask", undefined);
  }

  override moveTask(): Promise<void> {
    return this.run("moveTask", undefined);
  }

  override deleteTask(): Promise<void> {
    return this.run("deleteTask", undefined);
  }

  override createChannel(channel: Channel): Promise<Channel> {
    return this.run("createChannel", channel);
  }

  override setChannelAccess(): Promise<void> {
    return this.run("setChannelAccess", undefined);
  }

  override createProject(project: Project): Promise<Project> {
    return this.run("createProject", project);
  }

  override setProjectAccess(): Promise<void> {
    return this.run("setProjectAccess", undefined);
  }

  override updateProject(): Promise<void> {
    return this.run("updateProject", undefined);
  }

  override createRole(role: RoleDef): Promise<RoleDef> {
    return this.run("createRole", role);
  }

  override setUserRole(): Promise<void> {
    return this.run("setUserRole", undefined);
  }

  override setRolePermission(): Promise<void> {
    return this.run("setRolePermission", undefined);
  }

  override updateRole(): Promise<void> {
    return this.run("updateRole", undefined);
  }

  override deleteRole(): Promise<void> {
    return this.run("deleteRole", undefined);
  }

  /** Every activity this backend was asked to persist, in call order — so a
   *  test can assert the feed line actually reached the seam rather than only
   *  reaching `AppState`. Recorded before the reject check, because a refused
   *  write is still a write that was attempted. */
  activityWrites: Activity[] = [];

  /** The parameter is optional only so this stays assignable to
   *  `LocalBackend.putActivity()`, which declares none — the house style there
   *  is that a method ignoring its arguments names none of them, and the
   *  contract's parameters live in lib/backend/types.ts. Callers always pass
   *  one. */
  override putActivity(activity?: Activity): Promise<void> {
    if (activity) this.activityWrites.push(activity);
    return this.run("putActivity", undefined);
  }

  /** Every file this backend was asked to store, in call order. */
  attachmentWrites: Array<{ owner: AttachmentOwner; id: string; bytes: number }> = [];
  /** Every attachment this backend was asked to throw away. */
  attachmentDeletes: string[] = [];

  /**
   * Task 10's five. Added BEFORE the first test that names any of them, for
   * the reason this union's own comment gives: an operation with no override
   * inherits `LocalBackend`'s immediate resolve, so a "failing" backend
   * quietly succeeds and the test asserts nothing. That trap has now been
   * found four separate times in this plan (`deleteChannel`/`deleteProject`,
   * `deleteTask`, `updateRole`/`deleteRole`), which is why these are written
   * first and not after.
   *
   * `putAttachment` records the call and then delegates to `LocalBackend`, so
   * a NON-failing FailingBackend still produces a real data: URL and a test
   * about anything else is unaffected.
   */
  override putAttachment(
    owner: AttachmentOwner,
    attachment: Attachment,
    file: Blob
  ): Promise<string> {
    this.attachmentWrites.push({ owner, id: attachment.id, bytes: file.size });
    return this.failing === "putAttachment"
      ? Promise.reject(new Error("putAttachment failed"))
      : super.putAttachment(owner, attachment, file);
  }

  override saveAttachment(
    attachment: Attachment,
    file: Blob,
    editedBy: string,
    editedAt: number
  ): Promise<string> {
    return this.failing === "saveAttachment"
      ? Promise.reject(new Error("saveAttachment failed"))
      : super.saveAttachment(attachment, file, editedBy, editedAt);
  }

  override deleteAttachment(attachment: Attachment): Promise<void> {
    this.attachmentDeletes.push(attachment.id);
    return this.run("deleteAttachment", undefined);
  }

  override attachmentUrl(ref: string): Promise<string> {
    return this.run("attachmentUrl", ref);
  }

  /** The last write action that had no override — final-review.md finding 9.
   *  Without it a test naming "switchUser" got a backend that quietly
   *  succeeded, so the rollback path in `commit` could not be driven from a
   *  test at all. That is the same trap that has now bitten this plan five
   *  times; leaving one operation out is how the union and the overrides
   *  drift apart again. */
  override switchUser(): Promise<void> {
    return this.run("switchUser", undefined);
  }

  override readAttachment(ref: string): Promise<string> {
    return this.run("readAttachment", ref);
  }
}

/** The operations `FailingBackend` can be told to reject.
 *
 *  An operation missing from the overrides above inherits `LocalBackend`'s
 *  immediate resolve, so a test that names it gets a "failing" backend that
 *  quietly succeeds and an assertion that proves nothing. Task 1's own
 *  deletes were found in exactly that state — keep this union and the
 *  overrides in step. */
export type FailingOp =
  | "sendMessage"
  | "sendToUser"
  | "editMessage"
  | "deleteMessage"
  | "toggleReaction"
  | "markChannelRead"
  | "openDm"
  | "createTask"
  | "updateTask"
  | "moveTask"
  | "deleteTask"
  | "createChannel"
  | "setChannelAccess"
  | "createProject"
  | "updateProject"
  | "setProjectAccess"
  | "createRole"
  | "setUserRole"
  | "setRolePermission"
  | "updateRole"
  | "deleteRole"
  | "deleteChannel"
  | "deleteProject"
  | "switchUser"
  | "putActivity"
  | "putAttachment"
  | "saveAttachment"
  | "deleteAttachment"
  | "attachmentUrl"
  | "readAttachment"
  // `reset` is the one `Backend` method that had no entry here, so
  // `resetDemo()`'s failure path could not be driven from a test at all —
  // a latent hole of exactly the shape that has already cost this project
  // five findings, and the reason `resetDemo` shipped with no rejection
  // handler.
  | "reset"
  | "createUser"
  // The board's columns (Owner only).
  | "createStatus"
  | "updateStatus"
  | "deleteStatus"
  | "reorderStatuses"
  | "createTaskSet"
  | "updateTaskSet"
  | "archiveTaskSet"
  | "createTaskSetItem"
  | "updateTaskSetItem"
  | "deleteTaskSetItem"
  | "reorderTaskSetItems";

/** Runs a store action inside act() and returns whatever it returned, so
 *  `result.current` reflects the resulting state by the time this resolves.
 *
 *  Await-ready for the store-swap: every store action becomes `Promise<T>`
 *  once the backend seam lands (Task 1), and `await`ing a value that is
 *  already a plain `T` is a no-op — so this same signature works unchanged
 *  against today's fully synchronous store. `act`'s async form is used
 *  unconditionally so that, once actions are truly async, React gets to
 *  flush the state update the promise resolution triggers before this
 *  returns; against a synchronous action that flush is already done by the
 *  time `fn()` returns, so nothing changes for the tests running today. */
export async function run<T>(fn: () => T | Promise<T>): Promise<T> {
  let out!: T;
  await act(async () => {
    out = await fn();
  });
  return out;
}
