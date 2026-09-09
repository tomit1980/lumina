// @vitest-environment jsdom
//
// Suite — channels, projects and access against the backend seam (Plan
// "store-swap", Task 6: createChannel, deleteChannel, setChannelAccess,
// createProject, updateProject, deleteProject, setProjectAccess).
//
// These are the writes that decide who can see what, so a rejection has to be
// visibly undone rather than quietly ignored. Three properties per action, the
// same three Task 5 pinned for chat:
//
//  1. the patch is on screen while the write is still in flight;
//  2. a rejection restores exactly what was there — including the children a
//     cascade delete took with it — and toasts;
//  3. the caller can tell: every one of these resolves falsy on failure, which
//     is what keeps `app-shell.tsx`, `chat-view.tsx` and `projects/page.tsx`
//     from toasting "deleted" and navigating away from something still there.
//
// `FailingBackend` gained overrides for createChannel, setChannelAccess and
// setProjectAccess in this task; deleteChannel, deleteProject, createProject
// and updateProject already had them. That matters — an operation it does not
// override inherits `LocalBackend`'s immediate resolve, so naming it here would
// produce a "failing" backend that succeeds and a test that asserts nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { canUserSeeProject } from "@/lib/store";
import type { AppState, Project } from "@/lib/types";
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
const CHANNEL = "c_engineering"; // public, created by ME, carries messages
const PROJECT = "p_website"; // unrestricted, created by ME, carries tasks

function adminState(): AppState {
  return asUser(baseState(), ME);
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

function lastErrorToast() {
  return toastMock.error.mock.calls.at(-1);
}

describe("createChannel", () => {
  it("shows the channel before the write settles, and adopts what the backend returned", async () => {
    const { result } = await mount(adminState());
    const before = result.current.state.channels.length;

    const promise = startWrite(() =>
      result.current.createChannel({ name: "ops", description: "", isPrivate: false })
    );
    expect(result.current.state.channels).toHaveLength(before + 1);
    expect(result.current.state.channels.at(-1)!.name).toBe("ops");

    const created = await finish(promise);
    expect(created).not.toBeNull();
    // `commit`'s `ok` is the seam a real backend hands server-assigned values
    // back through, so the resolved channel — not the optimistic one — is what
    // the dialog navigates to.
    expect(result.current.state.channels.at(-1)!.id).toBe(created!.id);
  });

  it("takes the channel back off screen and resolves null when the write is refused", async () => {
    const { result } = await mount(adminState(), new FailingBackend("createChannel"));
    const before = clone(result.current.state.channels);

    const created = await run(() =>
      result.current.createChannel({ name: "ops", description: "", isPrivate: false })
    );

    expect(created).toBeNull();
    expect(result.current.state.channels).toEqual(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });
});

describe("deleteChannel", () => {
  it("removes the channel AND its messages optimistically — what the cascade will do", async () => {
    // The optimistic patch has to match the server's outcome, not a subset of
    // it: `messages.conversation_id` cascades from `conversations`, so leaving
    // the messages in state would show a thread whose channel is gone.
    const { result } = await mount(adminState());
    expect(
      result.current.state.messages.some((m) => m.channelId === CHANNEL)
    ).toBe(true);

    const promise = startWrite(() => result.current.deleteChannel(CHANNEL));
    expect(result.current.state.channels.some((c) => c.id === CHANNEL)).toBe(false);
    expect(result.current.state.messages.some((m) => m.channelId === CHANNEL)).toBe(false);

    await expect(finish(promise)).resolves.toBe(true);
  });

  it("restores the channel and its messages, and resolves FALSE, when the write fails", async () => {
    // The false is the load-bearing half: app-shell.tsx and chat-view.tsx both
    // navigate away and toast "deleted" only when this resolves truthy.
    const { result } = await mount(adminState(), new FailingBackend("deleteChannel"));
    const before = clone(result.current.state);

    const ok = await run(() => result.current.deleteChannel(CHANNEL));

    expect(ok).toBe(false);
    expect(result.current.state.channels).toEqual(before.channels);
    expect(result.current.state.messages).toEqual(before.messages);
  });
});

describe("setChannelAccess", () => {
  it("applies privacy and membership together, keeping the creator as an editor", async () => {
    const { result } = await mount(adminState());

    const promise = startWrite(() =>
      result.current.setChannelAccess(CHANNEL, {
        isPrivate: true,
        members: [{ userId: "u_maya", level: "viewer" }],
      })
    );
    const patched = result.current.state.channels.find((c) => c.id === CHANNEL)!;
    expect(patched.isPrivate).toBe(true);
    // ensureEditor: the creator cannot be locked out of their own channel.
    expect(patched.members[0]).toEqual({ userId: ME, level: "editor" });
    expect(patched.members).toHaveLength(2);

    await expect(finish(promise)).resolves.toBe(true);
  });

  it("restores the previous access and resolves false when the write is refused", async () => {
    const { result } = await mount(adminState(), new FailingBackend("setChannelAccess"));
    const before = clone(result.current.state.channels.find((c) => c.id === CHANNEL)!);

    const ok = await run(() =>
      result.current.setChannelAccess(CHANNEL, { isPrivate: true, members: [] })
    );

    expect(ok).toBe(false);
    expect(result.current.state.channels.find((c) => c.id === CHANNEL)).toEqual(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });
});

describe("createProject / updateProject", () => {
  it("shows a new project before the write settles", async () => {
    const { result } = await mount(adminState());
    const before = result.current.state.projects.length;

    const promise = startWrite(() =>
      result.current.createProject({
        name: "Rebrand", description: "", emoji: "✨", color: "#000000", priority: "low",
      })
    );
    expect(result.current.state.projects).toHaveLength(before + 1);

    const created = await finish(promise);
    expect(created?.name).toBe("Rebrand");
  });

  it("rolls a refused create back and resolves null", async () => {
    const { result } = await mount(adminState(), new FailingBackend("createProject"));
    const before = clone(result.current.state.projects);

    const created = await run(() =>
      result.current.createProject({
        name: "Rebrand", description: "", emoji: "✨", color: "#000000", priority: "low",
      })
    );

    expect(created).toBeNull();
    expect(result.current.state.projects).toEqual(before);
  });

  it("restores the old name and resolves false when a rename is refused", async () => {
    const { result } = await mount(adminState(), new FailingBackend("updateProject"));
    const before = clone(result.current.state.projects.find((p) => p.id === PROJECT)!);

    const ok = await run(() => result.current.updateProject(PROJECT, { name: "Seized" }));

    expect(ok).toBe(false);
    expect(result.current.state.projects.find((p) => p.id === PROJECT)).toEqual(before);
  });
});

describe("deleteProject", () => {
  it("removes the project AND its tasks optimistically — what the cascade will do", async () => {
    const { result } = await mount(adminState());
    expect(result.current.state.tasks.some((t) => t.projectId === PROJECT)).toBe(true);

    const promise = startWrite(() => result.current.deleteProject(PROJECT));
    expect(result.current.state.projects.some((p) => p.id === PROJECT)).toBe(false);
    expect(result.current.state.tasks.some((t) => t.projectId === PROJECT)).toBe(false);

    await expect(finish(promise)).resolves.toBe(true);
  });

  it("restores the project and its tasks, and resolves FALSE, when the write fails", async () => {
    // projects/page.tsx toasts "Project deleted" and closes the dialog only on
    // a truthy result — the fix this must not regress.
    const { result } = await mount(adminState(), new FailingBackend("deleteProject"));
    const before = clone(result.current.state);

    const ok = await run(() => result.current.deleteProject(PROJECT));

    expect(ok).toBe(false);
    expect(result.current.state.projects).toEqual(before.projects);
    expect(result.current.state.tasks).toEqual(before.tasks);
  });
});

// ---------------------------------------------------------------------------
// The pruning agreement.
//
// `setProjectAccess` drops collaborators who can no longer see the project,
// client-side, so the board is right the instant the dialog closes. The
// database does the same thing from `project_members_prune_collaborators`
// (20260907000700_assignee_visibility.sql). If the two ever disagree, the
// optimistic state is a lie until the next reload — which is why the rule is
// stated ONCE, in `canUserSeeProject`, and asserted against here rather than
// re-spelled. tests/rls/workspace-writes.test.ts runs the same comparison
// against real Postgres, which is where the server half is actually observed.
// ---------------------------------------------------------------------------
describe("setProjectAccess — collaborator pruning", () => {
  const RESTRICTED = "p_secret";
  const TASK = "t_secret";

  /** A project with three collaborators on one task: the creator (ME), a
   *  member who will be kept, and one who will not be listed at all. */
  function withCollaborators(): AppState {
    let state = adminState();
    state = addProject(state, {
      id: RESTRICTED, name: "Payroll", createdBy: ME, restricted: false,
    });
    state = addTask(state, {
      id: TASK, projectId: RESTRICTED, title: "Salary bands", createdBy: ME,
      collaboratorIds: ["u_maya", "u_jonas"],
    });
    return state;
  }

  it("prunes exactly the collaborators the visibility rule says cannot see the project", async () => {
    const { result } = await mount(withCollaborators());
    const members = [{ userId: "u_maya", level: "editor" as const }];

    const promise = startWrite(() =>
      result.current.setProjectAccess(RESTRICTED, { restricted: true, members })
    );

    // The independent computation, from the same rule the database's
    // user_can_see_project() implements — not from a hard-coded expectation.
    const after = result.current.state;
    const updated: Project = {
      ...after.projects.find((p) => p.id === RESTRICTED)!,
    };
    const expected = ["u_maya", "u_jonas"].filter((id) =>
      canUserSeeProject(after, updated, id)
    );

    expect(after.tasks.find((t) => t.id === TASK)!.collaboratorIds).toEqual(expected);
    // And the substance of it: Maya is a listed member and stays, Jonas is not
    // and goes. A prune that removed everybody would satisfy the line above.
    expect(expected).toEqual(["u_maya"]);

    await expect(finish(promise)).resolves.toBe(true);
  });

  it("prunes nobody when the project is left open — the positive control", async () => {
    // Everyone can see an unrestricted project, so the same code path must
    // leave every collaborator in place. Without this, a prune that simply
    // dropped everything would pass the test above.
    const { result } = await mount(withCollaborators());

    await run(() =>
      result.current.setProjectAccess(RESTRICTED, { restricted: false, members: [] })
    );

    expect(result.current.state.tasks.find((t) => t.id === TASK)!.collaboratorIds).toEqual([
      "u_maya",
      "u_jonas",
    ]);
  });

  it("keeps a collaborator who can see the project for a reason other than membership", async () => {
    // Pins the branches of the rule that are not "is in the member list": the
    // project's creator and any members.manage holder can still see it without
    // appearing there. A prune that only looked at the member list would strip
    // people who can plainly still open the board.
    let state = withCollaborators();
    state = {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === TASK ? { ...t, collaboratorIds: ["u_maya", "u_jonas", ME] } : t
      ),
    };
    const { result } = await mount(state);

    await run(() =>
      result.current.setProjectAccess(RESTRICTED, {
        restricted: true,
        members: [{ userId: "u_maya", level: "editor" }],
      })
    );

    const kept = result.current.state.tasks.find((t) => t.id === TASK)!.collaboratorIds;
    // ME is the project's creator AND holds members.manage: two reasons to stay.
    expect(kept).toContain(ME);
    expect(kept).not.toContain("u_jonas");
  });

  it("restores every pruned collaborator and resolves false when the write is refused", async () => {
    // The privacy-critical rollback: a refused revocation must not leave the
    // board showing people removed from tasks they are still on.
    const { result } = await mount(
      withCollaborators(),
      new FailingBackend("setProjectAccess")
    );
    const before = clone(result.current.state);

    const ok = await run(() =>
      result.current.setProjectAccess(RESTRICTED, {
        restricted: true,
        members: [{ userId: "u_maya", level: "editor" }],
      })
    );

    expect(ok).toBe(false);
    expect(result.current.state.tasks).toEqual(before.tasks);
    expect(result.current.state.projects).toEqual(before.projects);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });
});
