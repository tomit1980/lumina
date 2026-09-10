// @vitest-environment jsdom
//
// The board's columns became rows, and this is the test that says why it was
// worth doing: a workspace can rename them and everything that used to test
// the literal `"done"` keeps working.
//
// Before this, `"done"` was a string compared in eighteen places across eight
// files — the open-task filter, the completed count, the progress bar,
// reminder suppression, the quick-complete toggles in two views, the overdue
// guard, the strike-through, and the activity feed's "completed" line. None
// shared a helper. A team that renamed the column to "Shipped" would have got
// a progress bar stuck at zero, reminders firing for finished work, and no
// strike-through — none of it failing loudly enough to notice.
//
// `"todo"` had the same problem in miniature, as the hardcoded target for
// reopening a task and for creating one.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATUSES,
  fallbackStatus,
  firstOpenStatus,
  isDoneStatus,
  sortedStatuses,
  statusById,
} from "@/lib/statuses";
import type { StatusDef } from "@/lib/types";

/** The seeded set with every column renamed and nothing else touched — the
 *  exact change an Owner makes, and the one the old literals could not see. */
function renamed(): StatusDef[] {
  const names: Record<string, string> = {
    backlog: "Icebox",
    todo: "Up Next",
    "in-progress": "Building",
    "in-review": "Checking",
    done: "Shipped",
  };
  return DEFAULT_STATUSES.map((s) => ({ ...s, name: names[s.id] }));
}

describe("the seeded columns", () => {
  it("preserve the five ids exactly — the decision the whole change rests on", () => {
    // Not cosmetic. ~160 status literals across 21 test files are still valid
    // only because these ids did not move; if this fails, the change is a
    // rewrite rather than a contained edit.
    expect(DEFAULT_STATUSES.map((s) => s.id)).toEqual([
      "backlog",
      "todo",
      "in-progress",
      "in-review",
      "done",
    ]);
  });

  it("carry exactly one done column", () => {
    expect(DEFAULT_STATUSES.filter((s) => s.isDone).map((s) => s.id)).toEqual(["done"]);
  });

  it("use hex colours, not Tailwind classes", () => {
    // A workspace-chosen colour cannot be a Tailwind class: Tailwind only
    // ships classes it can see at build time, so `bg-${something}` renders
    // as nothing at all. The old STATUS_META held `bg-sky-500` and friends.
    for (const s of DEFAULT_STATUSES) {
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("renaming a column changes nothing but its name", () => {
  it("still finds the done column", () => {
    const after = renamed();
    expect(isDoneStatus(after, "done")).toBe(true);
    expect(statusById(after, "done")?.name).toBe("Shipped");
  });

  it("still resolves a reopen target", () => {
    expect(firstOpenStatus(renamed())).toBe("backlog");
  });

  it("CONTROL: an open column is still open, so this is not just 'everything is done'", () => {
    // Without this, an `isDoneStatus` that answered true for everything would
    // pass the test above while breaking every count in the app.
    const after = renamed();
    expect(isDoneStatus(after, "todo")).toBe(false);
    expect(isDoneStatus(after, "in-progress")).toBe(false);
  });
});

describe("a workspace that has reshaped its board entirely", () => {
  const custom: StatusDef[] = [
    { id: "s_ship", name: "Shipped", color: "#10b981", position: 2, isDone: true },
    { id: "s_ice", name: "Icebox", color: "#a1a1aa", position: 0, isDone: false },
    { id: "s_go", name: "Building", color: "#f59e0b", position: 1, isDone: false },
  ];

  it("orders columns by position, not by declaration or id", () => {
    expect(sortedStatuses(custom).map((s) => s.id)).toEqual(["s_ice", "s_go", "s_ship"]);
  });

  it("reopens into the first open column even with no status called todo", () => {
    // The old code sent every reopened task to the literal "todo". In this
    // workspace there is no such column, so it would have written a status
    // the database now refuses outright.
    expect(firstOpenStatus(custom)).toBe("s_ice");
  });

  it("falls back to the first column when a status does not resolve", () => {
    expect(fallbackStatus(custom)).toBe("s_ice");
  });

  it("treats an unknown status as open work, not as finished", () => {
    // The safe direction: a task whose status cannot be resolved stays
    // visible and countable rather than silently joining the completed pile.
    expect(isDoneStatus(custom, "s_deleted")).toBe(false);
  });
});

describe("a board with no open column at all", () => {
  it("has no reopen target rather than inventing one", () => {
    const onlyDone: StatusDef[] = [
      { id: "done", name: "Done", color: "#10b981", position: 0, isDone: true },
    ];
    // The callers check for this and refuse the toggle. Returning some
    // arbitrary column would move the task somewhere nobody asked for.
    expect(firstOpenStatus(onlyDone)).toBeUndefined();
    expect(fallbackStatus(onlyDone)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// And the same thing through the app, because the helpers being right is not
// the claim — the claim is that a rename reaches the screen. The home page's
// "Open tasks" count is a good witness: it used to filter on `status !== "done"`
// and would have counted a finished task as open the moment the column was
// renamed.
// ---------------------------------------------------------------------------
describe("a renamed done column, through the store", () => {
  it("keeps a finished task out of the open-task count", async () => {
    const { addProject, addTask, adminState, mount } = await import("./_support");

    let state = addProject(adminState(), {
      id: "p_rename",
      name: "Renamed",
      createdBy: "u_vlad",
      restricted: false,
    });
    state = addTask(state, {
      id: "t_shipped",
      projectId: "p_rename",
      title: "Finished work",
      status: "done",
      createdBy: "u_vlad",
      assigneeId: "u_vlad",
    });
    state = addTask(state, {
      id: "t_open",
      projectId: "p_rename",
      title: "Unfinished work",
      status: "todo",
      createdBy: "u_vlad",
      assigneeId: "u_vlad",
    });
    // The rename: the id stays `done`, only the name changes — exactly what
    // an Owner does, and exactly what the old literal could not survive.
    state = {
      ...state,
      statuses: state.statuses.map((s) =>
        s.id === "done" ? { ...s, name: "Shipped" } : s
      ),
    };

    const { result } = await mount(state);
    // Scoped to this project: `adminState()` is the full seed and brings a
    // board's worth of tasks of its own.
    const open = result.current.state.tasks.filter(
      (t) =>
        t.projectId === "p_rename" &&
        !isDoneStatus(result.current.state.statuses, t.status)
    );

    expect(open.map((t) => t.id)).toEqual(["t_open"]);
    // CONTROL: the renamed column really is renamed, so this is not passing
    // because the rename silently failed to apply.
    expect(
      result.current.state.statuses.find((s) => s.id === "done")?.name
    ).toBe("Shipped");
  });
});

// ---------------------------------------------------------------------------
// And on the screen, which is the claim that actually matters. The store
// holding the right name proves nothing if the board still renders the old
// one — and the board is the whole reason a team would rename a column.
//
// A render test rather than a browser pass: the preview pane could not focus
// the rename field reliably, and a test that depends on synthetic clicks
// landing is a test that will fail for reasons unrelated to the code.
// ---------------------------------------------------------------------------
describe("a renamed column on the board itself", () => {
  it("shows the new name as the column header", async () => {
    const React = await import("react");
    const { screen } = await import("@testing-library/react");
    const { Board } = await import("@/components/kanban/board");
    const { StoreProvider } = await import("@/lib/store");
    const { UIProvider } = await import("@/components/ui-context");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { STORAGE_KEY } = await import("@/lib/backend/local");
    const { addProject, adminState, renderHydrated } = await import("./_support");

    const state = addProject(adminState(), {
      id: "p_board",
      name: "Board",
      createdBy: "u_vlad",
      restricted: false,
    });
    const renamedState = {
      ...state,
      statuses: state.statuses.map((s) =>
        s.id === "in-review" ? { ...s, name: "Checking" } : s
      ),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(renamedState));
    const project = renamedState.projects.find((p) => p.id === "p_board")!;

    await renderHydrated(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(
            UIProvider,
            null,
            React.createElement(Board, { project, tasks: [] })
          )
        )
      )
    );

    // The new name is on the board...
    expect(await screen.findByText("Checking")).toBeTruthy();
    // ...and the old one is not, which is the half that would have failed
    // when every column header read from a hardcoded STATUS_META.
    expect(screen.queryByText("In Review")).toBeNull();
    // CONTROL: the columns nobody renamed are untouched, so this is not
    // passing because the board stopped rendering headers.
    expect(screen.getByText("Backlog")).toBeTruthy();
  });
});
