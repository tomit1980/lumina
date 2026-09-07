"use client";

import {
  DndContext,
  DragOverlay,
  closestCorners,
  useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { format, isPast, isToday } from "date-fns";
import { CalendarDays, Circle, CircleCheck, Flag, GripVertical } from "lucide-react";
import { toast } from "sonner";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PeopleStack } from "@/components/kanban/people-stack";
import { taskEvent } from "@/lib/calendar";
import { COLUMN_PREFIX, useTaskDnd } from "@/components/kanban/use-task-dnd";
import { useUI } from "@/components/ui-context";
import { useStore } from "@/lib/store";
import {
  PRIORITY_META,
  STATUS_META,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
  type User,
} from "@/lib/types";
import { cn } from "@/lib/utils";

function TaskRowContent({
  task,
  assignee,
  showGrip,
  onClose,
}: {
  task: Task;
  assignee: User | undefined;
  showGrip: boolean;
  /** Quick complete/reopen toggle. Omitted on read-only rows and the drag overlay. */
  onClose?: () => void;
}) {
  const isDone = task.status === "done";
  const overdue =
    task.dueDate !== null &&
    task.status !== "done" &&
    isPast(task.dueDate) &&
    !isToday(task.dueDate);

  const ev = taskEvent(task);
  const timeLabel = ev && !ev.allDay ? format(ev.start, "p") : null;

  const { state } = useStore();
  const collaborators = task.collaboratorIds
    .map((id) => state.users.find((u) => u.id === id))
    .filter((u): u is User => u !== undefined);

  return (
    <div className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
      <GripVertical
        className={cn(
          "-ml-1.5 size-3.5 shrink-0 text-muted-foreground/40",
          showGrip
            ? "opacity-0 transition-opacity group-hover/row:opacity-100"
            : "invisible"
        )}
      />
      <Flag
        className={cn("size-3.5 shrink-0", PRIORITY_META[task.priority].className)}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px] font-medium",
          task.status === "done" && "text-muted-foreground line-through"
        )}
      >
        {task.title}
      </span>
      {task.dueDate !== null && (
        <span
          className={cn(
            "flex items-center gap-1 text-[11px]",
            overdue ? "font-medium text-red-500" : "text-muted-foreground"
          )}
        >
          <CalendarDays className="size-3" />
          {isToday(task.dueDate) ? "Today" : format(task.dueDate, "MMM d")}
          {timeLabel && ` · ${timeLabel}`}
        </span>
      )}
      {assignee || collaborators.length > 0 ? (
        <PeopleStack owner={assignee} collaborators={collaborators} />
      ) : (
        <span className="size-6 rounded-full border border-dashed" />
      )}
      {onClose && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={isDone ? "Reopen task" : "Mark task as done"}
              // Don't let the press start a drag or open the task dialog.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full transition",
                isDone
                  ? "text-emerald-500"
                  : "text-muted-foreground/50 opacity-0 group-hover/row:opacity-100 hover:text-emerald-500 focus-visible:opacity-100"
              )}
            >
              {isDone ? (
                <CircleCheck className="size-4" />
              ) : (
                <Circle className="size-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>{isDone ? "Reopen" : "Mark as done"}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function SortableTaskRow({
  task,
  assignee,
  disabled,
  isFirst,
  onOpen,
  onClose,
}: {
  task: Task;
  assignee: User | undefined;
  disabled: boolean;
  isFirst: boolean;
  onOpen: (taskId: string) => void;
  /** Quick complete/reopen. Only offered when the row is interactive. */
  onClose?: (taskId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled, data: { type: "task", task } });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => {
        if (!isDragging) onOpen(task.id);
      }}
      className={cn(
        "group/row bg-card transition-colors hover:bg-muted/50",
        !isFirst && "border-t",
        disabled ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40"
      )}
    >
      <TaskRowContent
        task={task}
        assignee={assignee}
        showGrip={!disabled}
        onClose={!disabled && onClose ? () => onClose(task.id) : undefined}
      />
    </div>
  );
}

function StatusSection({
  status,
  tasks,
  canMove,
  onOpen,
  onClose,
}: {
  status: TaskStatus;
  tasks: Task[];
  canMove: boolean;
  onOpen: (taskId: string) => void;
  onClose: (taskId: string) => void;
}) {
  const { state } = useStore();
  const { setNodeRef, isOver } = useDroppable({
    id: `${COLUMN_PREFIX}${status}`,
    data: { type: "column", status },
  });

  // View-only users don't need empty drop targets.
  if (tasks.length === 0 && !canMove) return null;

  return (
    <section className="mb-6">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <span className={cn("size-2 rounded-full", STATUS_META[status].dot)} />
        <h3 className="text-[13px] font-semibold">{STATUS_META[status].label}</h3>
        <span className="text-[11px] text-muted-foreground">{tasks.length}</span>
      </div>
      <SortableContext
        items={tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={cn(
            "overflow-hidden rounded-xl border transition-all",
            isOver && "border-primary/40 ring-1 ring-primary/25"
          )}
        >
          {tasks.map((task, i) => (
            <SortableTaskRow
              key={task.id}
              task={task}
              assignee={state.users.find((u) => u.id === task.assigneeId)}
              disabled={!canMove}
              isFirst={i === 0}
              onOpen={onOpen}
              onClose={onClose}
            />
          ))}
          {tasks.length === 0 && (
            <div
              className={cn(
                "flex h-11 items-center justify-center border border-dashed text-[11px] text-muted-foreground/60",
                "-m-px rounded-xl"
              )}
            >
              Drop tasks here
            </div>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

export function ListView({
  tasks,
  viewerOnly = false,
}: {
  tasks: Task[];
  /** Read-only override — e.g. the current user only has viewer access to this project. */
  viewerOnly?: boolean;
}) {
  const { state, can, moveTask } = useStore();
  const { openTaskDialog } = useUI();
  const dnd = useTaskDnd(tasks);

  const canMove = can("task.move") && !viewerOnly;

  // Quick "close" from a row: complete it (or reopen a done task), appending
  // to the destination status. Only reachable when canMove, matching drag.
  const closeTask = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const toStatus: TaskStatus = task.status === "done" ? "todo" : "done";
    moveTask(taskId, toStatus, Number.MAX_SAFE_INTEGER);
    toast(
      toStatus === "done"
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
      <div className="h-full overflow-y-auto px-6 pt-4 pb-6">
        {TASK_STATUSES.map((status) => (
          <StatusSection
            key={status}
            status={status}
            tasks={dnd.byStatus[status]}
            canMove={canMove}
            onOpen={(taskId) => openTaskDialog({ taskId })}
            onClose={closeTask}
          />
        ))}
        {tasks.length === 0 && (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No tasks match the current filters.
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={{ duration: 180 }}>
        {dnd.activeTask && (
          <div className="overflow-hidden rounded-xl border bg-card shadow-xl ring-1 ring-primary/30">
            <TaskRowContent
              task={dnd.activeTask}
              assignee={state.users.find((u) => u.id === dnd.activeTask?.assigneeId)}
              showGrip={false}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
