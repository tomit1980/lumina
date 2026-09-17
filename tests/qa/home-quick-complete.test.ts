// @vitest-environment jsdom
//
// The home page's "Mark complete" button sent the literal string "done".
//
// It was the last hardcoded status id on a write path — every other site has
// read the workspace's own statuses since the statuses table landed
// (components/kanban/board.tsx:168). In a workspace whose done column carries
// any other id, that literal either violates `tasks_status_fkey` outright or
// writes a status nothing recognises, so the card is "completed" into a column
// that does not exist and simply stays where it was.
//
// This matters beyond tidiness: recurring tasks key entirely on
// `isDoneStatus(...)`, so this is the one completion path where a recurrence
// could silently fail to fire.
//
// The assertion is behavioural rather than internal: a completed task leaves
// "My tasks", which filters on `!isDone(state, t.status)`. With the literal,
// `isDone` cannot resolve "done" in this workspace, returns false, and the
// task stays on screen.
import * as React from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import HomePage from "@/app/page";
import { addProject, addTask, asUser, baseState, renderHydrated } from "./_support";
import type { AppState } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

/** A workspace that renamed its done column — the thing an Owner may do in
 *  Settings, and the thing the literal could not survive. Seeded tasks sitting
 *  in the old column move with it, or they would point at a status that no
 *  longer exists and the fixture would be testing something else. */
function doneColumnRenamed(state: AppState): AppState {
  const oldId = state.statuses.find((s) => s.isDone)?.id ?? "done";
  return {
    ...state,
    statuses: state.statuses.map((s) =>
      s.isDone ? { ...s, id: "finished", name: "Shipped" } : s
    ),
    tasks: state.tasks.map((t) => (t.status === oldId ? { ...t, status: "finished" } : t)),
  };
}

async function renderHome(state: AppState) {
  localStorage.setItem("lumina:v1", JSON.stringify(state));
  await renderHydrated(
    React.createElement(
      StoreProvider,
      null,
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(UIProvider, null, React.createElement(HomePage))
      )
    )
  );
}

describe("the home page's quick-complete", () => {
  it("completes into the workspace's done column, whatever its id", async () => {
    let state = doneColumnRenamed(asUser(baseState(), "u_maya"));
    state = addProject(state, {
      id: "p_qc",
      name: "Quick Complete",
      createdBy: "u_vlad",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_qc",
      projectId: "p_qc",
      title: "Renamed column task",
      createdBy: "u_vlad",
      assigneeId: "u_maya",
      status: "todo",
      dueDate: Date.now(),
    });
    await renderHome(state);

    expect(screen.getByText("Renamed column task")).toBeInTheDocument();

    const button = screen.getByLabelText('Mark "Renamed column task" complete');
    await act(async () => {
      fireEvent.click(button);
      // `updateTask` yields before the store settles; the click alone is not a
      // barrier. Matches tests/qa/task-dialog.test.ts:120-130.
      await Promise.resolve();
    });

    expect(screen.queryByText("Renamed column task")).not.toBeInTheDocument();
  });

  it("CONTROL: with no done column at all, the button is not offered", async () => {
    // Not a hypothetical — `firstOpenStatus` already guards for it, and a
    // button that cannot succeed should not be on screen. This also proves the
    // test above passed because the write landed, not because the button
    // happened to be absent.
    let state = asUser(baseState(), "u_maya");
    state = {
      ...state,
      statuses: state.statuses.map((s) => ({ ...s, isDone: false })),
    };
    state = addProject(state, {
      id: "p_qc2",
      name: "No Done Column",
      createdBy: "u_vlad",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_qc2",
      projectId: "p_qc2",
      title: "Nowhere to finish",
      createdBy: "u_vlad",
      assigneeId: "u_maya",
      status: "todo",
      dueDate: Date.now(),
    });
    await renderHome(state);

    expect(screen.getByText("Nowhere to finish")).toBeInTheDocument();
    expect(screen.queryByLabelText('Mark "Nowhere to finish" complete')).toBeNull();
  });
});
