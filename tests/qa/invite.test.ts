// @vitest-environment jsdom
//
// The store's half of inviting someone.
//
// The rules that matter are enforced by the Edge Function, which re-derives
// them from the caller's token — see tests/rls/invite-function.test.ts, which
// drives the deployed function directly. This file covers what the store owes
// the person at the keyboard: refusing early with a sentence they can act on,
// and never claiming an invitation landed when it did not.
//
// One design point these tests pin deliberately: `inviteUser` does NOT go
// through `commit`. There is no optimistic state — the invited person has no
// profile until they accept — so a placeholder member would be a claim the
// workspace cannot back up.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { FailingBackend, adminState, asUser, mount, run } from "./_support";
import { LocalBackend } from "@/lib/backend/local";

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.error.mockClear();
});

describe("who may invite", () => {
  it("refuses a member before any network call", async () => {
    const { result } = await mount(asUser(adminState(), "u_maya"));
    const failure = await run(() => result.current.inviteUser("new@example.com", "member"));

    expect(failure).toMatch(/can't invite/i);
  });

  it("CONTROL: an admin gets past the permission gate", async () => {
    // Reaches the backend, which is the local one here and rejects — proving
    // the guard let it through rather than the guard being absent.
    const { result } = await mount(adminState());
    const failure = await run(() => result.current.inviteUser("new@example.com", "member"));

    expect(failure).toMatch(/local demo/i);
  });
});

describe("the rank rule, mirrored for a decent message", () => {
  it("refuses an admin inviting an Owner, naming the role", async () => {
    // The Edge Function refuses this too, and so does the database on the
    // profile update. Refusing here first is what turns a constraint error
    // into a sentence.
    const { result } = await mount(adminState());
    const failure = await run(() => result.current.inviteUser("new@example.com", "owner"));

    expect(failure).toMatch(/can't invite someone as Owner/i);
  });

  it("CONTROL: an owner inviting an admin is not refused by the rank rule", async () => {
    const { result } = await mount(asUser(adminState(), "u_owner"));
    const failure = await run(() => result.current.inviteUser("new@example.com", "admin"));

    // Gets as far as the backend rather than being turned away on rank.
    expect(failure).toMatch(/local demo/i);
    expect(failure).not.toMatch(/can't invite someone as/i);
  });

  it("refuses a role that does not exist", async () => {
    const { result } = await mount(adminState());
    const failure = await run(() => result.current.inviteUser("new@example.com", "sorcerer"));

    expect(failure).toMatch(/doesn't exist/i);
  });
});

describe("what the caller is told", () => {
  it("returns the backend's own message rather than a generic failure", async () => {
    // The Edge Function's sentences — "already in the workspace", "your role
    // can't invite people" — are the useful ones. A store that flattened them
    // to "something went wrong" would be throwing away the only part the
    // person can act on.
    const backend = new FailingBackend("inviteUser");
    const { result } = await mount(adminState(), backend);
    const failure = await run(() => result.current.inviteUser("new@example.com", "member"));

    expect(failure).toBe("inviteUser failed");
  });

  it("adds no member and no placeholder on success", async () => {
    // `LocalBackend` rejects, so this asserts the failure path leaves nothing
    // behind. The success path adds nothing either, by construction: there is
    // no `commit` and no optimistic patch — only an activity line.
    const before = adminState();
    const { result } = await mount(before, new LocalBackend());
    const usersBefore = result.current.state.users.length;

    await run(() => result.current.inviteUser("new@example.com", "member"));

    expect(result.current.state.users).toHaveLength(usersBefore);
    expect(
      result.current.state.users.some((u) => u.name.includes("new@example.com"))
    ).toBe(false);
  });
});
