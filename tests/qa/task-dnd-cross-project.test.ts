import { describe, expect, it } from "vitest";
import { indexWithinProject, orderColumn } from "@/components/kanban/use-task-dnd";
import type { Task } from "@/lib/types";

const t = (id: string, projectId: string, order: number): Task =>
  ({ id, projectId, order, status: "todo", title: id, collaboratorIds: [], assigneeId: null } as unknown as Task);
const name = (x: Task) => ({ p_b: "Beta", p_a: "Alpha" }[x.projectId] ?? x.projectId);

describe("orderColumn", () => {
  it("in one project, sorts by order — exactly as before", () => {
    expect(orderColumn([t("x", "p_a", 2), t("y", "p_a", 0)], false, name).map((x) => x.id)).toEqual(["y", "x"]);
  });
  it("across projects, groups by project name and keeps each project's order inside the group", () => {
    const col = [t("b1", "p_b", 0), t("a2", "p_a", 1), t("b0", "p_b", 1), t("a1", "p_a", 0)];
    expect(orderColumn(col, true, name).map((x) => x.id)).toEqual(["a1", "a2", "b1", "b0"]);
  });
});

describe("indexWithinProject", () => {
  // `order` is dense only within project+status, so the index moveTask needs
  // is the position among the SAME project's tasks in the destination.
  const dest = [t("a1", "p_a", 0), t("a2", "p_a", 1), t("b1", "p_b", 0)];
  it("counts only the task's own project's cards before the drop point", () => {
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 0)).toBe(0);
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 1)).toBe(1);
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 3)).toBe(2);
  });
  it("appends when the project has nothing in that column yet", () => {
    expect(indexWithinProject(dest, t("c1", "p_c", 0), 1)).toBe(0);
  });
});
