// @vitest-environment jsdom
//
// Final review, finding 9 (final-review.md) — the board/list "person" filter
// at app/projects/page.tsx:154 uses `isMine`, so it should already include a
// task where the selected person is only a collaborator, not just its
// assignee (Task 3 of the "task-collaborators" plan). This was one of the
// two isMine call sites the reviewer named as untested; this file closes
// that gap by driving the real filter Select against the real page.
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

// See tests/qa/app-shell-collaborators.test.ts for why this polyfill is
// needed: jsdom has no PointerEvent, and Radix's Select (like its
// DropdownMenu) opens on `pointerdown`, gated on `event.button === 0`.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  // @ts-expect-error -- test-only polyfill for a jsdom gap, not a real PointerEvent
  window.PointerEvent = PointerEventPolyfill;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const searchParams = new URLSearchParams({ id: "p_pfilter" });
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/projects",
  useSearchParams: () => searchParams,
}));

import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import ProjectPage from "@/app/projects/page";
import { addProject, addTask, asUser, baseState, STORAGE_KEY } from "./_support";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderProjectPage() {
  render(
    React.createElement(
      StoreProvider,
      null,
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(UIProvider, null, React.createElement(ProjectPage))
      )
    )
  );
}

describe("app/projects/page.tsx — person filter includes collaborators, not just assignees (F1 coverage)", () => {
  it("shows a task where the filtered person is only a collaborator", async () => {
    let state = addProject(baseState(), {
      id: "p_pfilter",
      name: "Filter Project",
      createdBy: "u_vlad",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_pfilter_collab",
      projectId: "p_pfilter",
      title: "Jonas collaborates here",
      createdBy: "u_vlad",
      assigneeId: "u_sam",
      collaboratorIds: ["u_jonas"],
    });
    state = addTask(state, {
      id: "t_pfilter_unrelated",
      projectId: "p_pfilter",
      title: "Nothing to do with Jonas",
      createdBy: "u_vlad",
      assigneeId: "u_sam",
      collaboratorIds: [],
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(asUser(state, "u_vlad")));

    renderProjectPage();

    // Board view groups by status, so switch to the flat list view first —
    // simpler to assert task presence/absence against.
    fireEvent.click(await screen.findByRole("tab", { name: "List" }));

    // Open the person filter (defaults to "Everyone") and pick Jonas.
    const filterTrigger = screen.getByText("Everyone").closest("button")!;
    fireEvent.pointerDown(filterTrigger, { button: 0, ctrlKey: false, pointerId: 1 });
    fireEvent.click(await screen.findByRole("option", { name: "Jonas Weber" }));

    expect(await screen.findByText("Jonas collaborates here")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to do with Jonas")).not.toBeInTheDocument();
  });
});
