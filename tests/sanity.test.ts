import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "@/lib/permissions";

describe("test harness", () => {
  it("resolves the @/ alias into app code", () => {
    expect(ALL_PERMISSIONS).toContain("members.manage");
  });

  it("has exactly the 11 permissions the schema will encode", () => {
    expect(ALL_PERMISSIONS).toHaveLength(11);
  });
});
