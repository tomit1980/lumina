// @vitest-environment jsdom
//
// Suite A1 — RBAC matrix. Drives every guarded lib/store.tsx action as each
// of the three seeded roles (admin/member/guest) and asserts both the
// allowed and denied outcome as a state diff, not just a return value —
// several actions (updateProject, deleteProject, updateTask, moveTask,
// deleteTask, deleteChannel) return void even on denial, so the return
// value alone can't prove anything was blocked.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import {
  addChannel,
  addProject,
  addRole,
  addTask,
  asUser,
  baseState,
  mount,
  run,
} from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type ActorKey = "admin" | "member" | "guest";
const ACTOR_ID: Record<ActorKey, string> = {
  admin: "u_vlad",
  member: "u_maya",
  guest: "u_elena",
};
const ROLES: ActorKey[] = ["admin", "member", "guest"];

function setupStore(actor: ActorKey, mutate: (s: ReturnType<typeof baseState>) => ReturnType<typeof baseState>) {
  const state = asUser(mutate(baseState()), ACTOR_ID[actor]);
  return mount(state);
}

describe("RBAC matrix", () => {
  // ---- setUserRole (members.manage) ------------------------------------
  describe("setUserRole", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) => s);
        const ok = await run(() => result.current.setUserRole("u_jonas", "guest"));
        const jonas = result.current.state.users.find((u) => u.id === "u_jonas");
        if (expected[actor]) {
          expect(ok).toBe(true);
          expect(jonas?.roleId).toBe("guest");
        } else {
          expect(ok).toBe(false);
          expect(jonas?.roleId).toBe("member");
        }
      });
    }
  });

  // ---- createRole (members.manage) --------------------------------------
  describe("createRole", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) => s);
        const before = result.current.state.roles.length;
        const role = await run(() =>
          result.current.createRole({
            name: "Ops Test Role",
            description: "",
            color: "#123456",
            permissions: [],
          })
        );
        if (expected[actor]) {
          expect(role).not.toBeNull();
          expect(result.current.state.roles.length).toBe(before + 1);
        } else {
          expect(role).toBeNull();
          expect(result.current.state.roles.length).toBe(before);
        }
      });
    }
  });

  // ---- updateRole (members.manage) --------------------------------------
  describe("updateRole", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) => s);
        const ok = await run(() => result.current.updateRole("guest", { name: "Guest Renamed" }));
        const guestRole = result.current.state.roles.find((r) => r.id === "guest");
        if (expected[actor]) {
          expect(ok).toBe(true);
          expect(guestRole?.name).toBe("Guest Renamed");
        } else {
          expect(ok).toBe(false);
          expect(guestRole?.name).toBe("Guest");
        }
      });
    }
  });

  // ---- setRolePermission (members.manage) --------------------------------
  describe("setRolePermission", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) => s);
        const ok = await run(() => result.current.setRolePermission("guest", "task.create", true));
        const guestRole = result.current.state.roles.find((r) => r.id === "guest");
        if (expected[actor]) {
          expect(ok).toBe(true);
          expect(guestRole?.permissions).toContain("task.create");
        } else {
          expect(ok).toBe(false);
          expect(guestRole?.permissions).not.toContain("task.create");
        }
      });
    }
  });

  // ---- deleteRole (members.manage, + isSystem/locked/has-members rules) -
  describe("deleteRole", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addRole(s, { id: "r_temp", name: "Temp Role", permissions: [] })
        );
        const ok = await run(() => result.current.deleteRole("r_temp"));
        const stillThere = result.current.state.roles.some((r) => r.id === "r_temp");
        if (expected[actor]) {
          expect(ok).toBe(true);
          expect(stillThere).toBe(false);
        } else {
          expect(ok).toBe(false);
          expect(stillThere).toBe(true);
        }
      });
    }
  });

  // ---- sendMessage (message.send) — all three seeded roles have it ------
  describe("sendMessage", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: true, guest: true };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) => s);
        const before = result.current.state.messages.length;
        const ok = await run(() => result.current.sendMessage("c_engineering", `hi from ${actor}`));
        if (expected[actor]) {
          expect(ok).toBe(true);
          expect(result.current.state.messages.length).toBe(before + 1);
        } else {
          expect(ok).toBe(false);
          expect(result.current.state.messages.length).toBe(before);
        }
      });
    }
  });

  // ---- createChannel (channel.create) ------------------------------------
  describe("createChannel", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: true, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) => s);
        const before = result.current.state.channels.length;
        const channel = await run(() =>
          result.current.createChannel({ name: "temp-channel", description: "", isPrivate: false })
        );
        if (expected[actor]) {
          expect(channel).not.toBeNull();
          expect(result.current.state.channels.length).toBe(before + 1);
        } else {
          expect(channel).toBeNull();
          expect(result.current.state.channels.length).toBe(before);
        }
      });
    }
  });

  // ---- deleteChannel (channel.delete, or creator — channel here is
  //      created by a neutral 4th user so only the permission is tested) --
  describe("deleteChannel", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addChannel(s, { id: "c_temp", name: "temp", createdBy: "u_priya" })
        );
        await run(() => result.current.deleteChannel("c_temp"));
        const stillThere = result.current.state.channels.some((c) => c.id === "c_temp");
        if (expected[actor]) {
          expect(stillThere).toBe(false);
        } else {
          expect(stillThere).toBe(true);
        }
      });
    }
  });

  // ---- setChannelAccess (same bar as deleteChannel: channel.delete or
  //      creator; channel again owned by a neutral 4th user) ---------------
  describe("setChannelAccess", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addChannel(s, { id: "c_temp2", name: "temp2", createdBy: "u_priya" })
        );
        const ok = await run(() =>
          result.current.setChannelAccess("c_temp2", {
            isPrivate: true,
            members: [{ userId: "u_jonas", level: "viewer" }],
          })
        );
        const channel = result.current.state.channels.find((c) => c.id === "c_temp2");
        if (expected[actor]) {
          expect(ok).toBe(true);
          expect(channel?.isPrivate).toBe(true);
        } else {
          expect(ok).toBe(false);
          expect(channel?.isPrivate).toBe(false);
        }
      });
    }
  });

  // ---- createProject (project.create) — member notably lacks this -------
  describe("createProject", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) => s);
        const before = result.current.state.projects.length;
        const project = await run(() =>
          result.current.createProject({
            name: "Temp Project",
            description: "",
            emoji: "🧪",
            color: "#000000",
            priority: "medium",
          })
        );
        if (expected[actor]) {
          expect(project).not.toBeNull();
          expect(result.current.state.projects.length).toBe(before + 1);
        } else {
          expect(project).toBeNull();
          expect(result.current.state.projects.length).toBe(before);
        }
      });
    }
  });

  // ---- updateProject (reuses project.create — see findings) --------------
  describe("updateProject", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addProject(s, { id: "p_temp", name: "Temp Project", createdBy: "u_priya" })
        );
        await run(() => result.current.updateProject("p_temp", { name: "Renamed Project" }));
        const project = result.current.state.projects.find((p) => p.id === "p_temp");
        if (expected[actor]) {
          expect(project?.name).toBe("Renamed Project");
        } else {
          expect(project?.name).toBe("Temp Project");
        }
      });
    }
  });

  // ---- deleteProject (project.delete) ------------------------------------
  describe("deleteProject", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addProject(s, { id: "p_temp2", name: "Temp Project 2", createdBy: "u_priya" })
        );
        await run(() => result.current.deleteProject("p_temp2"));
        const stillThere = result.current.state.projects.some((p) => p.id === "p_temp2");
        if (expected[actor]) {
          expect(stillThere).toBe(false);
        } else {
          expect(stillThere).toBe(true);
        }
      });
    }
  });

  // ---- setProjectAccess (reuses project.create — see findings) -----------
  describe("setProjectAccess", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addProject(s, { id: "p_temp3", name: "Temp Project 3", createdBy: "u_priya" })
        );
        const ok = await run(() =>
          result.current.setProjectAccess("p_temp3", {
            restricted: true,
            members: [{ userId: "u_jonas", level: "viewer" }],
          })
        );
        const project = result.current.state.projects.find((p) => p.id === "p_temp3");
        if (expected[actor]) {
          expect(ok).toBe(true);
          expect(project?.restricted).toBe(true);
        } else {
          expect(ok).toBe(false);
          expect(project?.restricted).toBe(false);
        }
      });
    }
  });

  // ---- createTask (task.create) ------------------------------------------
  describe("createTask", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: true, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) => s);
        const before = result.current.state.tasks.length;
        const task = await run(() =>
          result.current.createTask({
            projectId: "p_website",
            title: "Temp Task",
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
        if (expected[actor]) {
          expect(task).not.toBeNull();
          expect(result.current.state.tasks.length).toBe(before + 1);
        } else {
          expect(task).toBeNull();
          expect(result.current.state.tasks.length).toBe(before);
        }
      });
    }
  });

  // ---- updateTask (task.edit) --------------------------------------------
  describe("updateTask", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: true, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addTask(s, { id: "t_temp_upd", projectId: "p_website", title: "Original", createdBy: "u_priya" })
        );
        await run(() => result.current.updateTask("t_temp_upd", { title: "Updated" }));
        const task = result.current.state.tasks.find((t) => t.id === "t_temp_upd");
        if (expected[actor]) {
          expect(task?.title).toBe("Updated");
        } else {
          expect(task?.title).toBe("Original");
        }
      });
    }
  });

  // ---- moveTask (task.move) ------------------------------------------------
  describe("moveTask", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: true, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addTask(s, {
            id: "t_temp_mov",
            projectId: "p_website",
            title: "Movable",
            createdBy: "u_priya",
            status: "todo",
          })
        );
        await run(() => result.current.moveTask("t_temp_mov", "in-progress", 0));
        const task = result.current.state.tasks.find((t) => t.id === "t_temp_mov");
        if (expected[actor]) {
          expect(task?.status).toBe("in-progress");
        } else {
          expect(task?.status).toBe("todo");
        }
      });
    }
  });

  // ---- deleteTask (task.delete) — member notably lacks this --------------
  describe("deleteTask", () => {
    const expected: Record<ActorKey, boolean> = { admin: true, member: false, guest: false };
    for (const actor of ROLES) {
      it(`${actor} → ${expected[actor] ? "allowed" : "denied"}`, async () => {
        const { result } = setupStore(actor, (s) =>
          addTask(s, { id: "t_temp_del", projectId: "p_website", title: "Deletable", createdBy: "u_priya" })
        );
        await run(() => result.current.deleteTask("t_temp_del"));
        const stillThere = result.current.state.tasks.some((t) => t.id === "t_temp_del");
        if (expected[actor]) {
          expect(stillThere).toBe(false);
        } else {
          expect(stillThere).toBe(true);
        }
      });
    }
  });
});
