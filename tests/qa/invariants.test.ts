// @vitest-environment jsdom
//
// Suite A3 — business-rule invariants layered on top of the raw permission
// check in lib/store.tsx: self-role-change, last-admin protection, locked
// roles, system roles, role-with-members, the team channel, case-insensitive
// role name clashes, and the #general migration backfill.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import {
  addChannel,
  addRole,
  addUser,
  asUser,
  baseState,
  mount,
  mountFromExistingStorage,
  run,
  STORAGE_KEY,
} from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("you cannot change your own role", () => {
  it("admin cannot set their own role, even to another admin-equivalent", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const ok = run(() => result.current.setUserRole("u_vlad", "member"));
    expect(ok).toBe(false);
    expect(result.current.state.users.find((u) => u.id === "u_vlad")?.roleId).toBe("admin");
  });
});

describe("you cannot demote the last admin", () => {
  it("a members.manage-holding non-admin cannot demote the sole admin", () => {
    let state = addRole(baseState(), {
      id: "r_ops",
      name: "Ops",
      permissions: ["members.manage"],
    });
    state = addUser(state, { id: "u_ops", roleId: "r_ops" });
    const { result } = mount(asUser(state, "u_ops"));

    const ok = run(() => result.current.setUserRole("u_vlad", "member"));
    expect(ok).toBe(false);
    expect(result.current.state.users.find((u) => u.id === "u_vlad")?.roleId).toBe("admin");
  });

  it("demoting one of two admins is allowed", () => {
    const state = addUser(baseState(), { id: "u_admin2", roleId: "admin" });
    const { result } = mount(asUser(state, "u_vlad"));

    const ok = run(() => result.current.setUserRole("u_admin2", "member"));
    expect(ok).toBe(true);
    expect(result.current.state.users.find((u) => u.id === "u_admin2")?.roleId).toBe("member");
  });
});

describe("locked role (admin)", () => {
  it("cannot be renamed via updateRole", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const ok = run(() => result.current.updateRole("admin", { name: "SuperAdmin" }));
    expect(ok).toBe(false);
    expect(result.current.state.roles.find((r) => r.id === "admin")?.name).toBe("Admin");
  });

  it("cannot have a permission toggled via setRolePermission", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const before = result.current.state.roles.find((r) => r.id === "admin")?.permissions.length;
    const ok = run(() => result.current.setRolePermission("admin", "task.delete", false));
    expect(ok).toBe(false);
    expect(result.current.state.roles.find((r) => r.id === "admin")?.permissions.length).toBe(
      before
    );
    // roleHas() treats `locked` as always-true regardless of the listed
    // permissions, so even if this *had* gone through, admin would still
    // behave as fully permitted.
    expect(result.current.can("task.delete", result.current.currentUser)).toBe(true);
  });
});

describe("system role", () => {
  it("cannot be deleted even with zero members assigned", () => {
    // Reassign u_elena off "guest" first so this isolates the isSystem
    // check from the separate has-members check tested below.
    const state = baseState();
    state.users = state.users.map((u) => (u.id === "u_elena" ? { ...u, roleId: "member" } : u));
    const { result } = mount(asUser(state, "u_vlad"));
    expect(result.current.state.users.some((u) => u.roleId === "guest")).toBe(false);

    const ok = run(() => result.current.deleteRole("guest"));
    expect(ok).toBe(false);
    expect(result.current.state.roles.some((r) => r.id === "guest")).toBe(true);
  });
});

describe("a role with members assigned", () => {
  it("cannot be deleted even though it's a custom (non-system) role", () => {
    let state = addRole(baseState(), { id: "r_custom", name: "Custom", permissions: [] });
    state = addUser(state, { id: "u_custom_member", roleId: "r_custom" });
    const { result } = mount(asUser(state, "u_vlad"));

    const ok = run(() => result.current.deleteRole("r_custom"));
    expect(ok).toBe(false);
    expect(result.current.state.roles.some((r) => r.id === "r_custom")).toBe(true);
  });

  it("can be deleted once its members are reassigned", () => {
    let state = addRole(baseState(), { id: "r_custom2", name: "Custom2", permissions: [] });
    state = addUser(state, { id: "u_custom_member2", roleId: "r_custom2" });
    const { result } = mount(asUser(state, "u_vlad"));

    run(() => result.current.setUserRole("u_custom_member2", "member"));
    const ok = run(() => result.current.deleteRole("r_custom2"));
    expect(ok).toBe(true);
    expect(result.current.state.roles.some((r) => r.id === "r_custom2")).toBe(false);
  });
});

describe("role name clashes are case-insensitive", () => {
  it("on create", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const before = result.current.state.roles.length;
    const role = run(() =>
      result.current.createRole({ name: "MEMBER", description: "", color: "#000", permissions: [] })
    );
    expect(role).toBeNull();
    expect(result.current.state.roles.length).toBe(before);
  });

  it("on update", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const ok = run(() => result.current.updateRole("guest", { name: "member" }));
    expect(ok).toBe(false);
    expect(result.current.state.roles.find((r) => r.id === "guest")?.name).toBe("Guest");
  });

  it("updating a role to its own current name (same id) is not a clash", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const ok = run(() => result.current.updateRole("guest", { name: "Guest" }));
    expect(ok).toBe(true);
  });
});

describe("the team channel", () => {
  it("cannot be deleted, even by an admin", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const channel = result.current.state.channels.find((c) => c.id === "c_general")!;
    expect(result.current.canDeleteChannel(channel)).toBe(false);

    run(() => result.current.deleteChannel("c_general"));
    expect(result.current.state.channels.some((c) => c.id === "c_general")).toBe(true);
  });
});

describe("#general is protected even in legacy (pre-isTeam) data", () => {
  it("migrate() backfills isTeam for a channel literally named 'general' that lacks the flag", () => {
    const raw = baseState() as unknown as Record<string, unknown>;
    raw.version = 1; // genuinely predates SEED_VERSION, so migrate() sees legacy data
    const channels = raw.channels as Array<Record<string, unknown>>;
    const general = channels.find((c) => c.id === "c_general")!;
    delete general.isTeam; // simulate data written before isTeam existed
    expect(general.name).toBe("general");

    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    const { result } = mountFromExistingStorage();

    const channel = result.current.state.channels.find((c) => c.id === "c_general")!;
    expect(channel.isTeam).toBe(true);
    expect(result.current.canDeleteChannel(channel)).toBe(false);

    run(() => result.current.deleteChannel("c_general"));
    expect(result.current.state.channels.some((c) => c.id === "c_general")).toBe(true);
  });

  it("a *different* channel named general (not the seeded id) still gets backfilled by name alone", () => {
    const state = addChannel(baseState(), {
      id: "c_general_2",
      name: "general",
      createdBy: "u_priya",
      isPrivate: false,
    });
    const raw = state as unknown as Record<string, unknown>;
    raw.version = 1; // genuinely predates SEED_VERSION, so migrate() sees legacy data
    const channels = raw.channels as Array<Record<string, unknown>>;
    const dup = channels.find((c) => c.id === "c_general_2")!;
    delete dup.isTeam;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    const { result } = mountFromExistingStorage();
    const channel = result.current.state.channels.find((c) => c.id === "c_general_2")!;
    // By design, but surprising: the backfill matches on the *name* "general"
    // alone, not on being the original team channel — see
    // docs/superpowers/qa/layer1-findings.md.
    expect(channel.isTeam).toBe(true);
  });

  // L1-006 (Medium/High): migrate() runs on *every* load, not just genuinely
  // legacy data (the version gate accepts parsed.version === SEED_VERSION).
  // So a brand-new, ordinarily-created channel named "general" has
  // `isTeam: undefined` in memory, gets persisted, and on the very next
  // reload the name-based backfill (`c.name === "general" ? true : ...`)
  // silently turns it into an undeletable pseudo-team channel — with no
  // rename action available to escape it. Expected: a plain user-created
  // "general" channel stays deletable after a reload. Actual: it doesn't.
  it(
    "L1-006: a newly created channel named 'general' should stay deletable after a reload, but does not",
    () => {
      const { result, unmount } = mount(asUser(baseState(), "u_vlad"));
      const created = run(() =>
        result.current.createChannel({ name: "general", description: "", isPrivate: false })
      );
      expect(created).not.toBeNull();
      unmount();

      // Simulate a reload from whatever the persistence effect just wrote.
      const { result: reloaded } = mountFromExistingStorage();
      const dup = reloaded.current.state.channels.find((c) => c.id === created!.id)!;
      expect(dup.isTeam).toBeFalsy();
      expect(reloaded.current.canDeleteChannel(dup)).toBe(true);
    }
  );
});
