"use client";

import * as React from "react";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

import { useStore } from "@/lib/store";
import { sortedStatuses } from "@/lib/statuses";
import type { Task, TaskStatus } from "@/lib/types";

export const COLUMN_PREFIX = "column:";

/** A column's cards in display order. Within one project that is `order`;
 *  across projects it is project name, then `order`, so a client's cards sit
 *  together and no two projects' 0,1,2… interleave. */
export function orderColumn(
  tasks: Task[],
  crossProject: boolean,
  projectName: (t: Task) => string
): Task[] {
  const byOrder = (a: Task, b: Task) => a.order - b.order;
  if (!crossProject) return [...tasks].sort(byOrder);
  return [...tasks].sort((a, b) => projectName(a).localeCompare(projectName(b)) || byOrder(a, b));
}

/** The index `moveTask` applies is within the task's own project's slice of
 *  the destination column. A drop index computed over a merged column is not
 *  that number. */
export function indexWithinProject(destination: Task[], task: Task, dropIndex: number): number {
  return destination
    .slice(0, Math.max(0, dropIndex))
    .filter((t) => t.projectId === task.projectId && t.id !== task.id).length;
}

/** Shared drag & drop behavior for task collections (board and list views).
 *  Droppable containers must use the id `column:<status>`; draggables use task ids.
 *  `crossProject` groups a merged column by `projectName` for display, and
 *  converts a drop index measured over that merged column into the index
 *  `moveTask` needs — the position within the dragged task's own project. */
export function useTaskDnd(
  tasks: Task[],
  opts: { crossProject?: boolean; projectName?: (t: Task) => string } = {}
) {
  const { crossProject = false, projectName = () => "" } = opts;
  const { state, moveTask } = useStore();
  // The workspace's columns, not a module constant — an Owner can rename,
  // add, remove and reorder them, and a drag has to be against the set that
  // is actually on screen.
  const statuses = React.useMemo(() => sortedStatuses(state.statuses), [state.statuses]);
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const byStatus = React.useMemo(() => {
    const map = Object.fromEntries(
      statuses.map((s) => [s.id, [] as Task[]])
    ) as Record<TaskStatus, Task[]>;
    for (const t of orderColumn(tasks, crossProject, projectName)) {
      // A task whose status no longer exists has no column to sit in. It is
      // skipped here rather than crashing on `map[undefined].push`; the
      // database refuses to delete a status that still holds work, so this
      // is the belt to that braces.
      map[t.status]?.push(t);
    }
    return map;
  }, [tasks, statuses, crossProject, projectName]);

  /**
   * Moves issued by this drag, in order, with repeats dropped (QA-118).
   *
   * `onDragOver` fires on every transition into a different column and used
   * to call `void moveTask(...)` there and then: no ordering, no
   * cancellation, no coalescing. Dragging a card across three columns issued
   * three `move_task` RPCs as independent HTTP requests, so they could arrive
   * out of order and the last to ARRIVE won — leaving the board showing a
   * column the user merely passed through rather than the one they dropped
   * on, once the next reload landed. That is the shape people report as "it
   * jumped back on its own". `commit`'s `writeSeq` orders the store's
   * snapshots; it does not order the network.
   *
   * Each RPC also publishes a `tasks` change to every connected client, so
   * one drag cost every other browser several coalesced whole-workspace
   * reloads.
   *
   * Chaining is what fixes the ordering — the next call is not issued until
   * the previous one settles, so the server sees them in the order the user
   * made them — and `lastSent` is what stops a hesitation over a boundary
   * from re-issuing the move it just made. A failure does not break the
   * chain: the store has already toasted and rolled back, and the rest of
   * the drag should still be delivered.
   */
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  const lastSent = React.useRef<{ id: string; status: TaskStatus; index: number } | null>(
    null
  );

  const enqueueMove = (id: string, status: TaskStatus, index: number) => {
    const previous = lastSent.current;
    if (previous && previous.id === id && previous.status === status && previous.index === index) {
      return;
    }
    lastSent.current = { id, status, index };
    queue.current = queue.current.then(
      () => moveTask(id, status, index),
      () => moveTask(id, status, index)
    );
  };

  const findStatus = (id: string): TaskStatus | null => {
    if (id.startsWith(COLUMN_PREFIX)) {
      return id.slice(COLUMN_PREFIX.length) as TaskStatus;
    }
    return tasks.find((t) => t.id === id)?.status ?? null;
  };

  const onDragStart = (event: DragStartEvent) => {
    // A new drag makes no claim about what the last one sent.
    lastSent.current = null;
    setActiveTask(tasks.find((t) => t.id === event.active.id) ?? null);
  };

  const onDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const activeStatus = findStatus(activeId);
    const overStatus = findStatus(overId);
    if (!activeStatus || !overStatus || activeStatus === overStatus) return;

    // Crossing into another status: insert at the hovered task's slot,
    // or at the end when hovering the container itself.
    const overColumn = byStatus[overStatus];
    const overIndex = overId.startsWith(COLUMN_PREFIX)
      ? overColumn.length
      : overColumn.findIndex((t) => t.id === overId);
    enqueueMove(activeId, overStatus, overIndex < 0 ? overColumn.length : overIndex);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    const activeStatus = findStatus(activeId);
    const overStatus = findStatus(overId);
    if (!activeStatus || !overStatus || activeStatus !== overStatus) return;
    if (activeId === overId || overId.startsWith(COLUMN_PREFIX)) return;

    // Reorder within the same status.
    const column = byStatus[overStatus];
    const rawIndex = column.findIndex((t) => t.id === overId);
    if (rawIndex < 0) return;
    // `rawIndex` is a position in the merged, display-ordered column. On a
    // single-project board that IS the index `moveTask` needs. On a
    // cross-project board the column interleaves several projects' dense
    // 0..n-1 runs, so it has to be converted down to the position among just
    // this task's own project's cards before it means anything to `moveTask`.
    const task = tasks.find((t) => t.id === activeId);
    const index =
      crossProject && task ? indexWithinProject(column, task, rawIndex) : rawIndex;
    enqueueMove(activeId, overStatus, index);
  };

  const onDragCancel = () => {
    lastSent.current = null;
    setActiveTask(null);
  };

  return {
    sensors,
    activeTask,
    byStatus,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDragCancel,
  };
}
