// @vitest-environment jsdom
//
// Editing a person's own details — name, handle, title.
//
// The permission rules are the database's: `profiles_update_self` grants a
// blanket UPDATE on your own row and `profiles_admin_write` gives a
// `members.manage` holder everyone's. tests/rls/profile-writes.test.ts asserts
// those from real sessions. What this file covers is the half that only exists
// here — refusing early with a sentence instead of letting a policy filter the
// write to nothing, and putting the optimistic rename back when it is refused.
//
// The handle rules deserve their own note. `profiles.handle` is `not null
// unique`, so the index is what actually stops a collision; the check in the
// store is for the message. Both are tested, in their own layers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { FailingBackend, adminState, asUser, baseState, mount, run } from "./_support";
import type { AppState } from "@/lib/types";

/** u_maya is a Member; u_vlad an Admin. Both are seeded. */
const MAYA = "u_maya";
const JONAS = "u_jonas";

function nameOf(result: { current: { state: AppState } }, id: string) {
  return result.current.state.users.find((u) => u.id === id)!.name;
}

function handleOf(result: { current: { state: AppState } }, id: string) {
  return result.current.state.users.find((u) => u.id === id)!.handle;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.error.mockClear();
});

describe("who may edit whose details", () => {
  it("lets a member rename THEMSELVES", async () => {
    // No permission needed: it is your own row, and the database says so.
    const { result } = await mount(asUser(baseState(), MAYA));

    const ok = await run(() => result.current.updateProfile(MAYA, { name: "Maya Okonkwo" }));

    expect(ok).toBe(true);
    expect(nameOf(result, MAYA)).toBe("Maya Okonkwo");
  });

  it("REFUSES a member renaming somebody else, before any call", async () => {
    // The round trip would be filtered out by RLS and return nothing, which
    // reads as success to anything that only checks for an error. Refusing
    // here is what turns that into a sentence.
    const backend = new FailingBackend("updateProfile");
    const { result } = await mount(asUser(baseState(), MAYA), backend);

    const ok = await run(() => result.current.updateProfile(JONAS, { name: "Renamed" }));

    expect(ok).toBe(false);
    expect(nameOf(result, JONAS)).not.toBe("Renamed");
    // Asserted as "the backend was never asked", not as a message — a test
    // about the message would pass against a store that called anyway.
    expect(backend.attempted).not.toContain("updateProfile");
  });

  it("CONTROL: an admin renames that same person", async () => {
    // Without this the refusal above would also pass against a store that
    // refused everybody, which is a broken feature wearing a passing test.
    const { result } = await mount(adminState());

    const ok = await run(() => result.current.updateProfile(JONAS, { name: "Jonas Berg" }));

    expect(ok).toBe(true);
    expect(nameOf(result, JONAS)).toBe("Jonas Berg");
  });
});

describe("what it refuses before spending a round trip", () => {
  it("refuses a blank name", async () => {
    const { result } = await mount(asUser(baseState(), MAYA));
    const before = nameOf(result, MAYA);

    const ok = await run(() => result.current.updateProfile(MAYA, { name: "   " }));

    expect(ok).toBe(false);
    expect(nameOf(result, MAYA)).toBe(before);
  });

  it("normalises a handle rather than refusing it", async () => {
    // "Maya O'Brien!" is not a handle, but it is obviously an attempt at one.
    // The trigger derives handles the same way, so this matches what an
    // account gets at sign-up.
    const { result } = await mount(asUser(baseState(), MAYA));

    await run(() => result.current.updateProfile(MAYA, { handle: "Maya O'Brien!" }));

    expect(handleOf(result, MAYA)).toBe("mayaobrien");
  });

  it("refuses a handle with nothing usable in it", async () => {
    const { result } = await mount(asUser(baseState(), MAYA));
    const before = handleOf(result, MAYA);

    const ok = await run(() => result.current.updateProfile(MAYA, { handle: "!!!" }));

    expect(ok).toBe(false);
    expect(handleOf(result, MAYA)).toBe(before);
  });

  it("refuses a handle somebody else already holds", async () => {
    const backend = new FailingBackend("updateProfile");
    const { result } = await mount(asUser(baseState(), MAYA), backend);
    const taken = handleOf(result, JONAS);

    const ok = await run(() => result.current.updateProfile(MAYA, { handle: taken }));

    expect(ok).toBe(false);
    expect(backend.attempted).not.toContain("updateProfile");
  });

  it("CONTROL: keeping your own handle is not a collision with yourself", async () => {
    // The obvious way to write the uniqueness check excludes nobody, so saving
    // a form without touching the handle refuses. That would make the dialog
    // unusable while every other test here still passed.
    const { result } = await mount(asUser(baseState(), MAYA));
    const mine = handleOf(result, MAYA);

    const ok = await run(() =>
      result.current.updateProfile(MAYA, { name: "Maya O.", handle: mine })
    );

    expect(ok).toBe(true);
    expect(nameOf(result, MAYA)).toBe("Maya O.");
  });
});

describe("when the backend refuses", () => {
  it("puts the old details back", async () => {
    const { result } = await mount(asUser(baseState(), MAYA), new FailingBackend("updateProfile"));
    const before = nameOf(result, MAYA);

    const ok = await run(() => result.current.updateProfile(MAYA, { name: "Optimistic" }));

    expect(ok).toBe(false);
    expect(nameOf(result, MAYA)).toBe(before);
  });
});
