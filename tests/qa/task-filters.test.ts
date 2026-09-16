import { describe, expect, it } from "vitest";
import { applyTaskFilters } from "@/components/kanban/task-filters";
import { baseState } from "./_support";

describe("applyTaskFilters", () => {
  const tasks = baseState().tasks;
  it("passes everything through on all/all", () => {
    expect(applyTaskFilters(tasks, "all", "all")).toHaveLength(tasks.length);
  });
  it("narrows to one person, owner or collaborator", () => {
    // u_elena is the assignee on several seed tasks (owner branch) AND a
    // collaborator, not the assignee, on "Homepage hero — copy & layout
    // exploration" (lib/seed.ts:346, assigneeId u_maya). Using her exercises
    // both halves of isMine in one filter call.
    const mine = applyTaskFilters(tasks, "u_elena", "all");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.assigneeId === "u_elena" || t.collaboratorIds.includes("u_elena"))).toBe(true);
    // Owner branch: at least one task where she's the direct assignee.
    expect(mine.some((t) => t.assigneeId === "u_elena")).toBe(true);
    // Collaborator branch: the hero task, where she is NOT the assignee —
    // this fails if isMine's collaborator check is ever dropped.
    expect(
      mine.some(
        (t) => t.title === "Homepage hero — copy & layout exploration" && t.assigneeId !== "u_elena"
      )
    ).toBe(true);
  });
  it("narrows to the unassigned and to a priority", () => {
    expect(applyTaskFilters(tasks, "unassigned", "all").every((t) => t.assigneeId === null)).toBe(true);
    expect(applyTaskFilters(tasks, "all", "high").every((t) => t.priority === "high")).toBe(true);
  });
});
