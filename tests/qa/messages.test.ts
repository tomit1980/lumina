// @vitest-environment jsdom
//
// Suite A4 — message rules in lib/store.tsx: sendMessage/sendToUser gating,
// editMessage/deleteMessage authorship rules, toggleReaction's visibility-only
// gate, and the per-user markChannelRead/getUnreadCount bookkeeping.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import { getUnreadCount } from "@/lib/store";
import { addRole, addUser, asUser, baseState, mount, run } from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("sendMessage content rules", () => {
  it("rejects empty content with no attachments", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const before = result.current.state.messages.length;
    const ok = run(() => result.current.sendMessage("c_engineering", ""));
    expect(ok).toBe(false);
    expect(result.current.state.messages.length).toBe(before);
  });

  it("rejects whitespace-only content with no attachments", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const before = result.current.state.messages.length;
    const ok = run(() => result.current.sendMessage("c_engineering", "   \n  "));
    expect(ok).toBe(false);
    expect(result.current.state.messages.length).toBe(before);
  });

  it("accepts empty content when an attachment is present", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const before = result.current.state.messages.length;
    const ok = run(() =>
      result.current.sendMessage("c_engineering", "", [
        {
          id: "att1",
          name: "spec.txt",
          size: 10,
          type: "text/plain",
          dataUrl: "data:text/plain;base64,aGVsbG8=",
          uploadedBy: "u_vlad",
          uploadedAt: Date.now(),
        },
      ])
    );
    expect(ok).toBe(true);
    expect(result.current.state.messages.length).toBe(before + 1);
  });

  it("rejects both empty content and no attachments even for a DM", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const before = result.current.state.messages.length;
    const dm = run(() => result.current.sendToUser("u_maya", ""));
    expect(dm).toBeNull();
    expect(result.current.state.messages.length).toBe(before);
  });
});

describe("editMessage — author-only, no permission check at all", () => {
  it("the author can edit their own message even after their role loses message.send", () => {
    let state = addRole(baseState(), { id: "r_editor_only", name: "Editor Only", permissions: [] });
    state = addUser(state, { id: "u_editor_only", roleId: "r_editor_only" });
    state.messages = [
      ...state.messages,
      {
        id: "m_own",
        channelId: "c_engineering",
        authorId: "u_editor_only",
        content: "before",
        createdAt: Date.now(),
        reactions: [],
        attachments: [],
      },
    ];
    const { result } = mount(asUser(state, "u_editor_only"));
    expect(result.current.can("message.send")).toBe(false);

    run(() => result.current.editMessage("m_own", "after"));
    const msg = result.current.state.messages.find((m) => m.id === "m_own")!;
    expect(msg.content).toBe("after");
    expect(msg.editedAt).toBeDefined();
  });

  it("a non-author cannot edit someone else's message, even an admin with message.deleteAny", () => {
    const { result } = mount(asUser(baseState(), "u_vlad")); // admin
    const target = result.current.state.messages.find((m) => m.authorId === "u_sam")!;
    run(() => result.current.editMessage(target.id, "hijacked"));
    const msg = result.current.state.messages.find((m) => m.id === target.id)!;
    expect(msg.content).toBe(target.content);
    expect(msg.editedAt).toBeUndefined();
  });
});

describe("deleteMessage — author or message.deleteAny", () => {
  it("the author can delete their own message without any special permission", () => {
    let state = addRole(baseState(), { id: "r_none", name: "No Perms", permissions: [] });
    state = addUser(state, { id: "u_none", roleId: "r_none" });
    state.messages = [
      ...state.messages,
      {
        id: "m_del_own",
        channelId: "c_engineering",
        authorId: "u_none",
        content: "delete me",
        createdAt: Date.now(),
        reactions: [],
        attachments: [],
      },
    ];
    const { result } = mount(asUser(state, "u_none"));
    run(() => result.current.deleteMessage("m_del_own"));
    expect(result.current.state.messages.some((m) => m.id === "m_del_own")).toBe(false);
  });

  it("a non-author without message.deleteAny cannot delete another user's message", () => {
    const { result } = mount(asUser(baseState(), "u_maya")); // member: no message.deleteAny
    const target = result.current.state.messages.find((m) => m.authorId === "u_sam")!;
    const before = result.current.state.messages.length;
    run(() => result.current.deleteMessage(target.id));
    expect(result.current.state.messages.length).toBe(before);
    expect(result.current.state.messages.some((m) => m.id === target.id)).toBe(true);
  });

  it("a non-author with message.deleteAny can delete another user's message", () => {
    const { result } = mount(asUser(baseState(), "u_vlad")); // admin: has message.deleteAny
    const target = result.current.state.messages.find((m) => m.authorId === "u_sam")!;
    run(() => result.current.deleteMessage(target.id));
    expect(result.current.state.messages.some((m) => m.id === target.id)).toBe(false);
  });
});

describe("toggleReaction — gated by conversation visibility only", () => {
  it("a viewer-only member of a private channel can react", () => {
    const state = baseState();
    state.channels = state.channels.map((c) =>
      c.id === "c_leadership"
        ? { ...c, members: [...c.members, { userId: "u_maya", level: "viewer" as const }] }
        : c
    );
    const { result } = mount(asUser(state, "u_maya"));
    const target = result.current.state.messages.find((m) => m.channelId === "c_leadership")!;
    run(() => result.current.toggleReaction(target.id, "🔥"));
    const reacted = result.current.state.messages.find((m) => m.id === target.id)!;
    expect(reacted.reactions.find((r) => r.emoji === "🔥")?.userIds).toContain("u_maya");
  });

  it("a non-member who cannot see a private channel cannot react to its messages", () => {
    const { result } = mount(asUser(baseState(), "u_maya")); // not a member of c_leadership
    const target = result.current.state.messages.find((m) => m.channelId === "c_leadership")!;
    run(() => result.current.toggleReaction(target.id, "🔥"));
    const untouched = result.current.state.messages.find((m) => m.id === target.id)!;
    expect(untouched.reactions.find((r) => r.emoji === "🔥")).toBeUndefined();
  });

  it("toggling twice removes the reaction (and drops the emoji entry once empty)", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const target = result.current.state.messages.find((m) => m.channelId === "c_engineering")!;
    run(() => result.current.toggleReaction(target.id, "🔥"));
    run(() => result.current.toggleReaction(target.id, "🔥"));
    const msg = result.current.state.messages.find((m) => m.id === target.id)!;
    expect(msg.reactions.find((r) => r.emoji === "🔥")).toBeUndefined();
  });
});

describe("DMs bypass message.send entirely", () => {
  it("a guest (message.send only in public channels) can still DM another user", () => {
    const { result } = mount(asUser(baseState(), "u_elena")); // guest
    const dm = run(() => result.current.sendToUser("u_vlad", "hi from guest"));
    expect(dm).not.toBeNull();
    expect(result.current.state.messages.some((m) => m.content === "hi from guest")).toBe(true);
  });

  it("sendMessage into a DM the caller is not a participant of is denied", () => {
    const state = baseState(); // d_vlad_maya exists between u_vlad and u_maya
    const { result } = mount(asUser(state, "u_jonas")); // not a participant
    const before = result.current.state.messages.length;
    const ok = run(() => result.current.sendMessage("d_vlad_maya", "sneaking into a DM"));
    expect(ok).toBe(false);
    expect(result.current.state.messages.length).toBe(before);
  });
});

describe("sendToUser find-or-creates the DM atomically", () => {
  it("a second call between the same two users reuses the existing DM instead of creating a new one", () => {
    const { result } = mount(asUser(baseState(), "u_jonas"));
    const before = result.current.state.dms.length;
    const first = run(() => result.current.sendToUser("u_priya", "first message"));
    expect(result.current.state.dms.length).toBe(before + 1);

    const second = run(() => result.current.sendToUser("u_priya", "second message"));
    expect(second?.id).toBe(first?.id);
    expect(result.current.state.dms.length).toBe(before + 1); // no new DM created
    expect(
      result.current.state.messages.filter((m) => m.channelId === first?.id).map((m) => m.content)
    ).toEqual(["first message", "second message"]);
  });

  it("returns null for a self-DM attempt", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const dm = run(() => result.current.sendToUser("u_vlad", "talking to myself"));
    expect(dm).toBeNull();
  });

  it("returns null for a nonexistent target user", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const dm = run(() => result.current.sendToUser("u_does_not_exist", "hello?"));
    expect(dm).toBeNull();
  });
});

describe("markChannelRead / getUnreadCount — per-user bookkeeping", () => {
  it("a new message increases the unread count for other members but never for its own author", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    const before = getUnreadCount(result.current.state, "u_maya", "c_engineering");
    run(() => result.current.sendMessage("c_engineering", "new update"));
    const afterForMaya = getUnreadCount(result.current.state, "u_maya", "c_engineering");
    const afterForAuthor = getUnreadCount(result.current.state, "u_vlad", "c_engineering");
    expect(afterForMaya).toBe(before + 1);
    expect(afterForAuthor).toBe(0);
  });

  it("markChannelRead resets the reader's own unread count without affecting other users'", () => {
    const { result } = mount(asUser(baseState(), "u_vlad"));
    run(() => result.current.sendMessage("c_engineering", "ping for maya"));
    expect(getUnreadCount(result.current.state, "u_maya", "c_engineering")).toBeGreaterThan(0);

    run(() => result.current.switchUser("u_maya"));
    run(() => result.current.markChannelRead("c_engineering"));
    expect(getUnreadCount(result.current.state, "u_maya", "c_engineering")).toBe(0);

    // A third user who never read it still has their own unread count.
    const jonasUnread = getUnreadCount(result.current.state, "u_jonas", "c_engineering");
    expect(jonasUnread).toBeGreaterThan(0);
  });
});
