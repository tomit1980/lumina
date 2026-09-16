import { describe, expect, it } from "vitest";
import { applyTaskFilters } from "@/components/kanban/task-filters";
import { baseState } from "./_support";

describe("applyTaskFilters", () => {
  const tasks = baseState().tasks;
  it("passes everything through on all/all", () => {
    expect(applyTaskFilters(tasks, "all", "all")).toHaveLength(tasks.length);
  });
  it("narrows to one person, owner or collaborator", () => {
    const mine = applyTaskFilters(tasks, "u_maya", "all");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.assigneeId === "u_maya" || t.collaboratorIds.includes("u_maya"))).toBe(true);
  });
  it("narrows to the unassigned and to a priority", () => {
    expect(applyTaskFilters(tasks, "unassigned", "all").every((t) => t.assigneeId === null)).toBe(true);
    expect(applyTaskFilters(tasks, "all", "high").every((t) => t.priority === "high")).toBe(true);
  });
});
