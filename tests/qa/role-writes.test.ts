// @vitest-environment jsdom
//
// Suite — the five role and membership writes against the backend seam (Plan
// "store-swap", Task 8: setUserRole, createRole, updateRole, setRolePermission,
// deleteRole).
//
// tests/qa/rbac-matrix.test.ts already pins what the store REFUSES, for every
// role against every write, and it must keep meaning the same thing — nothing
// here changes a guard. This file is about what happens to a write the store
// ALLOWS: it is on screen before the backend answers, it is undone if the
// backend says no, the caller can tell which of the two happened, and the feed
// line it produced actually reaches the seam.
//
// `FailingBackend` gained `updateRole` and `deleteRole` overrides in this task.
// It had neither — nor the `FailingOp` entries — so a rollback test naming one
// would have run against a "failing" backend that quietly succeeded. That is
// the FOURTH time this trap has surfaced in this plan (Task 1's two deletes,
// Task 7's deleteTask, these two); see the union's own comment in _support.ts.
// Both overrides were added BEFORE the first assertion below was written, and
// removing either one now fails the matching test rather than passing it
// vacuously — which is the property that makes these tests worth having.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import type { AppState } from "@/lib/types";
import { FailingBackend, addRole, asUser, baseState, clone, mount, run } from "./_support";
import type { FailingOp } from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

const ME = "u_vlad"; // admin: holds every permission, including members.manage
/** A custom, unlocked, non-system role with nobody in it — the only kind the
 *  store lets `updateRole` / `setRolePermission` / `deleteRole` touch. */
const CUSTOM = "r_auditor";

function adminState(): AppState {
  return asUser(
    addRole(baseState(), {
      id: CUSTOM,
      name: "Auditor",
      description: "Reads everything",
      permissions: ["message.send"],
    }),
    ME
  );
}

type Store = Awaited<ReturnType<typeof mount>>["result"]["current"];

function lastErrorToast() {
  return toastMock.error.mock.calls.at(-1);
}

// ---------------------------------------------------------------------------
// 1. The optimistic patch — the change is on screen before the backend answers
// ---------------------------------------------------------------------------
describe("the change is visible while the write is still in flight", () => {
  /** Holds the backend's answer open so the state can be inspected mid-write.
   *  Mirrors tests/qa/optimistic-rollback.test.ts, which owns the same
   *  property for one action per family. */
  function startWrite<T>(write: () => Promise<T>) {
    let promise!: Promise<T>;
    act(() => {
      promise = write();
    });
    return { promise };
  }

  /** Drains a started write, and the re-render its resolution schedules.
   *  `act(...)` returns a thenable, not a Promise, so its result cannot be
   *  chained — the value has to be captured from inside. */
  async function finish<T>(promise: Promise<T>): Promise<T> {
    let out!: T;
    await act(async () => {
      out = await promise;
    });
    return out;
  }

  it("setUserRole — the member already shows their new role", async () => {
    const { result } = await mount(adminState());

    const { promise } = startWrite(() => result.current.setUserRole("u_maya", "guest"));
    expect(result.current.state.users.find((u) => u.id === "u_maya")!.roleId).toBe("guest");

    expect(await finish(promise)).toBe(true);
  });

  it("updateRole — the renamed role is already renamed", async () => {
    const { result } = await mount(adminState());

    const { promise } = startWrite(() => result.current.updateRole(CUSTOM, { name: "Reviewer" }));
    expect(result.current.state.roles.find((r) => r.id === CUSTOM)!.name).toBe("Reviewer");

    expect(await finish(promise)).toBe(true);
  });

  it("setRolePermission — the checkbox is already ticked", async () => {
    const { result } = await mount(adminState());

    const { promise } = startWrite(() =>
      result.current.setRolePermission(CUSTOM, "task.create", true)
    );
    expect(result.current.state.roles.find((r) => r.id === CUSTOM)!.permissions).toContain(
      "task.create"
    );

    expect(await finish(promise)).toBe(true);
  });

  it("deleteRole — the role is already off the list", async () => {
    const { result } = await mount(adminState());

    const { promise } = startWrite(() => result.current.deleteRole(CUSTOM));
    expect(result.current.state.roles.some((r) => r.id === CUSTOM)).toBe(false);

    expect(await finish(promise)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Rollback — a refused write is undone, and SAYS so
// ---------------------------------------------------------------------------
describe("a rejected write restores the snapshot, toasts, and returns falsy", () => {
  async function expectRestored(
    failing: FailingOp,
    write: (store: Store) => Promise<unknown>,
    read: (s: AppState) => unknown
  ) {
    const backend = new FailingBackend(failing);
    const { result } = await mount(adminState(), backend);
    const before = clone(read(result.current.state));

    const outcome = await run(() => write(result.current));

    // Falsy, not merely "not true": every one of these five returns a value a
    // call site checks (app/people/page.tsx bails on it, components/
    // role-dialog.tsx keeps the dialog open on it). A refused write that
    // reported success is the class this project has fixed seven times.
    expect(outcome).toBeFalsy();
    expect(read(result.current.state)).toEqual(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
    // Restored in place — no re-hydrate was needed, so nothing else was lost.
    expect(backend.hydrateCalls).toBe(1);
  }

  it("setUserRole — the member keeps the role they had", async () => {
    await expectRestored(
      "setUserRole",
      (store) => store.setUserRole("u_maya", "guest"),
      (s) => s.users
    );
  });

  it("createRole — the role is taken back off the list", async () => {
    await expectRestored(
      "createRole",
      (store) =>
        store.createRole({ name: "Doomed", description: "", color: "#000", permissions: [] }),
      (s) => s.roles
    );
  });

  it("updateRole — the rename is undone", async () => {
    await expectRestored(
      "updateRole",
      (store) => store.updateRole(CUSTOM, { name: "Reviewer" }),
      (s) => s.roles
    );
  });

  it("setRolePermission — the checkbox goes back, activities included", async () => {
    // `activities` is read alongside `roles` here because this action appends a
    // feed line and the rollback has to take that back too — a granted
    // permission that was refused must not leave "granted X to Auditors" up.
    await expectRestored(
      "setRolePermission",
      (store) => store.setRolePermission(CUSTOM, "task.create", true),
      (s) => ({ roles: s.roles, activities: s.activities })
    );
  });

  it("deleteRole — the role comes back", async () => {
    await expectRestored(
      "deleteRole",
      (store) => store.deleteRole(CUSTOM),
      (s) => ({ roles: s.roles, activities: s.activities })
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The feed lines actually reach the seam — VERIFIED, not assumed
// ---------------------------------------------------------------------------
describe("activity persistence needs no plumbing in these five", () => {
  // `commit` DIFFS the patch for newly-appended activity ids rather than taking
  // the entries as an argument, so a converted write persists its feed line
  // with no work at the call site. Task 7 verified that rather than assuming
  // it; so does this. The negative control is the point — `updateRole` appends
  // no line at all, so a `putActivity` that fired for everything could not pass
  // both halves.
  const recording = () => new FailingBackend("deleteMessage");

  it("deleteRole's line IS persistable, unlike Task 6's two deletes", async () => {
    // `activities.project_id` / `.conversation_id` cascade from projects and
    // conversations, which is why `deleted the X project` cannot be stored.
    // A role is neither: the line is workspace-wide, both scope columns are
    // null, and there is nothing to outrun.
    const backend = recording();
    const { result } = await mount(adminState(), backend);

    await run(() => result.current.deleteRole(CUSTOM));

    expect(backend.activityWrites).toHaveLength(1);
    const [a] = backend.activityWrites;
    expect(a.text).toContain("Auditor");
    expect(a.projectId).toBeNull();
    expect(a.conversationId).toBeNull();
  });

  it("createRole and setRolePermission each log exactly one line", async () => {
    const backend = recording();
    const { result } = await mount(adminState(), backend);

    await run(() =>
      result.current.createRole({ name: "Steward", description: "", color: "#000", permissions: [] })
    );
    await run(() => result.current.setRolePermission(CUSTOM, "task.create", true));

    expect(backend.activityWrites.map((a) => a.kind)).toEqual(["member", "member"]);
    expect(backend.activityWrites[0].text).toContain("Steward");
    expect(backend.activityWrites[1].text).toContain("Auditor");
  });

  it("updateRole logs nothing at all — the negative control", async () => {
    const backend = recording();
    const { result } = await mount(adminState(), backend);

    await run(() => result.current.updateRole(CUSTOM, { name: "Reviewer" }));

    expect(backend.activityWrites).toEqual([]);
    expect(result.current.state.roles.find((r) => r.id === CUSTOM)!.name).toBe("Reviewer");
  });

  it("a refused feed line does not undo the role change it describes", async () => {
    // The whole reason `putActivity` is a separate call: one promise would make
    // a rejected log line roll a real role change off the screen.
    const backend = new FailingBackend("putActivity");
    const { result } = await mount(adminState(), backend);

    const ok = await run(() => result.current.setRolePermission(CUSTOM, "task.create", true));

    expect(ok).toBe(true);
    expect(result.current.state.roles.find((r) => r.id === CUSTOM)!.permissions).toContain(
      "task.create"
    );
    // ...but the line does not stay on screen either, or a reload would lose it.
    expect(result.current.state.activities.some((a) => a.text.includes("Auditor"))).toBe(false);
  });
});
