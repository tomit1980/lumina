// @vitest-environment jsdom
//
// Suite A2 — private channels and restricted projects. Drives
// channelIsViewerOnly / projectIsViewerOnly (internal to lib/store.tsx) via
// the public action API, plus ensureEditor and the members.manage bypass.
//
// Two genuine defects were found while writing this (see
// docs/superpowers/qa/layer1-findings.md, L1-004 and L1-005): updateProject
// only re-checks project-viewer status when the patch touches
// `attachments`, and setProjectAccess doesn't check project-viewer status
// (or even project membership) at all — both are reachable by any custom
// role holding `project.create` without `members.manage`. Those cases are
// encoded below as `it.fails` with the correct (currently failing)
// assertion.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import {
  addChannel,
  addProject,
  addRole,
  addTask,
  addUser,
  asUser,
  baseState,
  mount,
  run,
} from "./_support";
import type { Attachment } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function attachment(id: string, name: string): Attachment {
  return {
    id,
    name,
    size: 10,
    type: "text/plain",
    dataUrl: "data:text/plain;base64,aGVsbG8=",
    uploadedBy: "u_sam",
    uploadedAt: Date.now(),
  };
}

describe("private channels", () => {
  it("a non-member cannot see the channel", async () => {
    const { result } = await mount(asUser(baseState(), "u_maya"));
    const channel = result.current.state.channels.find((c) => c.id === "c_leadership")!;
    expect(result.current.canSeeChannel(channel)).toBe(false);
  });

  it("a non-member cannot post to the channel", async () => {
    const { result } = await mount(asUser(baseState(), "u_maya"));
    const before = result.current.state.messages.length;
    const ok = await run(() => result.current.sendMessage("c_leadership", "sneaking in"));
    expect(ok).toBe(false);
    expect(result.current.state.messages.length).toBe(before);
  });

  it("an invited viewer can see the channel but not post", async () => {
    const state = baseState();
    state.channels = state.channels.map((c) =>
      c.id === "c_leadership"
        ? { ...c, members: [...c.members, { userId: "u_maya", level: "viewer" as const }] }
        : c
    );
    const { result } = await mount(asUser(state, "u_maya"));
    const channel = result.current.state.channels.find((c) => c.id === "c_leadership")!;
    expect(result.current.canSeeChannel(channel)).toBe(true);
    expect(result.current.channelAccessLevel(channel)).toBe("viewer");

    const before = result.current.state.messages.length;
    const ok = await run(() => result.current.sendMessage("c_leadership", "can I post?"));
    expect(ok).toBe(false);
    expect(result.current.state.messages.length).toBe(before);
  });

  it("an invited editor can post", async () => {
    const state = baseState();
    state.channels = state.channels.map((c) =>
      c.id === "c_leadership"
        ? { ...c, members: [...c.members, { userId: "u_maya", level: "editor" as const }] }
        : c
    );
    const { result } = await mount(asUser(state, "u_maya"));
    const channel = result.current.state.channels.find((c) => c.id === "c_leadership")!;
    expect(result.current.channelAccessLevel(channel)).toBe("editor");

    const before = result.current.state.messages.length;
    const ok = await run(() => result.current.sendMessage("c_leadership", "posting as editor"));
    expect(ok).toBe(true);
    expect(result.current.state.messages.length).toBe(before + 1);
  });

  it("an admin with members.manage bypasses both the visibility and write gates despite not being a member", async () => {
    const state = addChannel(baseState(), {
      id: "c_secret",
      name: "secret",
      createdBy: "u_priya",
      isPrivate: true,
      members: [{ userId: "u_priya", level: "editor" }],
    });
    const { result } = await mount(asUser(state, "u_vlad")); // admin, not a member of c_secret
    const channel = result.current.state.channels.find((c) => c.id === "c_secret")!;
    expect(result.current.canSeeChannel(channel)).toBe(true);
    expect(result.current.channelAccessLevel(channel)).toBe("editor");

    const ok = await run(() => result.current.sendMessage("c_secret", "admin override"));
    expect(ok).toBe(true);
  });

  it("ensureEditor re-inserts the creator into setChannelAccess even when the submitted list omits them", async () => {
    // u_sam (member role) is the creator of a fresh channel, which is enough
    // to manage its own access under channelIsManageable even without
    // channel.delete.
    const state = addChannel(baseState(), { id: "c_owned", name: "owned", createdBy: "u_sam" });
    const { result } = await mount(asUser(state, "u_sam"));
    const ok = await run(() =>
      result.current.setChannelAccess("c_owned", {
        isPrivate: true,
        members: [{ userId: "u_maya", level: "viewer" }], // creator omitted
      })
    );
    expect(ok).toBe(true);
    const channel = result.current.state.channels.find((c) => c.id === "c_owned")!;
    expect(channel.members.find((m) => m.userId === "u_sam")).toEqual({
      userId: "u_sam",
      level: "editor",
    });
  });
});

describe("restricted projects", () => {
  function restrictedProject(viewerId: string) {
    return (state: ReturnType<typeof baseState>) =>
      addProject(state, {
        id: "p_restricted",
        name: "Restricted Project",
        createdBy: "u_sam",
        restricted: true,
        members: [{ userId: viewerId, level: "viewer" }],
      });
  }

  it("a non-member cannot see the project", async () => {
    const state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "viewer" }],
    });
    const { result } = await mount(asUser(state, "u_jonas")); // not in the members list
    const project = result.current.state.projects.find((p) => p.id === "p_restricted")!;
    expect(result.current.canSeeProject(project)).toBe(false);
  });

  it("a non-member cannot create tasks in the project", async () => {
    const state = addProject(baseState(), {
      id: "p_restricted",
      name: "Restricted Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "viewer" }],
    });
    const { result } = await mount(asUser(state, "u_jonas")); // member role, has task.create, not a project member
    const before = result.current.state.tasks.length;
    const task = await run(() =>
      result.current.createTask({
        projectId: "p_restricted",
        title: "Sneaky task",
        description: "",
        status: "todo",
        priority: "medium",
        assigneeId: null,
        dueDate: null,
        startTime: null,
        durationMinutes: null,
        reminderMinutes: null,
        labels: [],
        attachments: [],
      })
    );
    expect(task).toBeNull();
    expect(result.current.state.tasks.length).toBe(before);
  });

  it("an invited viewer can see the project but createTask/updateTask/moveTask are denied", async () => {
    const state = addTask(
      restrictedProject("u_maya")(baseState()),
      { id: "t_r1", projectId: "p_restricted", title: "Existing", createdBy: "u_sam", status: "todo" }
    );
    const { result } = await mount(asUser(state, "u_maya")); // member role: has task.create/edit/move
    const project = result.current.state.projects.find((p) => p.id === "p_restricted")!;
    expect(result.current.canSeeProject(project)).toBe(true);
    expect(result.current.projectAccessLevel(project)).toBe("viewer");

    const beforeCount = result.current.state.tasks.length;
    const created = await run(() =>
      result.current.createTask({
        projectId: "p_restricted",
        title: "Viewer task",
        description: "",
        status: "todo",
        priority: "medium",
        assigneeId: null,
        dueDate: null,
        startTime: null,
        durationMinutes: null,
        reminderMinutes: null,
        labels: [],
        attachments: [],
      })
    );
    expect(created).toBeNull();
    expect(result.current.state.tasks.length).toBe(beforeCount);

    await run(() => result.current.updateTask("t_r1", { title: "Edited by viewer" }));
    expect(result.current.state.tasks.find((t) => t.id === "t_r1")?.title).toBe("Existing");

    await run(() => result.current.moveTask("t_r1", "in-progress", 0));
    expect(result.current.state.tasks.find((t) => t.id === "t_r1")?.status).toBe("todo");
  });

  it("an invited editor can createTask/updateTask/moveTask", async () => {
    const editorProjectState = (() => {
      const s = restrictedProject("u_maya")(baseState());
      s.projects = s.projects.map((p) =>
        p.id === "p_restricted"
          ? { ...p, members: [{ userId: "u_maya", level: "editor" as const }] }
          : p
      );
      return s;
    })();
    const state = addTask(editorProjectState, {
      id: "t_r2",
      projectId: "p_restricted",
      title: "Existing",
      createdBy: "u_sam",
      status: "todo",
    });
    const { result } = await mount(asUser(state, "u_maya"));
    const project = result.current.state.projects.find((p) => p.id === "p_restricted")!;
    expect(result.current.projectAccessLevel(project)).toBe("editor");

    const created = await run(() =>
      result.current.createTask({
        projectId: "p_restricted",
        title: "Editor task",
        description: "",
        status: "todo",
        priority: "medium",
        assigneeId: null,
        dueDate: null,
        startTime: null,
        durationMinutes: null,
        reminderMinutes: null,
        labels: [],
        attachments: [],
      })
    );
    expect(created).not.toBeNull();

    await run(() => result.current.updateTask("t_r2", { title: "Edited by editor" }));
    expect(result.current.state.tasks.find((t) => t.id === "t_r2")?.title).toBe("Edited by editor");

    await run(() => result.current.moveTask("t_r2", "in-progress", 0));
    expect(result.current.state.tasks.find((t) => t.id === "t_r2")?.status).toBe("in-progress");
  });

  it("an admin with members.manage bypasses project-viewer restrictions despite not being a member", async () => {
    const state = addProject(baseState(), {
      id: "p_admin_bypass",
      name: "Not admin's project",
      createdBy: "u_priya",
      restricted: true,
      members: [{ userId: "u_priya", level: "editor" }],
    });
    const { result } = await mount(asUser(state, "u_vlad"));
    const project = result.current.state.projects.find((p) => p.id === "p_admin_bypass")!;
    expect(result.current.canSeeProject(project)).toBe(true);
    expect(result.current.projectAccessLevel(project)).toBe("editor");

    const task = await run(() =>
      result.current.createTask({
        projectId: "p_admin_bypass",
        title: "Admin task",
        description: "",
        status: "todo",
        priority: "medium",
        assigneeId: null,
        dueDate: null,
        startTime: null,
        durationMinutes: null,
        reminderMinutes: null,
        labels: [],
        attachments: [],
      })
    );
    expect(task).not.toBeNull();
  });

  it("ensureEditor re-inserts the creator into setProjectAccess even when the submitted list omits them", async () => {
    const state = addProject(baseState(), {
      id: "p_owned",
      name: "Owned Project",
      createdBy: "u_sam",
    });
    const { result } = await mount(asUser(state, "u_vlad")); // needs project.create; only admin has it here
    const ok = await run(() =>
      result.current.setProjectAccess("p_owned", {
        restricted: true,
        members: [{ userId: "u_maya", level: "viewer" }], // creator (u_sam) omitted
      })
    );
    expect(ok).toBe(true);
    const project = result.current.state.projects.find((p) => p.id === "p_owned")!;
    expect(project.members.find((m) => m.userId === "u_sam")).toEqual({
      userId: "u_sam",
      level: "editor",
    });
  });

  it("deleteTask's project-viewer gate blocks a task.delete-only role that is merely a viewer, and admits it once promoted to editor", async () => {
    // Isolate projectIsViewerOnly from the members.manage bypass: this role
    // has task.delete but NOT members.manage, so it's the pure viewer/editor
    // distinction being tested, not the admin bypass.
    let state = addRole(baseState(), {
      id: "r_deleter",
      name: "Deleter",
      permissions: ["task.delete"],
    });
    state = addUser(state, { id: "u_deleter", roleId: "r_deleter" });
    state = addProject(state, {
      id: "p_del_gate",
      name: "Delete-gated Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_deleter", level: "viewer" }],
    });
    state = addTask(state, {
      id: "t_del_gate",
      projectId: "p_del_gate",
      title: "Guarded task",
      createdBy: "u_sam",
    });

    const { result } = await mount(asUser(state, "u_deleter"));
    await run(() => result.current.deleteTask("t_del_gate"));
    expect(result.current.state.tasks.some((t) => t.id === "t_del_gate")).toBe(true); // viewer: denied

    // Promote to editor (as the admin — u_deleter's own role lacks
    // project.create so it can't do this itself) and retry as u_deleter.
    await run(() => result.current.switchUser("u_vlad"));
    await run(() =>
      result.current.setProjectAccess("p_del_gate", {
        restricted: true,
        members: [{ userId: "u_deleter", level: "editor" }],
      })
    );
    await run(() => result.current.switchUser("u_deleter"));
    await run(() => result.current.deleteTask("t_del_gate"));
    expect(result.current.state.tasks.some((t) => t.id === "t_del_gate")).toBe(false); // editor: allowed
  });

  it("updateProject's project-viewer gate correctly blocks an attachments-only patch from a viewer", async () => {
    let state = addRole(baseState(), {
      id: "r_pm",
      name: "Project Manager (no members.manage)",
      permissions: ["project.create"],
    });
    state = addUser(state, { id: "u_pm", roleId: "r_pm" });
    state = addProject(state, {
      id: "p_att_gate",
      name: "Attachment-gated Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_pm", level: "viewer" }],
      attachments: [attachment("att1", "spec.txt")],
    });

    const { result } = await mount(asUser(state, "u_pm"));
    await run(() =>
      result.current.updateProject("p_att_gate", {
        attachments: [attachment("att1", "spec.txt"), attachment("att2", "new-file.txt")],
      })
    );
    expect(result.current.state.projects.find((p) => p.id === "p_att_gate")?.attachments).toHaveLength(1);
  });

  // --- Findings: incomplete / missing viewer-only enforcement -------------

  // L1-004 (High): updateProject only re-checks projectIsViewerOnly when the
  // patch includes `attachments`. A custom role holding only `project.create`
  // (no members.manage) that is merely a *viewer* on a restricted project can
  // rename/recolor/reprioritize that project freely — the viewer gate never
  // runs because `patch.attachments` is undefined. Expected: denied and
  // unchanged, like the attachments case above. Actual: the rename succeeds.
  it(
    "L1-004: updateProject should deny a non-attachments patch from a project viewer, but does not",
    async () => {
      let state = addRole(baseState(), {
        id: "r_pm2",
        name: "Project Manager (no members.manage)",
        permissions: ["project.create"],
      });
      state = addUser(state, { id: "u_pm2", roleId: "r_pm2" });
      state = addProject(state, {
        id: "p_name_gate",
        name: "Original Name",
        createdBy: "u_sam",
        restricted: true,
        members: [{ userId: "u_pm2", level: "viewer" }],
      });

      const { result } = await mount(asUser(state, "u_pm2"));
      await run(() => result.current.updateProject("p_name_gate", { name: "Renamed By Viewer" }));
      expect(result.current.state.projects.find((p) => p.id === "p_name_gate")?.name).toBe(
        "Original Name"
      );
    }
  );

  // L1-005 (Critical): setProjectAccess is gated solely by `project.create`
  // with no projectIsViewerOnly check and no membership check at all. A
  // custom role holding only `project.create` can rewrite the access list —
  // including granting itself "editor" — of ANY restricted project, even one
  // it has no relationship to whatsoever. Expected: denied (not a member /
  // not an editor of this project). Actual: succeeds unconditionally.
  it(
    "L1-005: setProjectAccess should deny a caller with no relationship to the target project, but does not",
    async () => {
      let state = addRole(baseState(), {
        id: "r_pm3",
        name: "Project Manager (no members.manage)",
        permissions: ["project.create"],
      });
      state = addUser(state, { id: "u_pm3", roleId: "r_pm3" });
      state = addProject(state, {
        id: "p_unrelated",
        name: "Unrelated Project",
        createdBy: "u_sam",
        restricted: true,
        members: [{ userId: "u_priya", level: "editor" }], // u_pm3 has no membership here at all
      });

      const { result } = await mount(asUser(state, "u_pm3"));
      const ok = await run(() =>
        result.current.setProjectAccess("p_unrelated", {
          restricted: true,
          members: [{ userId: "u_pm3", level: "editor" }], // self-promotion attempt
        })
      );
      expect(ok).toBe(false);
      const project = result.current.state.projects.find((p) => p.id === "p_unrelated")!;
      expect(project.members.some((m) => m.userId === "u_pm3")).toBe(false);
    }
  );
});

describe("message-level guards — by design, but surprising (see findings doc)", () => {
  it("editMessage checks authorship only, never message.send — a zero-permission author can still edit their own message", async () => {
    let state = addRole(baseState(), { id: "r_none", name: "No Perms", permissions: [] });
    state = addUser(state, { id: "u_none", roleId: "r_none" });
    state.messages = [
      ...state.messages,
      {
        id: "m_by_none",
        channelId: "c_engineering",
        authorId: "u_none",
        content: "original",
        createdAt: Date.now(),
        reactions: [],
        attachments: [],
      },
    ];
    const { result } = await mount(asUser(state, "u_none"));
    expect(result.current.can("message.send")).toBe(false);

    await run(() => result.current.editMessage("m_by_none", "edited"));
    expect(result.current.state.messages.find((m) => m.id === "m_by_none")?.content).toBe("edited");
  });

  it("toggleReaction is gated only by conversation visibility, not by any permission", async () => {
    let state = addRole(baseState(), { id: "r_none2", name: "No Perms 2", permissions: [] });
    state = addUser(state, { id: "u_none2", roleId: "r_none2" });
    const { result } = await mount(asUser(state, "u_none2"));
    expect(result.current.can("message.send")).toBe(false);

    const target = result.current.state.messages.find((m) => m.channelId === "c_engineering")!;
    await run(() => result.current.toggleReaction(target.id, "👍"));
    const reacted = result.current.state.messages.find((m) => m.id === target.id)!;
    expect(reacted.reactions.find((r) => r.emoji === "👍")?.userIds).toContain("u_none2");
  });

  it("sendMessage to a DM bypasses the message.send guard entirely", async () => {
    let state = addRole(baseState(), { id: "r_none3", name: "No Perms 3", permissions: [] });
    state = addUser(state, { id: "u_none3", roleId: "r_none3" });
    const { result } = await mount(asUser(state, "u_none3"));
    expect(result.current.can("message.send")).toBe(false);

    const dm = await run(() => result.current.sendToUser("u_vlad", "hi from a zero-permission user"));
    expect(dm).not.toBeNull();
    expect(
      result.current.state.messages.some((m) => m.content === "hi from a zero-permission user")
    ).toBe(true);
  });
});
