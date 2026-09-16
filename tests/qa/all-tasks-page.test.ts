// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/tasks",
}));

import AllTasksPage from "@/app/tasks/page";
import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { STORAGE_KEY, addProject, addTask, asUser, baseState, installMenuShims, renderHydrated } from "./_support";
import type { AppState } from "@/lib/types";

installMenuShims();
const h = React.createElement;

// Each case renders the whole page, and without this the second render is
// APPENDED to the first one's DOM rather than replacing it — both cases' cards
// then sit in the document at once. The two cases here happen not to collide,
// but the file passing depends on that accident: it makes a third case, or a
// mutation of the access filter, fail as "Found multiple elements" instead of
// saying what is actually wrong. Auto-cleanup does not run in this repo
// (`globals` is off in vitest.config.ts), so every jsdom file registers it by
// hand — see tests/qa/accessible-names.test.ts and client-info-pane.test.ts.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function renderAs(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  await renderHydrated(h(StoreProvider, null, h(TooltipProvider, null, h(UIProvider, null, h(AllTasksPage)))));
}

/** A restricted project u_maya is not on, with one task in it. */
function withSecret(state: AppState): AppState {
  let s = addProject(state, { id: "p_secret", name: "Secret Case", createdBy: "u_vlad", restricted: true, members: [] });
  s = addTask(s, { id: "t_secret", projectId: "p_secret", title: "Hidden work", createdBy: "u_vlad" });
  return s;
}

// A card's "Project - Task" label sits in its own <span> beside the title
// text, not concatenated into one text node (components/kanban/task-card.tsx)
// — deliberately, so the label can be muted separately. A plain string/RegExp
// `getByText` can't see across that split, so — matching the same fix already
// applied in tests/qa/board-cross-project.test.ts — these query the full text
// of the enclosing <p> instead. The assertions themselves are unchanged.
function cardText(text: string) {
  return (_: string, el: Element | null) => el?.tagName === "P" && el?.textContent === text;
}

describe("the all-tasks board", () => {
  it("shows every visible project's tasks as 'Project - Task', and not one the person cannot see", async () => {
    await renderAs(withSecret(asUser(baseState(), "u_maya")));
    const website = baseState().tasks.find((t) => t.projectId === "p_website")!;
    expect(screen.getByText(cardText(`Website Redesign - ${website.title}`))).toBeInTheDocument();
    expect(screen.queryByText(/Hidden work/)).not.toBeInTheDocument();
  });

  it("CONTROL: an admin sees the restricted project's task too", async () => {
    await renderAs(withSecret(asUser(baseState(), "u_vlad")));
    expect(screen.getByText(cardText("Secret Case - Hidden work"))).toBeInTheDocument();
  });
});
