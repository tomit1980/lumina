// @vitest-environment jsdom
//
// fix-b001 — the task dialog's save() ignored what the store's updateTask
// actually did: it always toasted "Task updated", cleared the form, and
// closed the dialog, even when the store had just refused the write (its
// own "Not allowed" toast notwithstanding). The result was two contradictory
// toasts and a silently discarded edit.
//
// The repro named in the task ("a task has an existing collaborator who can
// no longer see the project because it was restricted afterwards") is now
// handled by a *different* half of the same fix — task-dialog.tsx prunes an
// ineligible collaborator from the form the moment the dialog opens on that
// task, so a save no longer trips over that particular cause of denial. To
// still exercise save()'s honesty about a refusal it can't pre-empt, this
// test reproduces the same failure mode via a race a static open-time prune
// cannot close: the project is restricted (dropping the collaborator) via a
// second actor *while the dialog is already open* — exactly the situation
// task-dialog.tsx cannot see until the user actually presses Save.
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { StoreProvider, useStore } from "@/lib/store";
import { UIProvider, useUI } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskDialog } from "@/components/task-dialog";
import { STORAGE_KEY, addProject, addTask, asUser, baseState } from "./_support";

afterEach(() => {
  cleanup();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

/** Mounts the real TaskDialog with the task dialog already open on `taskId`,
 *  and hands back the live store so the test can act as a second, more
 *  privileged user mid-edit (see file header). */
function renderTaskDialog(taskId: string) {
  const storeRef: { current: ReturnType<typeof useStore> | null } = { current: null };

  function Harness() {
    const { openTaskDialog } = useUI();
    storeRef.current = useStore();
    React.useEffect(() => {
      openTaskDialog({ taskId });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement(TaskDialog);
  }

  render(
    React.createElement(
      StoreProvider,
      null,
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(UIProvider, null, React.createElement(Harness))
      )
    )
  );
  return storeRef;
}

function seedTaskWithCollaborator() {
  let state = addProject(baseState(), {
    id: "p_race",
    name: "Race Project",
    createdBy: "u_sam",
    restricted: false, // Priya can see it when the dialog opens
  });
  state = addTask(state, {
    id: "t_race",
    projectId: "p_race",
    title: "Original title",
    createdBy: "u_sam",
    assigneeId: null,
    collaboratorIds: ["u_priya"],
  });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(asUser(state, "u_maya")));
}

describe("TaskDialog — save() honesty on a refused write (fix-b001)", () => {
  it("a save the store denies leaves the dialog open, preserves the typed title, and shows no success toast", async () => {
    seedTaskWithCollaborator();
    const storeRef = renderTaskDialog("t_race");

    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("Original title");
    // No prune notice yet — Priya can still see the (still unrestricted)
    // project at open time, so nothing was pruned.
    expect(screen.queryByText(/can't see this project/)).not.toBeInTheDocument();

    // A second, more privileged actor restricts the project out from under
    // the open dialog, dropping Priya's visibility — without anyone touching
    // this task's collaborator list. The dialog has no way to know until the
    // user actually saves.
    act(() => {
      storeRef.current!.switchUser("u_vlad"); // admin: has project.create
    });
    act(() => {
      storeRef.current!.setProjectAccess("p_race", {
        restricted: true,
        members: [{ userId: "u_maya", level: "editor" }], // Priya omitted
      });
    });
    act(() => {
      storeRef.current!.switchUser("u_maya"); // back to the person editing
    });

    fireEvent.change(titleInput, { target: { value: "Renamed while racing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // The store's own deny toast fires ...
    expect(toastMock.error).toHaveBeenCalledWith(
      "Not allowed",
      expect.objectContaining({ description: expect.stringContaining("Priya Sharma") })
    );
    // ... and the dialog must not also claim success.
    expect(toastMock.success).not.toHaveBeenCalled();

    // The dialog stays open, showing exactly what the user typed — nothing
    // was discarded.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Renamed while racing");

    // And the store really did refuse the write.
    expect(storeRef.current!.state.tasks.find((t) => t.id === "t_race")?.title).toBe(
      "Original title"
    );
  });
});

describe("TaskDialog — prunes an ineligible collaborator on open (fix-b001)", () => {
  it("the exact repro: a project restricted after Priya was added no longer traps the task", async () => {
    let state = addProject(baseState(), {
      id: "p_trap",
      name: "Trap Project",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" }], // Priya not listed
    });
    state = addTask(state, {
      id: "t_trap",
      projectId: "p_trap",
      title: "Original title",
      createdBy: "u_sam",
      assigneeId: null,
      // Priya was added while the project was still open to her; the
      // project was restricted afterwards without anyone touching this
      // list — the exact scenario from the bug report.
      collaboratorIds: ["u_priya"],
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(asUser(state, "u_maya")));

    const storeRef = renderTaskDialog("t_trap");

    // Opening the dialog prunes Priya and says so — same notice component
    // and wording changeProject already uses.
    expect(
      await screen.findByText("Removed 1 person who can't see this project")
    ).toBeInTheDocument();
    expect(screen.queryByText("Priya Sharma")).not.toBeInTheDocument();

    // Nothing was written to the store just by opening the dialog.
    expect(storeRef.current!.state.tasks.find((t) => t.id === "t_trap")?.collaboratorIds).toEqual([
      "u_priya",
    ]);

    // The task is no longer uneditable: changing the title and saving now
    // succeeds, because the prune took effect in the form and is included
    // in the save payload.
    const titleInput = screen.getByLabelText("Title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Fixed now" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // The save is a promise now (the store awaits the backend before
    // resolving), so the success toast lands a tick after the click. It is
    // still asserted to be the *only* outcome — a refused save toasts an
    // error and never a success, which is what this test pins.
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Task updated")
    );
    expect(toastMock.error).not.toHaveBeenCalled();
    const saved = storeRef.current!.state.tasks.find((t) => t.id === "t_trap")!;
    expect(saved.title).toBe("Fixed now");
    expect(saved.collaboratorIds).toEqual([]);
  });
});
