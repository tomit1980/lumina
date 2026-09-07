// @vitest-environment jsdom
//
// Task 3 (Plan "task-collaborators") — the reminder gate in
// components/reminders.tsx used to fire only for a task's assignee (plus the
// creator-of-an-unassigned-task fallback). It now also fires for a
// collaborator. This renders the real <Reminders /> against the real store,
// mocking only `sonner`'s toast (per tests/qa/document-save.test.ts's
// pattern) so the fired-toast title/description can be asserted directly.
import * as React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { StoreProvider } from "@/lib/store";
import { Reminders } from "@/components/reminders";
import { addProject, addTask, asUser, baseState, STORAGE_KEY } from "./_support";

afterEach(() => {
  cleanup();
  toastMock.mockClear();
  window.localStorage.clear();
  vi.useRealTimers();
});

/** A timed task whose reminder window is open right now: reminderMinutes: 0
 *  means fireAt === start, and duration keeps `end` comfortably in the
 *  future, so <Reminders/>'s immediate on-mount tick() fires it. */
function scheduledNowTask(overrides: Parameters<typeof addTask>[1]) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return {
    dueDate: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
    startTime: `${hh}:${mm}`,
    durationMinutes: 60,
    reminderMinutes: 0,
    status: "todo" as const,
    ...overrides,
  };
}

describe("components/reminders.tsx — the reminder gate includes collaborators", () => {
  it("fires a reminder toast for a task's collaborator, not just its assignee", async () => {
    let state = addProject(baseState(), {
      id: "p_reminders",
      name: "Reminders Project",
      createdBy: "u_sam",
      restricted: false,
    });
    state = addTask(
      state,
      scheduledNowTask({
        id: "t_collab_reminder",
        projectId: "p_reminders",
        title: "Collaborator's reminder",
        createdBy: "u_sam",
        assigneeId: "u_sam", // owned by someone else...
        collaboratorIds: ["u_maya"], // ...but u_maya collaborates on it
      })
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(asUser(state, "u_maya")));

    render(React.createElement(StoreProvider, null, React.createElement(Reminders)));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        "Collaborator's reminder",
        expect.objectContaining({ description: expect.any(String) })
      );
    });
  });

  it("does not fire for a user who is neither the assignee nor a collaborator", async () => {
    let state = addProject(baseState(), {
      id: "p_reminders",
      name: "Reminders Project",
      createdBy: "u_sam",
      restricted: false,
    });
    state = addTask(
      state,
      scheduledNowTask({
        id: "t_not_mine",
        projectId: "p_reminders",
        title: "Not u_jonas's task",
        createdBy: "u_sam",
        assigneeId: "u_sam",
        collaboratorIds: ["u_maya"],
      })
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(asUser(state, "u_jonas")));

    render(React.createElement(StoreProvider, null, React.createElement(Reminders)));

    // Give the on-mount tick() a turn, then confirm it never toasted.
    await new Promise((r) => setTimeout(r, 0));
    expect(toastMock).not.toHaveBeenCalled();
  });
});
