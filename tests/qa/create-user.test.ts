// @vitest-environment jsdom
//
// The store's half of adding a teammate.
//
// The rules that matter are enforced by the Edge Function, which re-derives
// them from the caller's token — see tests/rls/create-user-function.test.ts,
// which drives the deployed function directly. This file covers what the
// store owes the person at the keyboard: refusing early with a sentence they
// can act on, and never claiming an account was made when it was not.
//
// One design point these tests pin deliberately: `createUser` does NOT go
// through `commit`. There IS a new member, but the profile row is written
// server-side and this store has never seen it — so an optimistic placeholder
// would be a guess at data the workspace already holds, and the guess would
// be wrong about the id, the handle and the avatar. The next load brings the
// real row in.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { FailingBackend, adminState, asUser, mount, run } from "./_support";
import { LocalBackend } from "@/lib/backend/local";

/** The happy-path arguments; each test overrides the one part it is about. */
const NEW = { email: "new@example.com", password: "hunter2hunter2", roleId: "member" };

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.error.mockClear();
});

describe("who may add people", () => {
  it("refuses a member before any network call", async () => {
    const { result } = await mount(asUser(adminState(), "u_maya"));
    const failure = await run(() => result.current.createUser(NEW));

    expect(failure).toMatch(/can't add people/i);
  });

  it("CONTROL: an admin gets past the permission gate", async () => {
    // Reaches the backend, which is the local one here and rejects — proving
    // the guard let it through rather than the guard being absent.
    const { result } = await mount(adminState());
    const failure = await run(() => result.current.createUser(NEW));

    expect(failure).toMatch(/local demo/i);
  });
});

describe("the rank rule, mirrored for a decent message", () => {
  it("refuses an admin adding an Owner, naming the role", async () => {
    // The Edge Function refuses this too, and so does the database on the
    // profile update. Refusing here first is what turns a constraint error
    // into a sentence.
    const { result } = await mount(adminState());
    const failure = await run(() =>
      result.current.createUser({ ...NEW, roleId: "owner" })
    );

    expect(failure).toMatch(/can't add someone as Owner/i);
  });

  it("CONTROL: an owner adding an admin is not refused by the rank rule", async () => {
    const { result } = await mount(asUser(adminState(), "u_owner"));
    const failure = await run(() =>
      result.current.createUser({ ...NEW, roleId: "admin" })
    );

    // Gets as far as the backend rather than being turned away on rank.
    expect(failure).toMatch(/local demo/i);
    expect(failure).not.toMatch(/can't add someone as/i);
  });

  it("refuses a role that does not exist", async () => {
    const { result } = await mount(adminState());
    const failure = await run(() =>
      result.current.createUser({ ...NEW, roleId: "sorcerer" })
    );

    expect(failure).toMatch(/doesn't exist/i);
  });
});

describe("what it refuses before spending a round trip", () => {
  it("refuses a password under eight characters", async () => {
    // Supabase's own floor is six. Saying so here means the rule arrives
    // before the network call rather than as a raw API message after it.
    const { result } = await mount(adminState());
    const failure = await run(() =>
      result.current.createUser({ ...NEW, password: "short" })
    );

    expect(failure).toMatch(/8 characters/i);
  });

  it("refuses an address with no @ in it", async () => {
    const { result } = await mount(adminState());
    const failure = await run(() =>
      result.current.createUser({ ...NEW, email: "not-an-address" })
    );

    expect(failure).toMatch(/valid email/i);
  });

  it("CONTROL: a valid address and a long enough password reach the backend", async () => {
    // Without this, a store that refused every input would pass both
    // negatives above while being completely broken.
    const { result } = await mount(adminState());
    const failure = await run(() => result.current.createUser(NEW));

    expect(failure).toMatch(/local demo/i);
    expect(failure).not.toMatch(/valid email|8 characters/i);
  });
});

describe("what the caller is told", () => {
  it("returns the backend's own message rather than a generic failure", async () => {
    // The Edge Function's sentences — "already in the workspace", "your role
    // can't add people" — are the useful ones. A store that flattened them
    // to "something went wrong" would be throwing away the only part the
    // person can act on.
    const backend = new FailingBackend("createUser");
    const { result } = await mount(adminState(), backend);
    const failure = await run(() => result.current.createUser(NEW));

    expect(failure).toBe("createUser failed");
  });

  it("adds no member and no placeholder on failure", async () => {
    // `LocalBackend` rejects, so this asserts the failure path leaves nothing
    // behind. The success path adds nothing either, by construction: there is
    // no `commit` and no optimistic patch — only an activity line.
    const before = adminState();
    const { result } = await mount(before, new LocalBackend());
    const usersBefore = result.current.state.users.length;

    await run(() => result.current.createUser(NEW));

    expect(result.current.state.users).toHaveLength(usersBefore);
    expect(
      result.current.state.users.some((u) => u.name.includes(NEW.email))
    ).toBe(false);
  });
});
