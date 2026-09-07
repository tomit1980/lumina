// Final review, finding 1 / finding 9 (final-review.md) — the schedule
// export at components/app-shell.tsx ("Export my schedule (.ics)") used
// `isMineOrUnclaimed` alone, so a revoked collaborator's task kept getting
// exported even though they could no longer see its project. This was also
// one of the two isMine call sites the reviewer named as untested.
//
// `computeMyScheduledTasks` is exported straight off app-shell.tsx and is
// the *exact* function `myScheduledTasks`'s useMemo calls (see the
// component) — not a re-implementation of its logic — so testing it here
// directly exercises the real call site without needing to drive Radix's
// DropdownMenu through jsdom. That UI path (open the current-user menu,
// click "Export my schedule") was tried first and works, but reliably
// triggers a genuine, reproducible Vitest defect under this project's jsdom
// setup: `npm test` alone (no other change) went from exit 0 to exit 1 with
// "Unhandled Error: Timeout calling onTaskUpdate/snapshotSaved" every time a
// test opened that menu via a PointerEvent-polyfilled pointerdown, even
// though every assertion in the run still passed — i.e. it silently broke
// the "npm test must exit 0" gate the whole verification chain depends on.
// Not worth trading that gate away for a UI-level rendering of a filter
// this thin (a single `&&`-chained predicate); the same one accessible-names
// test that mounts full AppShell without opening the dropdown proves the
// component renders fine.
import { describe, expect, it } from "vitest";

import { computeMyScheduledTasks } from "@/components/app-shell";
import { addProject, addTask, baseState } from "./_support";

describe("computeMyScheduledTasks (components/app-shell.tsx) — schedule export respects project visibility (F1)", () => {
  it("omits a task from a project the user (a revoked collaborator) can no longer see", () => {
    let state = addProject(baseState(), {
      id: "p_shell_revoked",
      name: "Shell Revoked",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_sam", level: "editor" }], // maya not listed
    });
    state = addTask(state, {
      id: "t_shell_revoked",
      projectId: "p_shell_revoked",
      title: "Stale collaborator task",
      createdBy: "u_sam",
      assigneeId: "u_sam",
      collaboratorIds: ["u_maya"], // stale — maya isn't a project member
      dueDate: Date.now() + 24 * 60 * 60 * 1000,
    });

    const exported = computeMyScheduledTasks(state, "u_maya");
    expect(exported.some((t) => t.id === "t_shell_revoked")).toBe(false);
  });

  it("includes a task from a project the user can still see", () => {
    let state = addProject(baseState(), {
      id: "p_shell_visible",
      name: "Shell Visible",
      createdBy: "u_sam",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_shell_visible",
      projectId: "p_shell_visible",
      title: "Visible collaborator task",
      createdBy: "u_sam",
      assigneeId: "u_sam",
      collaboratorIds: ["u_maya"],
      dueDate: Date.now() + 24 * 60 * 60 * 1000,
    });

    const exported = computeMyScheduledTasks(state, "u_maya");
    expect(exported.some((t) => t.id === "t_shell_visible")).toBe(true);
  });

  it("still excludes a task with no due date, same as before this fix", () => {
    let state = addProject(baseState(), {
      id: "p_shell_nodue",
      name: "Shell No Due",
      createdBy: "u_sam",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_shell_nodue",
      projectId: "p_shell_nodue",
      title: "No due date",
      createdBy: "u_sam",
      assigneeId: "u_maya",
      dueDate: null,
    });

    const exported = computeMyScheduledTasks(state, "u_maya");
    expect(exported.some((t) => t.id === "t_shell_nodue")).toBe(false);
  });
});
