// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { Board } from "@/components/kanban/board";
import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { STORAGE_KEY, asUser, baseState, installMenuShims, renderHydrated } from "./_support";

installMenuShims();
const h = React.createElement;

describe("a board with no single project", () => {
  it("labels every card with its project, offers no add buttons, and marks read-only cards", async () => {
    const state = asUser(baseState(), "u_vlad");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const nameOf = (t: { projectId: string }) => state.projects.find((p) => p.id === t.projectId)?.name;
    await renderHydrated(
      h(StoreProvider, null, h(TooltipProvider, null, h(UIProvider, null,
        h(Board, {
          tasks: state.tasks,
          label: nameOf,
          readOnly: (t) => t.projectId === "p_mobile",
        })
      )))
    );
    // Every card carries "Project - Title".
    const first = state.tasks[0];
    expect(screen.getByText(new RegExp(`${nameOf(first)} - ${first.title}`))).toBeInTheDocument();
    // No project, no "Add a task to …".
    expect(screen.queryAllByRole("button", { name: /^Add a task to/ })).toHaveLength(0);
    // Read-only cards are not draggable (dnd-kit sets aria-disabled on the handle).
    const mobile = state.tasks.find((t) => t.projectId === "p_mobile")!;
    const card = screen.getByText(new RegExp(mobile.title)).closest("[aria-roledescription='sortable']");
    expect(card).toHaveAttribute("aria-disabled", "true");
  });
});
