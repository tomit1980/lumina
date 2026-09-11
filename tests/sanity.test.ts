import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "@/lib/permissions";

describe("test harness", () => {
  it("resolves the @/ alias into app code", () => {
    expect(ALL_PERMISSIONS).toContain("members.manage");
  });

  it("has exactly the 13 permissions the schema encodes", () => {
    // 13 since `workspace.taskSets` joined them. The count is pinned
    // deliberately: a permission added without a matching seed and a matching
    // row in the roles table is a permission no policy will ever grant — and
    // this pin is what caught that on the way in. Raising it is only correct
    // once 20260911000200_task_sets.sql has appended the permission to the
    // owner and admin rows, which it does.
    expect(ALL_PERMISSIONS).toHaveLength(13);
  });
});
