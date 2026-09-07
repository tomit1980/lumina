// @vitest-environment jsdom
//
// Suite A6 — migrate() in lib/store.tsx, which runs on *every* load (see
// L1-006 in layer1-findings.md: the version gate accepts parsed.version ===
// SEED_VERSION too, not just genuinely older data). This suite crafts
// representative legacy blobs across the whole accepted version range,
// then drives the failure paths: corrupt JSON, out-of-range versions, and
// blobs missing whole top-level keys.
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";

import { createSeed, SEED_VERSION } from "@/lib/seed";
import { AuthProvider, DEMO_PASSWORD, useAuth } from "@/lib/auth";
import type { AppState } from "@/lib/types";
import { mountFromExistingStorage, STORAGE_KEY } from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** A deliberately old-shaped, pre-migration blob: legacy `role` (not
 *  `roleId`), flat `memberIds` (not per-member `members`), projects/tasks
 *  missing every field added since, an "urgent" task priority, no top-level
 *  `roles` (relying on the legacy `rolePermissions` map instead), and no
 *  `dms`. The `version` field is the only thing that varies per call. */
function legacyBlob(version: number): unknown {
  return {
    version,
    currentUserId: "u_legacy",
    users: [
      {
        id: "u_legacy",
        name: "Legacy User",
        handle: "legacy",
        title: "Engineer",
        role: "member", // legacy field name
        color: "#111111",
        presence: "online",
      },
      {
        id: "u_legacy_admin",
        name: "Legacy Admin",
        handle: "legacyadmin",
        title: "Admin",
        role: "admin",
        color: "#222222",
        presence: "online",
      },
    ],
    channels: [
      {
        id: "c_legacy",
        name: "legacy-channel",
        description: "A pre-migration channel",
        isPrivate: true,
        memberIds: ["u_legacy", "u_legacy_admin"], // legacy flat member list
        createdBy: "u_legacy_admin",
        createdAt: Date.now(),
      },
    ],
    messages: [
      {
        id: "m_legacy",
        channelId: "c_legacy",
        authorId: "u_legacy",
        content: "hello from the past",
        createdAt: Date.now(),
        reactions: [],
        // no `attachments`
      },
    ],
    projects: [
      {
        id: "p_legacy",
        name: "Legacy Project",
        description: "",
        emoji: "🗂️",
        color: "#333333",
        createdBy: "u_legacy_admin",
        createdAt: Date.now(),
        // no priority/restricted/members/attachments
      },
    ],
    tasks: [
      {
        id: "t_legacy",
        projectId: "p_legacy",
        title: "Legacy Task",
        description: "",
        status: "todo",
        priority: "urgent", // dropped tier — should fold into "high"
        assigneeId: null,
        dueDate: null,
        labels: [],
        order: 0,
        createdAt: Date.now(),
        createdBy: "u_legacy",
        // no attachments/startTime/durationMinutes/reminderMinutes
      },
    ],
    activities: [],
    lastRead: {},
    rolePermissions: { member: ["message.send", "task.create"] },
    // no top-level `roles`, no `dms`
  };
}

function assertCoherentShape(state: AppState) {
  for (const u of state.users) {
    expect(typeof u.roleId).toBe("string");
    expect(u.roleId.length).toBeGreaterThan(0);
  }
  for (const c of state.channels) {
    expect(Array.isArray(c.members)).toBe(true);
  }
  for (const p of state.projects) {
    expect(p.priority === "high" || p.priority === "medium" || p.priority === "low").toBe(true);
    expect(typeof p.restricted).toBe("boolean");
    expect(Array.isArray(p.members)).toBe(true);
    expect(Array.isArray(p.attachments)).toBe(true);
  }
  for (const t of state.tasks) {
    expect(Array.isArray(t.attachments)).toBe(true);
    expect(t.startTime === null || typeof t.startTime === "string").toBe(true);
    expect(t.durationMinutes === null || typeof t.durationMinutes === "number").toBe(true);
    expect(t.reminderMinutes === null || typeof t.reminderMinutes === "number").toBe(true);
    expect(["high", "medium", "low"]).toContain(t.priority);
  }
  for (const m of state.messages) {
    expect(Array.isArray(m.attachments)).toBe(true);
  }
}

describe("migrate() across the accepted SEED_VERSION range (1..10)", () => {
  for (let v = 1; v <= SEED_VERSION; v++) {
    it(`a version-${v} legacy blob migrates to a coherent current-shape state`, () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyBlob(v)));
      const { result } = mountFromExistingStorage();

      expect(result.current.state.version).toBe(SEED_VERSION);
      assertCoherentShape(result.current.state);

      // legacy `role` -> `roleId`
      const legacyUser = result.current.state.users.find((u) => u.id === "u_legacy")!;
      expect(legacyUser.roleId).toBe("member");
      const legacyAdmin = result.current.state.users.find((u) => u.id === "u_legacy_admin")!;
      expect(legacyAdmin.roleId).toBe("admin");

      // legacy `memberIds` -> `members` (ResourceMember[]), defaulted to editor
      const legacyChannel = result.current.state.channels.find((c) => c.id === "c_legacy")!;
      expect(legacyChannel.members).toEqual(
        expect.arrayContaining([
          { userId: "u_legacy", level: "editor" },
          { userId: "u_legacy_admin", level: "editor" },
        ])
      );
      expect(legacyChannel.members).toHaveLength(2);

      // dropped "urgent" priority tier folds into "high"
      const legacyTask = result.current.state.tasks.find((t) => t.id === "t_legacy")!;
      expect(legacyTask.priority).toBe("high");

      // legacy `rolePermissions` map is honored when `roles` itself is absent
      const memberRole = result.current.state.roles.find((r) => r.id === "member")!;
      expect(memberRole.permissions).toEqual(["message.send", "task.create"]);
      const adminRole = result.current.state.roles.find((r) => r.id === "admin")!;
      expect(adminRole.locked).toBe(true); // admin can't be overridden via rolePermissions

      // missing `dms` defaults to []
      expect(result.current.state.dms).toEqual([]);
    });
  }
});

describe("migrate() failure paths fall back to a fresh seed without throwing", () => {
  it("corrupt (unparseable) JSON falls back to a fresh seed", () => {
    localStorage.setItem(STORAGE_KEY, "{this is not valid JSON at all");
    const { result } = mountFromExistingStorage();
    expect(result.current.state.version).toBe(SEED_VERSION);
    expect(result.current.state.users.some((u) => u.id === "u_vlad")).toBe(true);
  });

  it("version 0 (below the accepted range) falls back to a fresh seed", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyBlob(0)));
    const { result } = mountFromExistingStorage();
    expect(result.current.state.users.some((u) => u.id === "u_legacy")).toBe(false);
    expect(result.current.state.users.some((u) => u.id === "u_vlad")).toBe(true);
  });

  it("a version newer than SEED_VERSION falls back to a fresh seed", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyBlob(SEED_VERSION + 1)));
    const { result } = mountFromExistingStorage();
    expect(result.current.state.users.some((u) => u.id === "u_legacy")).toBe(false);
    expect(result.current.state.users.some((u) => u.id === "u_vlad")).toBe(true);
  });

  it("a blob missing the whole `users` array falls back to a fresh seed instead of throwing", () => {
    const blob = legacyBlob(SEED_VERSION) as Record<string, unknown>;
    delete blob.users;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    const { result } = mountFromExistingStorage();
    expect(result.current.state.users.some((u) => u.id === "u_vlad")).toBe(true);
  });

  it("a blob missing the whole `channels` array falls back to a fresh seed instead of throwing", () => {
    const blob = legacyBlob(SEED_VERSION) as Record<string, unknown>;
    delete blob.channels;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    const { result } = mountFromExistingStorage();
    expect(result.current.state.channels.some((c) => c.id === "c_general")).toBe(true);
  });

  it("a blob missing the whole `projects` and `tasks` arrays falls back to a fresh seed instead of throwing", () => {
    const blob = legacyBlob(SEED_VERSION) as Record<string, unknown>;
    delete blob.projects;
    delete blob.tasks;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    const { result } = mountFromExistingStorage();
    expect(result.current.state.projects.some((p) => p.id === "p_website")).toBe(true);
  });

  // L1-008 (Medium): every other top-level array/record that migrate() reads
  // gets a fallback (`parsed.dms ?? []`, `parsed.roles ?? DEFAULT_ROLES...`,
  // `t.attachments ?? []`, etc.) — but `activities: parsed.activities` and
  // `lastRead: parsed.lastRead` are passed straight through with no `??`
  // fallback at all. A blob that's otherwise complete but happens to be
  // missing just `activities` doesn't throw anywhere in migrate() (there's no
  // `.map()` over it), so the try/catch never fires and the corrupt-looking
  // input is "successfully" migrated into a state with `activities: undefined`
  // — silently breaking every action that does `[...state.activities, x]`.
  // Expected: a structurally incomplete blob like this should be treated the
  // same as the other missing-array cases above and fall back to a fresh
  // seed (or at least backfill to `[]`). Actual: `state.activities` is
  // `undefined`.
  it(
    "L1-008: a blob missing only `activities` should fall back to a fresh seed (or backfill []), but yields activities: undefined",
    () => {
      const blob = legacyBlob(SEED_VERSION) as Record<string, unknown>;
      delete blob.activities;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
      const { result } = mountFromExistingStorage();
      expect(Array.isArray(result.current.state.activities)).toBe(true);
    }
  );

  // Same root cause, different field: `lastRead: parsed.lastRead` has no
  // `?? {}` fallback either. getUnreadCount does
  // `state.lastRead[`${userId}:${conversationId}`]` with no optional
  // chaining, so this isn't just a shape inconsistency — it's a live
  // TypeError waiting to happen the next time unread counts are read.
  it(
    "L1-008: a blob missing only `lastRead` should fall back to a fresh seed (or backfill {}), but yields lastRead: undefined",
    () => {
      const blob = legacyBlob(SEED_VERSION) as Record<string, unknown>;
      delete blob.lastRead;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
      const { result } = mountFromExistingStorage();
      expect(result.current.state.lastRead).not.toBeUndefined();
      expect(typeof result.current.state.lastRead).toBe("object");
    }
  );
});

describe("lumina:auth desync — a valid lumina:v1 alongside a corrupt lumina:auth", () => {
  it("the workspace store hydrates normally regardless of a corrupt auth blob", () => {
    const seed = createSeed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    localStorage.setItem("lumina:auth", "{this is not valid JSON either");

    const { result } = mountFromExistingStorage();
    expect(result.current.state.version).toBe(SEED_VERSION);
    expect(result.current.state.users.length).toBe(seed.users.length);
  });

  it("AuthProvider recovers from a corrupt lumina:auth by rebuilding fresh seeded credentials, independent of lumina:v1", async () => {
    const seed = createSeed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    localStorage.setItem("lumina:auth", "{this is not valid JSON either");

    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(AuthProvider, null, children);
    }
    const { result, unmount } = renderHook(() => useAuth(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));

    let outcome: Awaited<ReturnType<typeof result.current.login>> | undefined;
    await act(async () => {
      outcome = await result.current.login("vlad", DEMO_PASSWORD);
    });
    expect(outcome?.step).toBe("success");
    unmount();
  });
});
