// @vitest-environment jsdom
//
// Task 3 (Plan "task-collaborators") — app/page.tsx's "My tasks" list used to
// filter on `assigneeId === currentUser.id` only. It now includes tasks the
// current user collaborates on (not just owns), with owned tasks sorted
// ahead of collaborated-on ones. Renders the real HomePage against the real
// store, following tests/qa/accessible-names.test.ts's next/navigation mock.
import * as React from "react";
import { cleanup, screen } from "@testing-library/react";
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
import {
  addProject,
  addTask,
  asUser,
  baseState,
  renderHydrated,
  STORAGE_KEY,
} from "./_support";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderHome() {
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

describe("app/page.tsx — 'My tasks' includes collaborator tasks, owned tasks first", () => {
  it("lists a task the user only collaborates on, sorted after a task the user owns", async () => {
    let state = addProject(baseState(), {
      id: "p_home_collab",
      name: "Home Collab Project",
      createdBy: "u_sam",
      restricted: false,
    });
    // Owned by u_maya, later due date.
    state = addTask(state, {
      id: "t_owned",
      projectId: "p_home_collab",
      title: "Owned by me",
      createdBy: "u_sam",
      assigneeId: "u_maya",
      collaboratorIds: [],
      status: "todo",
      dueDate: Date.now() + 10 * 24 * 60 * 60 * 1000,
    });
    // Collaborated on by u_maya (owned by u_sam), earlier due date — would
    // sort first on due date alone, but owned tasks must come first.
    state = addTask(state, {
      id: "t_collab",
      projectId: "p_home_collab",
      title: "Collaborating with me",
      createdBy: "u_sam",
      assigneeId: "u_sam",
      collaboratorIds: ["u_maya"],
      status: "todo",
      dueDate: Date.now() + 1 * 24 * 60 * 60 * 1000,
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(asUser(state, "u_maya")));

    await renderHome();

    expect(screen.getByText("Owned by me")).toBeInTheDocument();
    expect(screen.getByText("Collaborating with me")).toBeInTheDocument();

    const titles = screen
      .getAllByText(/^(Owned by me|Collaborating with me)$/)
      .map((el) => el.textContent);
    expect(titles).toEqual(["Owned by me", "Collaborating with me"]);
  });

  it("does not list a task for a user who is neither owner nor collaborator", async () => {
    let state = addProject(baseState(), {
      id: "p_home_collab2",
      name: "Home Collab Project 2",
      createdBy: "u_sam",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_not_mine",
      projectId: "p_home_collab2",
      title: "Definitely not Jonas's task",
      createdBy: "u_sam",
      assigneeId: "u_sam",
      collaboratorIds: ["u_maya"],
      status: "todo",
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(asUser(state, "u_jonas")));

    await renderHome();

    expect(screen.queryByText("Definitely not Jonas's task")).not.toBeInTheDocument();
  });
});
