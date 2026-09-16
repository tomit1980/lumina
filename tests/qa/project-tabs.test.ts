import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAB_PREFS, PROJECT_TABS, moveTab, toggleTab, visibleTabs,
} from "@/lib/project-tabs";

const ids = (prefs: Parameters<typeof visibleTabs>[0]) => visibleTabs(prefs).map((t) => t.id);

describe("visibleTabs", () => {
  it("shows the four in default order with no preference", () => {
    expect(ids(DEFAULT_TAB_PREFS)).toEqual(["board", "list", "client", "files"]);
  });
  it("applies an order and a hidden set", () => {
    expect(ids({ order: ["client", "board", "files", "list"], hidden: ["list"] }))
      .toEqual(["client", "board", "files"]);
  });
  it("ignores an id it does not know", () => {
    expect(ids({ order: ["board", "wat" as never, "files"], hidden: ["nope" as never] }))
      .toEqual(["board", "files", "list", "client"]);
  });
  it("appends ids missing from the order, in default order — a fifth tab later must appear", () => {
    expect(ids({ order: ["files"], hidden: [] })).toEqual(["files", "board", "list", "client"]);
  });
  it("collapses duplicates", () => {
    expect(ids({ order: ["board", "board", "list"], hidden: [] }))
      .toEqual(["board", "list", "client", "files"]);
  });
  it("falls back to the default row when everything is hidden", () => {
    // A project with no tabs is a project you cannot use.
    expect(ids({ order: [], hidden: ["board", "list", "client", "files"] }))
      .toEqual(["board", "list", "client", "files"]);
  });
});

describe("editing a preference", () => {
  it("moves a tab earlier and later, and not past the ends", () => {
    const p = DEFAULT_TAB_PREFS;
    expect(moveTab(p, "client", -1).order).toEqual(["board", "client", "list", "files"]);
    expect(moveTab(p, "board", -1).order).toEqual(p.order);
    expect(moveTab(p, "files", 1).order).toEqual(p.order);
  });
  it("hides and shows without disturbing the order", () => {
    const hidden = toggleTab(DEFAULT_TAB_PREFS, "list", false);
    expect(hidden.hidden).toEqual(["list"]);
    expect(hidden.order).toEqual(DEFAULT_TAB_PREFS.order);
    expect(toggleTab(hidden, "list", true).hidden).toEqual([]);
  });
  it("CONTROL: PROJECT_TABS is the source of truth for the defaults", () => {
    expect(DEFAULT_TAB_PREFS.order).toEqual(PROJECT_TABS.map((t) => t.id));
  });
});
