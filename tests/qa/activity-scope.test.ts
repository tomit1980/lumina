// @vitest-environment jsdom
//
// Suite — the scope every activity(...) call site attaches
// (20260909000900_activity_scope.sql, lib/store.tsx).
//
// activities_read filters the feed on `project_id` / `conversation_id`. Those
// columns are only as good as the values the store writes: a channel event
// that forgot its conversation, or a project event that forgot its project,
// becomes a workspace-wide row and lands back in every browser — QA-001 all
// over again, minus the policy to blame. So every call site gets a case here,
// asserting BOTH halves (the right id present, and the other column null)
// rather than just "something was set".
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import {
  addChannel, addProject, addTask, addUser, asUser, baseState, mount, run,
} from "./_support";
import type { AppState } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** The row the action under test just appended. */
const last = (state: AppState) => state.activities.at(-1)!;

/** An admin (u_vlad in the seed) plus a project and a channel to act on. */
function workspace(): AppState {
  let state = baseState();
  state = addProject(state, { id: "p_scope", name: "Scope", createdBy: "u_vlad" });
  state = addTask(state, {
    id: "t_scope", projectId: "p_scope", title: "Scoped task", createdBy: "u_vlad",
  });
  state = addChannel(state, { id: "c_scope", name: "scope", createdBy: "u_vlad" });
  return asUser(state, "u_vlad");
}

describe("workspace-wide events name nothing", () => {
  // A role or membership change is about a person, not a resource — there is
  // no name to hide, and hiding it would break the one feed everyone shares.
  it("setUserRole", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.setUserRole("u_maya", "guest"));
    const a = last(result.current.state);
    expect(a.kind).toBe("member");
    expect(a.projectId).toBeNull();
    expect(a.conversationId).toBeNull();
  });

  it("createRole", async () => {
    const { result } = await mount(workspace());
    await run(() =>
      result.current.createRole({ name: "Auditor", description: "", color: "#000", permissions: [] })
    );
    const a = last(result.current.state);
    expect(a.text).toContain("Auditor");
    expect(a.projectId).toBeNull();
    expect(a.conversationId).toBeNull();
  });

  it("setRolePermission", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.setRolePermission("member", "project.create", true));
    const a = last(result.current.state);
    expect(a.kind).toBe("member");
    expect(a.projectId).toBeNull();
    expect(a.conversationId).toBeNull();
  });

  it("deleteRole", async () => {
    const { result } = await mount(workspace());
    const created = await run(() =>
      result.current.createRole({ name: "Temp", description: "", color: "#000", permissions: [] })
    );
    await run(() => result.current.deleteRole(created!.id));
    const a = last(result.current.state);
    expect(a.text).toContain("deleted the Temp role");
    expect(a.projectId).toBeNull();
    expect(a.conversationId).toBeNull();
  });
});

describe("channel events name their conversation", () => {
  it("createChannel scopes to the new channel", async () => {
    const { result } = await mount(workspace());
    const channel = await run(() =>
      result.current.createChannel({ name: "launch", description: "", isPrivate: true })
    );
    const a = last(result.current.state);
    expect(a.kind).toBe("channel");
    expect(a.conversationId).toBe(channel!.id);
    expect(a.projectId).toBeNull();
  });

  it("setChannelAccess scopes to the channel", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.setChannelAccess("c_scope", { isPrivate: true, members: [] }));
    const a = last(result.current.state);
    expect(a.conversationId).toBe("c_scope");
    expect(a.projectId).toBeNull();
  });

  // The exact row from the bug report: `deleted #board-only` must not be
  // readable by people who were never in #board-only.
  it("deleteChannel scopes to the channel it deleted", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.deleteChannel("c_scope"));
    const a = last(result.current.state);
    expect(a.text).toBe("deleted #scope");
    expect(a.conversationId).toBe("c_scope");
    expect(a.projectId).toBeNull();
  });

  it("sendMessage's file note scopes to the conversation it was posted in", async () => {
    const { result } = await mount(workspace());
    await run(() =>
      result.current.sendMessage("c_scope", "here", [
        { id: "att_1", name: "notes.txt", size: 10, type: "text/plain", dataUrl: "data:,",
          uploadedBy: "u_vlad", uploadedAt: Date.now() },
      ])
    );
    const a = last(result.current.state);
    expect(a.kind).toBe("message");
    expect(a.conversationId).toBe("c_scope");
    expect(a.projectId).toBeNull();
  });
});

describe("project events name their project", () => {
  it("createProject scopes to the new project", async () => {
    const { result } = await mount(workspace());
    const project = await run(() =>
      result.current.createProject({
        name: "Payroll", description: "", emoji: "🔒", color: "#000", priority: "high",
      })
    );
    const a = last(result.current.state);
    expect(a.text).toBe("created the Payroll project");
    expect(a.projectId).toBe(project!.id);
    expect(a.conversationId).toBeNull();
  });

  it("updateProject's rename scopes to the project", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.updateProject("p_scope", { name: "Renamed" }));
    const a = last(result.current.state);
    expect(a.text).toContain("renamed");
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });

  it("updateProject's attachment note scopes to the project", async () => {
    const { result } = await mount(workspace());
    await run(() =>
      result.current.updateProject("p_scope", {
        attachments: [
          { id: "att_p", name: "budget.xlsx", size: 20, type: "text/plain", dataUrl: "data:,",
            uploadedBy: "u_vlad", uploadedAt: Date.now() },
        ],
      })
    );
    const a = last(result.current.state);
    expect(a.text).toContain("attached a file");
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });

  it("setProjectAccess scopes to the project", async () => {
    const { result } = await mount(workspace());
    await run(() =>
      result.current.setProjectAccess("p_scope", { restricted: true, members: [] })
    );
    const a = last(result.current.state);
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });

  it("deleteProject scopes to the project it deleted", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.deleteProject("p_scope"));
    const a = last(result.current.state);
    expect(a.text).toBe("deleted the Scope project");
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });
});

describe("task events name the project that owns the task", () => {
  it("createTask", async () => {
    const { result } = await mount(workspace());
    await run(() =>
      result.current.createTask({
        projectId: "p_scope", title: "Fresh", description: "", status: "todo",
        priority: "medium", assigneeId: null, dueDate: null, startTime: null,
        durationMinutes: null, reminderMinutes: null, labels: [], attachments: [],
      })
    );
    const a = last(result.current.state);
    expect(a.kind).toBe("task");
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });

  it("updateTask's completion note", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.updateTask("t_scope", { status: "done" }));
    const a = last(result.current.state);
    expect(a.text).toBe("completed “Scoped task”");
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });

  it("updateTask's per-person assignment notes", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.updateTask("t_scope", { assigneeId: "u_maya" }));
    const a = last(result.current.state);
    expect(a.text).toContain("assigned");
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });

  // A re-parented task is logged against where it ENDED UP, not where it came
  // from — updateTask scopes on next.projectId. That is the project the task
  // now lives in and whose members may legitimately read its title; scoping to
  // the old project would file the row under a project the task has left.
  //
  // Note the cast. TaskPatch is Partial<Omit<Task, "id" | "projectId">>
  // (lib/backend/types.ts), but that is a compile-time guard only: the store
  // spreads the patch as { ...prev, ...resolved } and does not strip projectId
  // at runtime, so the move really happens. That is exactly why the scope has
  // to be computed from `next` rather than assumed equal to `prev`.
  it("updateTask logs a re-parented task against its NEW project", async () => {
    let state = workspace();
    state = addProject(state, { id: "p_other", name: "Other", createdBy: "u_vlad" });
    const { result } = await mount(state);
    const patch: Record<string, unknown> = { projectId: "p_other", status: "done" };
    await run(() => result.current.updateTask("t_scope", patch as never));

    expect(result.current.state.tasks.find((t) => t.id === "t_scope")!.projectId).toBe("p_other");
    const a = last(result.current.state);
    expect(a.text).toBe("completed “Scoped task”");
    expect(a.projectId).toBe("p_other");
  });

  it("moveTask's completion note", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.moveTask("t_scope", "done", 0));
    const a = last(result.current.state);
    expect(a.text).toBe("completed “Scoped task”");
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });

  it("deleteTask", async () => {
    const { result } = await mount(workspace());
    await run(() => result.current.deleteTask("t_scope"));
    const a = last(result.current.state);
    expect(a.text).toBe("deleted “Scoped task”");
    expect(a.projectId).toBe("p_scope");
    expect(a.conversationId).toBeNull();
  });
});

describe("a restricted resource's activities never come out unscoped", () => {
  // The end-to-end shape of the bug: whatever the text says, if the row names
  // a restricted project the scope must carry that project so the policy can
  // filter it. An unscoped row here is a row the database will hand to
  // everyone.
  it("every activity a restricted project produces carries that project", async () => {
    let state = baseState();
    state = addUser(state, { id: "u_boss", roleId: "admin", name: "Boss" });
    state = addProject(state, {
      id: "p_payroll", name: "Payroll", createdBy: "u_boss", restricted: true,
      members: [{ userId: "u_boss", level: "editor" }],
    });
    state = addTask(state, {
      id: "t_payroll", projectId: "p_payroll", title: "Salary bands", createdBy: "u_boss",
    });
    const { result } = await mount(asUser(state, "u_boss"));

    const before = result.current.state.activities.length;
    await run(() => result.current.updateTask("t_payroll", { status: "done" }));
    await run(() => result.current.updateProject("p_payroll", { name: "Payroll 2027" }));
    await run(() => result.current.deleteTask("t_payroll"));

    const produced = result.current.state.activities.slice(before);
    expect(produced.length).toBeGreaterThanOrEqual(3);
    for (const a of produced) {
      expect(a.projectId).toBe("p_payroll");
      expect(a.conversationId).toBeNull();
    }
  });
});
