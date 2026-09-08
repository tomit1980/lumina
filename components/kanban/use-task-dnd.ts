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
import { TASK_STATUSES, type Task, type TaskStatus } from "@/lib/types";

export const COLUMN_PREFIX = "column:";

/** Shared drag & drop behavior for task collections (board and list views).
 *  Droppable containers must use the id `column:<status>`; draggables use task ids. */
export function useTaskDnd(tasks: Task[]) {
  const { moveTask } = useStore();
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const byStatus = React.useMemo(() => {
    const map = Object.fromEntries(
      TASK_STATUSES.map((s) => [s, [] as Task[]])
    ) as Record<TaskStatus, Task[]>;
    for (const t of [...tasks].sort((a, b) => a.order - b.order)) {
      map[t.status].push(t);
    }
    return map;
  }, [tasks]);

  const findStatus = (id: string): TaskStatus | null => {
    if (id.startsWith(COLUMN_PREFIX)) {
      return id.slice(COLUMN_PREFIX.length) as TaskStatus;
    }
    return tasks.find((t) => t.id === id)?.status ?? null;
  };

  const onDragStart = (event: DragStartEvent) => {
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
    void moveTask(activeId, overStatus, overIndex < 0 ? overColumn.length : overIndex);
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
    const overIndex = column.findIndex((t) => t.id === overId);
    if (overIndex >= 0) void moveTask(activeId, overStatus, overIndex);
  };

  const onDragCancel = () => setActiveTask(null);

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
