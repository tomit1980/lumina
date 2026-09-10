"use client";

import {
  DndContext,
  DragOverlay,
  closestCorners,
  useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SortableTaskCard, TaskCardContent } from "@/components/kanban/task-card";
import { COLUMN_PREFIX, useTaskDnd } from "@/components/kanban/use-task-dnd";
import { useUI } from "@/components/ui-context";
import { isDone, firstOpenStatus, sortedStatuses } from "@/lib/statuses";
import { useStore } from "@/lib/store";
import {
  type Project,
  type StatusDef,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

function Column({
  project,
  status,
  tasks,
  canCreate,
  canMove,
  onOpen,
  onClose,
}: {
  project: Project;
  /** The whole column, not its id: the header needs its name and colour, and
   *  both are workspace-editable now. */
  status: StatusDef;
  tasks: Task[];
  canCreate: boolean;
  canMove: boolean;
  onOpen: (taskId: string) => void;
  onClose: (taskId: string) => void;
}) {
  const { state } = useStore();
  const { openTaskDialog } = useUI();
  const { setNodeRef, isOver } = useDroppable({
    id: `${COLUMN_PREFIX}${status.id}`,
    data: { type: "column", status: status.id },
  });

  return (
    <div className="flex w-68 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        {/* Inline style, not a Tailwind class: the colour is user-chosen and
            Tailwind only ships classes it can see at build time. */}
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: status.color }}
        />
        <h3 className="text-[13px] font-semibold">{status.name}</h3>
        <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
          {tasks.length}
        </span>
        {canCreate && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-6 text-muted-foreground hover:text-foreground"
            onClick={() => openTaskDialog({ projectId: project.id, status: status.id })}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>

      <SortableContext
        items={tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={cn(
            "flex min-h-24 flex-1 flex-col gap-2 rounded-xl bg-muted/40 p-2 transition-colors",
            isOver && "bg-primary/8 ring-1 ring-primary/25"
          )}
        >
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              assignee={state.users.find((u) => u.id === task.assigneeId)}
              disabled={!canMove}
              onOpen={onOpen}
              onClose={onClose}
            />
          ))}
          {tasks.length === 0 && (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed text-[11px] text-muted-foreground/60">
              {canMove ? "Drop tasks here" : "Nothing here yet"}
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

export function Board({
  project,
  tasks,
  viewerOnly = false,
}: {
  project: Project;
  tasks: Task[];
  /** Read-only override — e.g. the current user only has viewer access to this project. */
  viewerOnly?: boolean;
}) {
  const { state, can, moveTask } = useStore();
  const { openTaskDialog } = useUI();
  const dnd = useTaskDnd(tasks);

  const canMove = can("task.move") && !viewerOnly;
  const canCreate = can("task.create") && !viewerOnly;

  // Quick "close" from a card: complete it (or reopen a done task), appending
  // to the destination column. Only reachable when canMove, matching drag.
  const closeTask = async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    // The done column and the first open one, both read from the workspace's
    // own statuses — this used to be `task.status === "done" ? "todo" : "done"`,
    // which broke the moment a team renamed either column.
    const doneId = state.statuses.find((s) => s.isDone)?.id;
    const reopenId = firstOpenStatus(state.statuses);
    const target = isDone(state, task.status) ? reopenId : doneId;
    if (!target) return;
    const toStatus: TaskStatus = target;
    // QA-122: `moveTask` now reports whether the write survived, so this
    // stops announcing a move the store refused or rolled back. The refusal
    // already has its own toast; a second, contradictory one is the failure
    // this seam exists to remove.
    if (!(await moveTask(taskId, toStatus, Number.MAX_SAFE_INTEGER))) return;
    toast(
      toStatus === doneId
        ? `“${task.title}” marked as done`
        : `“${task.title}” reopened`
    );
  };

  return (
    <DndContext
      sensors={dnd.sensors}
      collisionDetection={closestCorners}
      onDragStart={dnd.onDragStart}
      onDragOver={dnd.onDragOver}
      onDragEnd={dnd.onDragEnd}
      onDragCancel={dnd.onDragCancel}
    >
      <div className="flex h-full gap-4 overflow-x-auto px-6 pt-4 pb-6">
        {sortedStatuses(state.statuses).map((status) => (
          <Column
            key={status.id}
            project={project}
            status={status}
            tasks={dnd.byStatus[status.id] ?? []}
            canCreate={canCreate}
            canMove={canMove}
            onOpen={(taskId) => openTaskDialog({ taskId })}
            onClose={closeTask}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={{ duration: 180 }}>
        {dnd.activeTask && (
          <TaskCardContent
            task={dnd.activeTask}
            assignee={state.users.find((u) => u.id === dnd.activeTask?.assigneeId)}
            className="rotate-2 shadow-xl ring-1 ring-primary/30"
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}
