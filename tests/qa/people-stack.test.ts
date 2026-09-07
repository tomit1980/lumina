// @vitest-environment jsdom
//
// Suite — owner + collaborator avatar stack (Plan "task-collaborators",
// Task 4). Covers computePeopleStack, the pure helper that decides which
// avatars the kanban card / list row show (owner first, then up to two
// collaborators, then a "+N" overflow chip) and the full tooltip roster.
// The rendering component itself (PeopleStack) is exercised visually in the
// browser per the plan — this only locks down the selection logic.
import { describe, expect, it } from "vitest";

import { computePeopleStack } from "@/components/kanban/people-stack";
import type { User } from "@/lib/types";

function user(id: string, name: string): User {
  return {
    id,
    name,
    handle: id,
    title: "",
    roleId: "member",
    color: "#000",
    presence: "online",
  };
}

const owner = user("u_owner", "Olia Owner");
const c1 = user("u_c1", "Carl One");
const c2 = user("u_c2", "Cara Two");
const c3 = user("u_c3", "Cyd Three");

describe("computePeopleStack", () => {
  it("no owner and no collaborators — empty on every front", () => {
    const result = computePeopleStack(undefined, []);
    expect(result.shown).toEqual([]);
    expect(result.overflow).toBe(0);
    expect(result.all).toEqual([]);
  });

  it("owner only, no collaborators — no '+0' chip", () => {
    const result = computePeopleStack(owner, []);
    expect(result.shown).toEqual([{ user: owner, isOwner: true }]);
    expect(result.overflow).toBe(0);
    expect(result.all).toEqual([{ user: owner, isOwner: true }]);
  });

  it("collaborators only, no owner", () => {
    const result = computePeopleStack(undefined, [c1, c2]);
    expect(result.shown).toEqual([
      { user: c1, isOwner: false },
      { user: c2, isOwner: false },
    ]);
    expect(result.overflow).toBe(0);
  });

  it("owner plus collaborators at exactly the cap — no overflow chip", () => {
    const result = computePeopleStack(owner, [c1, c2]);
    expect(result.shown).toEqual([
      { user: owner, isOwner: true },
      { user: c1, isOwner: false },
      { user: c2, isOwner: false },
    ]);
    expect(result.overflow).toBe(0);
    expect(result.all).toHaveLength(3);
  });

  it("owner plus collaborators past the cap — shows only the first two, '+N' the rest", () => {
    const result = computePeopleStack(owner, [c1, c2, c3]);
    expect(result.shown).toEqual([
      { user: owner, isOwner: true },
      { user: c1, isOwner: false },
      { user: c2, isOwner: false },
    ]);
    expect(result.overflow).toBe(1);
    // The tooltip roster still lists everyone, owner first and marked.
    expect(result.all).toEqual([
      { user: owner, isOwner: true },
      { user: c1, isOwner: false },
      { user: c2, isOwner: false },
      { user: c3, isOwner: false },
    ]);
  });

  it("owner is always first in `all`, even though it's resolved separately from the collaborator list", () => {
    const result = computePeopleStack(owner, [c1]);
    expect(result.all[0]).toEqual({ user: owner, isOwner: true });
  });

  it("a custom cap is honored", () => {
    const result = computePeopleStack(owner, [c1, c2, c3], 1);
    expect(result.shown).toEqual([
      { user: owner, isOwner: true },
      { user: c1, isOwner: false },
    ]);
    expect(result.overflow).toBe(2);
  });
});
