// @vitest-environment jsdom
//
// Suite — task owner + collaborators (Plan "task-collaborators", Task 2).
// Covers normaliseCollaborators (pure), canUserSeeProject (via the
// createTask/updateTask write-time guard, and via canSeeProject agreeing
// with it for the current user), and the per-person activity log entries
// for owner/collaborator changes.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import { canUserSeeTaskProject, normaliseCollaborators } from "@/lib/store";
import { addProject, addTask, asUser, baseState, mount, run, type Store } from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function taskInput(overrides: Partial<Parameters<Store["createTask"]>[0]> = {}) {
  return {
    projectId: "p_unrestricted",
    title: "New task",
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

describe("normaliseCollaborators (pure)", () => {
  it("is order-preserving for an already-clean list", async () => {
    expect(normaliseCollaborators(null, ["u_a", "u_b", "u_c"])).toEqual([
      "u_a",
      "u_b",
      "u_c",
    ]);
  });

  it("drops the owner wherever it appears in the list", async () => {
    expect(normaliseCollaborators("u_b", ["u_a", "u_b", "u_c"])).toEqual([
      "u_a",
      "u_c",
    ]);
  });

  it("collapses duplicates, keeping the first occurrence's position", async () => {
    expect(normaliseCollaborators(null, ["u_a", "u_b", "u_a", "u_c", "u_b"])).toEqual([
      "u_a",
      "u_b",
      "u_c",
    ]);
  });

  it("handles a null owner (unassigned task) without dropping anyone", async () => {
    expect(normaliseCollaborators(null, ["u_a", "u_b"])).toEqual(["u_a", "u_b"]);
  });

  it("is pure — does not mutate its input array", async () => {
    const input = ["u_a", "u_b"];
    normaliseCollaborators("u_a", input);
    expect(input).toEqual(["u_a", "u_b"]);
  });
});

describe("createTask — owner/collaborator normalisation and visibility guard", () => {
  it("drops the owner from the collaborator list automatically", async () => {
    const state = addProject(baseState(), {
      id: "p_unrestricted",
      name: "Open Project",
      createdBy: "u_sam",
      restricted: false,
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const task = await run(() =>
      result.current.createTask(
        taskInput({ assigneeId: "u_jonas", collaboratorIds: ["u_jonas", "u_priya"] })
      )
    );
    expect(task).not.toBeNull();
    expect(task!.collaboratorIds).toEqual(["u_priya"]);
  });

  it("collapses duplicate collaborators", async () => {
    const state = addProject(baseState(), {
      id: "p_unrestricted",
      name: "Open Project",
      createdBy: "u_sam",
      restricted: false,
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const task = await run(() =>
      result.current.createTask(
        taskInput({ assigneeId: null, collaboratorIds: ["u_priya", "u_jonas", "u_priya"] })
      )
    );
    expect(task!.collaboratorIds).toEqual(["u_priya", "u_jonas"]);
  });

  it("an unrestricted project accepts any user as a collaborator", async () => {
    const state = addProject(baseState(), {
      id: "p_unrestricted",
      name: "Open Project",
      createdBy: "u_sam",
      restricted: false,
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const task = await run(() =>
      result.current.createTask(
        taskInput({ collaboratorIds: ["u_jonas", "u_priya", "u_elena"] })
      )
    );
    expect(task).not.toBeNull();
    expect(task!.collaboratorIds).toEqual(["u_jonas", "u_priya", "u_elena"]);
  });

  it("refuses the whole write when a collaborator can't see a restricted project", async () => {
    const state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" }],
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const before = result.current.state.tasks.length;
    const beforeActivities = result.current.state.activities.length;
    const task = await run(() =>
      result.current.createTask(
        taskInput({
          projectId: "p_restricted",
          collaboratorIds: ["u_jonas"], // not a member, not the creator, no members.manage
        })
      )
    );
    expect(task).toBeNull();
    expect(result.current.state.tasks.length).toBe(before);
    expect(result.current.state.activities.length).toBe(beforeActivities);
  });

  // F4 (final-review.md) — "assignment never grants access" was enforced for
  // the collaborator slot but not the owner slot: assigneeId could be set to
  // someone who cannot see the project. Same guard, same shape, same voice.
  it("refuses the whole write when the OWNER can't see a restricted project", async () => {
    const state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" }],
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const before = result.current.state.tasks.length;
    const beforeActivities = result.current.state.activities.length;
    const task = await run(() =>
      result.current.createTask(
        taskInput({
          projectId: "p_restricted",
          assigneeId: "u_jonas", // not a member, not the creator, no members.manage
        })
      )
    );
    expect(task).toBeNull();
    expect(result.current.state.tasks.length).toBe(before);
    expect(result.current.state.activities.length).toBe(beforeActivities);
  });

  // Finding 10 (final-review.md) — the visibility guard used to sit inside
  // `if (s0 && project0)`, so a task whose projectId doesn't resolve to a
  // real project skipped the check entirely (fail open) instead of being
  // refused (fail closed).
  it("fails closed — refuses the write when projectId doesn't resolve to a real project", async () => {
    const state = baseState();
    const { result } = await mount(asUser(state, "u_maya"));
    const before = result.current.state.tasks.length;
    const task = await run(() =>
      result.current.createTask(taskInput({ projectId: "p_does_not_exist" }))
    );
    expect(task).toBeNull();
    expect(result.current.state.tasks.length).toBe(before);
  });
});

describe("updateTask — owner/collaborator normalisation and visibility guard", () => {
  function unrestrictedProjectWithTask() {
    let state = addProject(baseState(), {
      id: "p_unrestricted",
      name: "Open Project",
      createdBy: "u_sam",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_1",
      projectId: "p_unrestricted",
      title: "Existing task",
      createdBy: "u_sam",
      assigneeId: null,
      collaboratorIds: [],
    });
    return state;
  }

  it("a patch that sets the owner to an existing collaborator removes them from the list", async () => {
    let state = unrestrictedProjectWithTask();
    state = {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === "t_1" ? { ...t, collaboratorIds: ["u_maya", "u_jonas"] } : t
      ),
    };
    const { result } = await mount(asUser(state, "u_maya"));
    const ok = await run(() => result.current.updateTask("t_1", { assigneeId: "u_maya" }));
    expect(ok).toBe(true);
    const task = result.current.state.tasks.find((t) => t.id === "t_1")!;
    expect(task.assigneeId).toBe("u_maya");
    expect(task.collaboratorIds).toEqual(["u_jonas"]);
  });

  it("a patch changing owner and collaborators together resolves against the resulting owner", async () => {
    let state = unrestrictedProjectWithTask();
    state = {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === "t_1"
          ? { ...t, assigneeId: "u_jonas", collaboratorIds: ["u_priya"] }
          : t
      ),
    };
    const { result } = await mount(asUser(state, "u_maya"));
    // Sets the owner to u_priya (the old collaborator) while also submitting
    // a collaborator list that (redundantly) names both the new and old
    // owner — the resulting list must drop only the *new* owner.
    const ok = await run(() =>
      result.current.updateTask("t_1", {
        assigneeId: "u_priya",
        collaboratorIds: ["u_priya", "u_jonas"],
      })
    );
    expect(ok).toBe(true);
    const task = result.current.state.tasks.find((t) => t.id === "t_1")!;
    expect(task.assigneeId).toBe("u_priya");
    expect(task.collaboratorIds).toEqual(["u_jonas"]);
  });

  it("an unrestricted project accepts any user as a collaborator on update", async () => {
    const state = unrestrictedProjectWithTask();
    const { result } = await mount(asUser(state, "u_maya"));
    const ok = await run(() =>
      result.current.updateTask("t_1", { collaboratorIds: ["u_jonas", "u_priya", "u_elena"] })
    );
    expect(ok).toBe(true);
    const task = result.current.state.tasks.find((t) => t.id === "t_1")!;
    expect(task.collaboratorIds).toEqual(["u_jonas", "u_priya", "u_elena"]);
  });

  it("refuses the whole write when a collaborator can't see a restricted project, leaving state unchanged", async () => {
    let state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" }],
    });
    state = addTask(state, {
      id: "t_r1",
      projectId: "p_restricted",
      title: "Existing task",
      createdBy: "u_sam",
      assigneeId: null,
      collaboratorIds: [],
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const beforeTask = result.current.state.tasks.find((t) => t.id === "t_r1")!;
    const beforeActivities = result.current.state.activities.length;
    const ok = await run(() =>
      result.current.updateTask("t_r1", { collaboratorIds: ["u_jonas"] })
    );
    expect(ok).toBe(false);
    const afterTask = result.current.state.tasks.find((t) => t.id === "t_r1")!;
    expect(afterTask).toEqual(beforeTask);
    expect(result.current.state.activities.length).toBe(beforeActivities);
  });

  // fix-b001 / B-003: this scenario — a collaborator (Priya) added while the
  // project was open, the project restricted afterwards without anyone
  // touching the task — originally REFUSED the unrelated edit. That was
  // wrong, and it locked every user out of the task: the home page's
  // quick-complete passes no assignment at all and was refused too.
  // "Assignment never grants access" governs who you may ASSIGN; a person
  // already on the task who later lost sight of the project is not the
  // editing user's doing. The write now succeeds and leaves the stale entry
  // untouched (the dialog prunes it on open, and revoking access prunes it
  // at the source). Newly adding such a person is still refused — see the
  // B-003 block at the end of this file.
  it("allows a title-only patch when an existing collaborator lost visibility after the project was later restricted", async () => {
    let state = addProject(baseState(), {
      id: "p_later_restricted",
      name: "Later Restricted",
      createdBy: "u_sam",
      restricted: false, // Priya could see it at the time she was added
    });
    state = addTask(state, {
      id: "t_pr",
      projectId: "p_later_restricted",
      title: "Existing task",
      createdBy: "u_sam",
      assigneeId: null,
      collaboratorIds: ["u_priya"],
    });
    // Restrict the project afterwards without anyone touching the task's
    // collaborator list — Priya is now a member-list omission, not a
    // deliberate removal.
    state = {
      ...state,
      projects: state.projects.map((p) =>
        p.id === "p_later_restricted"
          ? { ...p, restricted: true, members: [{ userId: "u_maya", level: "editor" }] }
          : p
      ),
    };
    const { result } = await mount(asUser(state, "u_maya"));
    const beforeTask = result.current.state.tasks.find((t) => t.id === "t_pr")!;
    // The patch only changes the title and assigns nobody, so it goes
    // through. Priya stays on the task rather than being silently dropped —
    // removing her is a decision for the dialog (which shows a notice) or
    // for revocation, not a side effect of renaming.
    const ok = await run(() => result.current.updateTask("t_pr", { title: "Renamed" }));
    expect(ok).toBe(true);
    const afterTask = result.current.state.tasks.find((t) => t.id === "t_pr")!;
    expect(afterTask.title).toBe("Renamed");
    expect(afterTask.collaboratorIds).toEqual(beforeTask.collaboratorIds);
  });

  it("succeeds a title-only patch once the ineligible collaborator has been pruned from the task", async () => {
    const state = addProject(baseState(), {
      id: "p_later_restricted2",
      name: "Later Restricted",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" }],
    });
    const withTask = addTask(state, {
      id: "t_pr2",
      projectId: "p_later_restricted2",
      title: "Existing task",
      createdBy: "u_sam",
      assigneeId: null,
      collaboratorIds: [], // already pruned, as the dialog now does on open
    });
    const { result } = await mount(asUser(withTask, "u_maya"));
    const ok = await run(() => result.current.updateTask("t_pr2", { title: "Renamed" }));
    expect(ok).toBe(true);
    expect(result.current.state.tasks.find((t) => t.id === "t_pr2")?.title).toBe("Renamed");
  });

  // F4 (final-review.md) — same guard, applied to a patch that sets the
  // owner rather than a collaborator.
  it("refuses setting the owner to someone who can't see a restricted project", async () => {
    let state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" }],
    });
    state = addTask(state, {
      id: "t_owner_guard",
      projectId: "p_restricted",
      title: "Existing task",
      createdBy: "u_sam",
      assigneeId: null,
      collaboratorIds: [],
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const beforeTask = result.current.state.tasks.find((t) => t.id === "t_owner_guard")!;
    const ok = await run(() =>
      result.current.updateTask("t_owner_guard", { assigneeId: "u_jonas" })
    );
    expect(ok).toBe(false);
    expect(result.current.state.tasks.find((t) => t.id === "t_owner_guard")).toEqual(
      beforeTask
    );
  });

  // Finding 10 — same fail-closed reshape, on the updateTask side.
  it("fails closed — refuses the write when the task's project doesn't resolve", async () => {
    let state = addProject(baseState(), {
      id: "p_will_vanish",
      name: "Will Vanish",
      createdBy: "u_sam",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_orphan",
      // References a project id that isn't in state.projects at all — the
      // orphan a deleted-but-not-cascaded project would leave behind.
      projectId: "p_does_not_exist",
      title: "Orphaned task",
      createdBy: "u_sam",
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const beforeTask = result.current.state.tasks.find((t) => t.id === "t_orphan")!;
    const ok = await run(() => result.current.updateTask("t_orphan", { title: "Renamed" }));
    expect(ok).toBe(false);
    expect(result.current.state.tasks.find((t) => t.id === "t_orphan")).toEqual(beforeTask);
  });

  it("a restricted project's creator can be a collaborator even when not explicitly listed as a member", async () => {
    let state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted Project",
      createdBy: "u_sam", // creator, deliberately not in `members`
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" }],
    });
    state = addTask(state, {
      id: "t_r2",
      projectId: "p_restricted",
      title: "Existing task",
      createdBy: "u_sam",
      assigneeId: null,
      collaboratorIds: [],
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const ok = await run(() =>
      result.current.updateTask("t_r2", { collaboratorIds: ["u_sam"] })
    );
    expect(ok).toBe(true);
    expect(result.current.state.tasks.find((t) => t.id === "t_r2")?.collaboratorIds).toEqual([
      "u_sam",
    ]);
  });
});

describe("canSeeProject / canUserSeeProject agree for the current user", () => {
  it("a restricted project's creator, not listed as a member, can see their own project", async () => {
    const state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "viewer" }], // creator omitted
    });
    const { result } = await mount(asUser(state, "u_sam"));
    const project = result.current.state.projects.find((p) => p.id === "p_restricted")!;
    expect(result.current.canSeeProject(project)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// F2 (final-review.md) — revocation left stale rows: removing someone's
// project access pruned nothing from collaboratorIds, so a task could keep
// naming a collaborator who could no longer see its project.
// ---------------------------------------------------------------------
describe("setProjectAccess prunes stray collaborators on revocation (F2)", () => {
  it("drops a collaborator's id from the project's tasks once they lose visibility", async () => {
    let state = addProject(baseState(), {
      id: "p_revoke",
      name: "Revoke Me",
      createdBy: "u_vlad",
      restricted: false, // open — jonas can see it and is added as a collaborator
    });
    state = addTask(state, {
      id: "t_revoke",
      projectId: "p_revoke",
      title: "Shared task",
      createdBy: "u_vlad",
      assigneeId: "u_sam",
      collaboratorIds: ["u_jonas"],
    });
    const { result } = await mount(asUser(state, "u_vlad"));

    // Restrict the project without inviting jonas back — the exact
    // revocation shape final-review.md's probe A3 exercised directly
    // against Postgres.
    const ok = await run(() =>
      result.current.setProjectAccess("p_revoke", {
        restricted: true,
        members: [{ userId: "u_maya", level: "editor" }],
      })
    );
    expect(ok).toBe(true);
    const task = result.current.state.tasks.find((t) => t.id === "t_revoke")!;
    expect(task.collaboratorIds).toEqual([]);
  });

  it("leaves a collaborator's id alone when they're still listed as a member", async () => {
    let state = addProject(baseState(), {
      id: "p_keep",
      name: "Keep Access",
      createdBy: "u_vlad",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_keep",
      projectId: "p_keep",
      title: "Shared task",
      createdBy: "u_vlad",
      assigneeId: "u_sam",
      collaboratorIds: ["u_jonas"],
    });
    const { result } = await mount(asUser(state, "u_vlad"));

    const ok = await run(() =>
      result.current.setProjectAccess("p_keep", {
        restricted: true,
        members: [
          { userId: "u_maya", level: "editor" },
          { userId: "u_jonas", level: "viewer" },
        ],
      })
    );
    expect(ok).toBe(true);
    const task = result.current.state.tasks.find((t) => t.id === "t_keep")!;
    expect(task.collaboratorIds).toEqual(["u_jonas"]);
  });

  // The reviewer's exact repro (finding 2): before this fix, a stale
  // collaborator refused updateTask (quick-complete) while moveTask
  // (drag-to-done) — which never re-validates collaborators — still
  // succeeded. Pruning at the revocation source resolves the asymmetry:
  // once collaboratorIds no longer names anyone ineligible, BOTH paths
  // agree, so moveTask never needed its own copy of the guard.
  it("resolves the quick-complete-vs-drag asymmetry: both paths succeed once revocation has pruned", async () => {
    let state = addProject(baseState(), {
      id: "p_asym",
      name: "Asymmetry",
      createdBy: "u_vlad",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_asym",
      projectId: "p_asym",
      title: "Finish this",
      createdBy: "u_vlad",
      assigneeId: "u_sam",
      collaboratorIds: ["u_jonas"],
      status: "todo",
      order: 0,
    });
    const { result } = await mount(asUser(state, "u_vlad"));

    await run(() =>
      result.current.setProjectAccess("p_asym", {
        restricted: true,
        members: [{ userId: "u_sam", level: "editor" }],
      })
    );
    expect(
      result.current.state.tasks.find((t) => t.id === "t_asym")?.collaboratorIds
    ).toEqual([]);

    // Quick-complete's shape (updateTask with an unrelated status patch).
    const updated = await run(() =>
      result.current.updateTask("t_asym", { status: "done" })
    );
    expect(updated).toBe(true);
    expect(result.current.state.tasks.find((t) => t.id === "t_asym")?.status).toBe(
      "done"
    );
  });
});

// ---------------------------------------------------------------------
// F1 (final-review.md) — the shared read-path visibility helper the home
// list, schedule export, and reminder gate all now call. Exercised directly
// here (pure); tests/qa/home-collaborators.test.ts,
// tests/qa/reminders-collaborators.test.ts,
// tests/qa/app-shell-collaborators.test.ts and
// tests/qa/projects-page-collaborators.test.ts exercise it through each
// real call site.
// ---------------------------------------------------------------------
describe("canUserSeeTaskProject (F1 helper)", () => {
  it("is false for a revoked collaborator once their project access is gone", async () => {
    let state = addProject(baseState(), {
      id: "p_ctp",
      name: "CTP",
      createdBy: "u_vlad",
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" }], // jonas omitted
    });
    state = addTask(state, {
      id: "t_ctp",
      projectId: "p_ctp",
      title: "Task",
      createdBy: "u_vlad",
      collaboratorIds: ["u_jonas"],
    });
    const task = state.tasks.find((t) => t.id === "t_ctp")!;
    expect(canUserSeeTaskProject(state, task, "u_jonas")).toBe(false);
  });

  it("is true once the same user can see the project", async () => {
    let state = addProject(baseState(), {
      id: "p_ctp2",
      name: "CTP2",
      createdBy: "u_vlad",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_ctp2",
      projectId: "p_ctp2",
      title: "Task",
      createdBy: "u_vlad",
      collaboratorIds: ["u_jonas"],
    });
    const task = state.tasks.find((t) => t.id === "t_ctp2")!;
    expect(canUserSeeTaskProject(state, task, "u_jonas")).toBe(true);
  });

  it("fails closed when the task's project can't be resolved at all", async () => {
    const state = addTask(baseState(), {
      id: "t_ctp3",
      projectId: "p_missing_entirely",
      title: "Task",
      createdBy: "u_vlad",
    });
    const task = state.tasks.find((t) => t.id === "t_ctp3")!;
    expect(canUserSeeTaskProject(state, task, "u_vlad")).toBe(false);
  });
});

describe("activity log — owner and collaborator changes, per person", () => {
  function unrestrictedProjectWithTask() {
    let state = addProject(baseState(), {
      id: "p_unrestricted",
      name: "Open Project",
      createdBy: "u_sam",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_1",
      projectId: "p_unrestricted",
      title: "Ship the launch page",
      createdBy: "u_sam",
      assigneeId: null,
      collaboratorIds: [],
    });
    return state;
  }

  it("assigning an owner logs 'assigned “title” to Name'", async () => {
    const state = unrestrictedProjectWithTask();
    const { result } = await mount(asUser(state, "u_maya"));
    await run(() => result.current.updateTask("t_1", { assigneeId: "u_jonas" }));
    const last = result.current.state.activities.at(-1)!;
    expect(last.kind).toBe("task");
    expect(last.text).toBe("assigned “Ship the launch page” to Jonas Weber");
  });

  it("clearing the owner logs 'unassigned “title”'", async () => {
    let state = unrestrictedProjectWithTask();
    state = {
      ...state,
      tasks: state.tasks.map((t) => (t.id === "t_1" ? { ...t, assigneeId: "u_jonas" } : t)),
    };
    const { result } = await mount(asUser(state, "u_maya"));
    await run(() => result.current.updateTask("t_1", { assigneeId: null }));
    const last = result.current.state.activities.at(-1)!;
    expect(last.text).toBe("unassigned “Ship the launch page”");
  });

  it("adding a collaborator logs 'added Name to “title”'", async () => {
    const state = unrestrictedProjectWithTask();
    const { result } = await mount(asUser(state, "u_maya"));
    await run(() => result.current.updateTask("t_1", { collaboratorIds: ["u_priya"] }));
    const last = result.current.state.activities.at(-1)!;
    expect(last.text).toBe("added Priya Sharma to “Ship the launch page”");
  });

  it("removing a collaborator logs 'removed Name from “title”'", async () => {
    let state = unrestrictedProjectWithTask();
    state = {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === "t_1" ? { ...t, collaboratorIds: ["u_priya"] } : t
      ),
    };
    const { result } = await mount(asUser(state, "u_maya"));
    await run(() => result.current.updateTask("t_1", { collaboratorIds: [] }));
    const last = result.current.state.activities.at(-1)!;
    expect(last.text).toBe("removed Priya Sharma from “Ship the launch page”");
  });

  it("emits one activity entry per person for a combined owner+collaborator change", async () => {
    let state = unrestrictedProjectWithTask();
    state = {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === "t_1" ? { ...t, assigneeId: "u_jonas", collaboratorIds: ["u_priya"] } : t
      ),
    };
    const { result } = await mount(asUser(state, "u_maya"));
    const before = result.current.state.activities.length;
    await run(() =>
      result.current.updateTask("t_1", {
        assigneeId: "u_elena",
        collaboratorIds: ["u_priya", "u_jonas"],
      })
    );
    const added = result.current.state.activities.slice(before);
    expect(added.map((a) => a.text)).toEqual([
      "assigned “Ship the launch page” to Elena Rossi",
      "added Jonas Weber to “Ship the launch page”",
    ]);
  });

  it("moving an existing collaborator into the owner slot logs both the assignment and the removal", async () => {
    let state = unrestrictedProjectWithTask();
    state = {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === "t_1" ? { ...t, collaboratorIds: ["u_priya", "u_jonas"] } : t
      ),
    };
    const { result } = await mount(asUser(state, "u_maya"));
    const before = result.current.state.activities.length;
    await run(() => result.current.updateTask("t_1", { assigneeId: "u_priya" }));
    const added = result.current.state.activities.slice(before);
    expect(added.map((a) => a.text)).toEqual([
      "assigned “Ship the launch page” to Priya Sharma",
      "removed Priya Sharma from “Ship the launch page”",
    ]);
  });

  it("createTask does not emit assignment activity on top of the 'created' entry", async () => {
    const state = addProject(baseState(), {
      id: "p_unrestricted",
      name: "Open Project",
      createdBy: "u_sam",
      restricted: false,
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const before = result.current.state.activities.length;
    await run(() =>
      result.current.createTask(
        taskInput({ title: "Brand new task", assigneeId: "u_jonas", collaboratorIds: ["u_priya"] })
      )
    );
    const added = result.current.state.activities.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe("created “Brand new task”");
  });
});


// ---------------------------------------------------------------------
// B-002 — the other two false-success paths, found while verifying B-001
// in a real browser. A UI may only report success for a write the store
// actually applied, so every guarded task write must SAY when it refused.
// `deleteTask` returned void, so the dialog could not tell.
// ---------------------------------------------------------------------
describe("deleteTask reports refusal to its caller (B-002)", () => {
  it("returns false for a viewer-only member and leaves the task in place", async () => {
    let state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted",
      createdBy: "u_vlad",
      restricted: true,
      members: [{ userId: "u_maya", level: "viewer" }],
    });
    state = addTask(state, {
      id: "t_b002_del",
      projectId: "p_restricted",
      title: "Keep me",
      createdBy: "u_vlad",
    });
    const { result } = await mount(asUser(state, "u_maya"));

    const returned = await run(() => result.current.deleteTask("t_b002_del"));

    expect(returned).toBe(false);
    expect(result.current.state.tasks.some((t) => t.id === "t_b002_del")).toBe(true);
  });

  it("returns true when the delete actually happens", async () => {
    let state = addProject(baseState(), {
      id: "p_open",
      name: "Open",
      createdBy: "u_vlad",
      restricted: false,
      members: [],
    });
    state = addTask(state, {
      id: "t_b002_ok",
      projectId: "p_open",
      title: "Bye",
      createdBy: "u_vlad",
    });
    const { result } = await mount(asUser(state, "u_vlad"));

    const returned = await run(() => result.current.deleteTask("t_b002_ok"));

    expect(returned).toBe(true);
    expect(result.current.state.tasks.some((t) => t.id === "t_b002_ok")).toBe(false);
  });

  it("returns false for a task that does not exist", async () => {
    const { result } = await mount(asUser(baseState(), "u_vlad"));
    expect(await run(() => result.current.deleteTask("t_nope"))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// B-003 — a stale assignment must not make a task uneditable.
// "Assignment never grants access" governs who you may ASSIGN. Someone who
// was already on the task and later lost sight of the project is not the
// editing user's doing; refusing over them locked everyone out of the task,
// including the home page's quick-complete, which assigns nobody at all.
// ---------------------------------------------------------------------
describe("a stale assignment does not block unrelated edits (B-003)", () => {
  async function restrictedProjectWith(taskFields: Record<string, unknown>) {
    let state = addProject(baseState(), {
      id: "p_stale",
      name: "Restricted",
      createdBy: "u_vlad",
      restricted: true,
      members: [{ userId: "u_vlad", level: "editor" }],
    });
    state = addTask(state, {
      id: "t_stale",
      projectId: "p_stale",
      title: "Still editable",
      createdBy: "u_vlad",
      ...taskFields,
    });
    return await mount(asUser(state, "u_vlad"));
  }

  it("an owner who lost visibility does not block a status change", async () => {
    const { result } = await restrictedProjectWith({
      assigneeId: "u_priya",
      collaboratorIds: [],
    });
    expect(await run(() => result.current.updateTask("t_stale", { status: "done" }))).toBe(true);
    expect(result.current.state.tasks.find((t) => t.id === "t_stale")!.status).toBe("done");
  });

  it("a collaborator who lost visibility does not block a status change", async () => {
    const { result } = await restrictedProjectWith({
      assigneeId: "u_vlad",
      collaboratorIds: ["u_priya"],
    });
    expect(await run(() => result.current.updateTask("t_stale", { status: "done" }))).toBe(true);
    expect(result.current.state.tasks.find((t) => t.id === "t_stale")!.status).toBe("done");
  });

  it("but newly ASSIGNING someone who cannot see the project is still refused", async () => {
    const { result } = await restrictedProjectWith({
      assigneeId: "u_vlad",
      collaboratorIds: [],
    });
    expect(
      await run(() => result.current.updateTask("t_stale", { assigneeId: "u_priya" }))
    ).toBe(false);
    expect(result.current.state.tasks.find((t) => t.id === "t_stale")!.assigneeId).toBe("u_vlad");
  });

  it("and newly ADDING a collaborator who cannot see the project is still refused", async () => {
    const { result } = await restrictedProjectWith({
      assigneeId: "u_vlad",
      collaboratorIds: [],
    });
    expect(
      await run(() => result.current.updateTask("t_stale", { collaboratorIds: ["u_priya"] }))
    ).toBe(false);
    expect(
      result.current.state.tasks.find((t) => t.id === "t_stale")!.collaboratorIds
    ).toEqual([]);
  });
});
