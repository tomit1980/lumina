"use client";

import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { format, isPast, isToday } from "date-fns";
import { CalendarDays, Circle, CircleCheck, Flag } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PeopleStack } from "@/components/kanban/people-stack";
import { taskEvent } from "@/lib/calendar";
import { useStore } from "@/lib/store";
import { PRIORITY_META, type Task, type User } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TaskCardContent({
  task,
  assignee,
  className,
  onClose,
}: {
  task: Task;
  assignee: User | undefined;
  className?: string;
  /** Quick complete/reopen toggle. Omitted on read-only cards and the drag overlay. */
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
  const hasPeople = !!assignee || collaborators.length > 0;

  return (
    <div
      className={cn(
        "group/card relative flex flex-col gap-2 rounded-xl border bg-card p-3 shadow-xs transition-shadow hover:shadow-md",
        className
      )}
    >
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
                "absolute top-2 right-2 flex size-5 items-center justify-center rounded-full transition",
                isDone
                  ? "text-emerald-500 opacity-100"
                  : "text-muted-foreground opacity-0 group-hover/card:opacity-100 hover:text-emerald-500 focus-visible:opacity-100"
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
      <div className={cn("flex items-start gap-2", onClose && "pr-5")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Flag
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                PRIORITY_META[task.priority].className
              )}
            />
          </TooltipTrigger>
          <TooltipContent>{PRIORITY_META[task.priority].label} priority</TooltipContent>
        </Tooltip>
        <p
          className={cn(
            "text-[13px] leading-snug font-medium",
            task.status === "done" && "text-muted-foreground line-through decoration-muted-foreground/50"
          )}
        >
          {task.title}
        </p>
      </div>

      {(task.dueDate !== null || hasPeople) && (
        <div className="flex items-center justify-between">
          {task.dueDate !== null ? (
            <span
              className={cn(
                "flex items-center gap-1 text-[11px]",
                overdue
                  ? "font-medium text-red-500"
                  : "text-muted-foreground"
              )}
            >
              <CalendarDays className="size-3" />
              {isToday(task.dueDate) ? "Today" : format(task.dueDate, "MMM d")}
              {timeLabel && ` · ${timeLabel}`}
              {overdue && " · overdue"}
            </span>
          ) : (
            <span />
          )}
          <PeopleStack owner={assignee} collaborators={collaborators} />
        </div>
      )}
    </div>
  );
}

export function SortableTaskCard({
  task,
  assignee,
  disabled,
  onOpen,
  onClose,
}: {
  task: Task;
  assignee: User | undefined;
  disabled: boolean;
  onOpen: (taskId: string) => void;
  /** Quick complete/reopen. Only offered when the card is interactive. */
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
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      {...attributes}
      {...listeners}
      onClick={() => {
        if (!isDragging) onOpen(task.id);
      }}
      className={cn(
        "outline-none",
        disabled ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40"
      )}
    >
      <TaskCardContent
        task={task}
        assignee={assignee}
        className={cn(isDragging && "border-dashed border-primary/40 bg-primary/5")}
        onClose={!disabled && onClose ? () => onClose(task.id) : undefined}
      />
    </div>
  );
}
