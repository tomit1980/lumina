// @vitest-environment jsdom
//
// QA-118 (Medium) — every hover during a drag issued its own `moveTask`, and
// the calls were not ordered.
//
// `onDragOver` fires on every transition into a different column and called
// `void moveTask(...)` there and then: no ordering, no cancellation, no
// coalescing. Dragging a card across three columns issued three `move_task`
// RPCs as independent HTTP requests, so they could arrive out of order and
// the last to ARRIVE won — leaving the board showing a column the user merely
// passed through rather than the one they dropped on, once the next reload
// landed. Optimistically the card follows the cursor and looks right; the
// divergence only appears afterwards, which is the pattern people report as
// "it jumped back on its own".
//
// Each RPC also publishes a `tasks` change to every connected client, so one
// drag cost every other browser several coalesced whole-workspace reloads.
import * as React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StoreProvider } from "@/lib/store";
import { LocalBackend, STORAGE_KEY } from "@/lib/backend/local";
import { useTaskDnd, COLUMN_PREFIX } from "@/components/kanban/use-task-dnd";
import { addProject, addTask, adminState } from "./_support";
import type { AppState, TaskStatus } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Records the order `moveTask` reaches the backend, and holds each call open
 *  until the test lets it finish — the only way to see whether the next one
 *  was issued before the previous had settled. */
class SlowMoveBackend extends LocalBackend {
  readonly started: Array<{ status: TaskStatus; index: number }> = [];
  private release: Array<() => void> = [];

  // A REST parameter, not the three named ones this is really called with.
  // `LocalBackend.moveTask` declares NO parameters on purpose — it is one of
  // the seam's deliberate no-ops, since the demo writes the whole workspace
  // as one blob, and lib/backend/types.ts is where the contract's parameters
  // are named. TypeScript lets an override take FEWER arguments than its base
  // but not more, so a typed three-parameter override is rejected outright
  // (the other doubles in _support.ts all take none). A rest parameter is
  // assignable and still lets this one read what it was handed.
  override moveTask(...args: unknown[]): Promise<void> {
    this.started.push({ status: args[1] as TaskStatus, index: args[2] as number });
    return new Promise<void>((resolve) => {
      this.release.push(resolve);
    });
  }

  /** Lets every call issued so far complete. */
  flush() {
    const pending = this.release;
    this.release = [];
    for (const go of pending) go();
  }
}

function board(): AppState {
  let state = addProject(adminState(), {
    id: "p_drag",
    name: "Drag",
    createdBy: "u_vlad",
    restricted: false,
  });
  state = addTask(state, {
    id: "t_drag",
    projectId: "p_drag",
    title: "Dragged",
    status: "todo",
    createdBy: "u_vlad",
  });
  return state;
}

async function mountDnd(backend: SlowMoveBackend) {
  const state = board();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const tasks = state.tasks.filter((t) => t.projectId === "p_drag");
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(StoreProvider, { backend }, children);
  let handle!: ReturnType<typeof renderHook<ReturnType<typeof useTaskDnd>, unknown>>;
  await act(async () => {
    handle = renderHook(() => useTaskDnd(tasks), { wrapper });
  });
  return handle;
}

const over = (status: string) =>
  ({ active: { id: "t_drag" }, over: { id: `${COLUMN_PREFIX}${status}` } }) as never;

describe("a drag across several columns (QA-118)", () => {
  it("does not issue the next move until the previous one has settled", async () => {
    const backend = new SlowMoveBackend();
    const { result } = await mountDnd(backend);

    await act(async () => {
      result.current.onDragStart({ active: { id: "t_drag" } } as never);
      result.current.onDragOver(over("in-progress"));
      result.current.onDragOver(over("in-review"));
      result.current.onDragOver(over("done"));
    });

    // THE ASSERTION. Unchained, all three were in flight at once and the
    // server saw whichever arrived first. Chained, only the first has been
    // issued and the rest are waiting their turn — so the order the user
    // dragged in is the order the server gets.
    expect(backend.started).toHaveLength(1);
    expect(backend.started[0].status).toBe("in-progress");

    await act(async () => {
      backend.flush();
    });
    expect(backend.started.map((c) => c.status)).toEqual(["in-progress", "in-review"]);
  });

  it("drops a repeat of the move it just made — hesitating over a boundary is free", async () => {
    const backend = new SlowMoveBackend();
    const { result } = await mountDnd(backend);

    await act(async () => {
      result.current.onDragStart({ active: { id: "t_drag" } } as never);
      result.current.onDragOver(over("done"));
    });
    await act(async () => {
      backend.flush();
    });
    const afterFirst = backend.started.length;

    await act(async () => {
      result.current.onDragOver(over("done"));
      result.current.onDragOver(over("done"));
    });
    await act(async () => {
      backend.flush();
    });

    expect(backend.started).toHaveLength(afterFirst);
  });

  it("CONTROL: a genuinely different target still gets sent", async () => {
    // Without this, a hook that sent nothing after the first move would
    // satisfy both tests above while breaking dragging entirely.
    const backend = new SlowMoveBackend();
    const { result } = await mountDnd(backend);

    await act(async () => {
      result.current.onDragStart({ active: { id: "t_drag" } } as never);
      result.current.onDragOver(over("done"));
    });
    await act(async () => {
      backend.flush();
    });
    await act(async () => {
      result.current.onDragOver(over("backlog"));
    });
    await act(async () => {
      backend.flush();
    });

    expect(backend.started.map((c) => c.status)).toContain("backlog");
  });
});
