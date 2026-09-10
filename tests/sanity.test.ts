import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "@/lib/permissions";

describe("test harness", () => {
  it("resolves the @/ alias into app code", () => {
    expect(ALL_PERMISSIONS).toContain("members.manage");
  });

  it("has exactly the 12 permissions the schema encodes", () => {
    // 12 since `workspace.statuses` joined them — the Owner's one power
    // beyond Admin. The count is pinned deliberately: a permission added
    // without a matching seed and a matching row in the roles table is a
    // permission no policy will ever grant.
    expect(ALL_PERMISSIONS).toHaveLength(12);
  });
});
