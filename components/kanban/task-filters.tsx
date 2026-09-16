"use client";

import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isMine } from "@/lib/permissions";
import { useStore } from "@/lib/store";
import { PRIORITIES, PRIORITY_META, type Priority, type Task } from "@/lib/types";

/** The two narrowing controls a board or list shows above its tasks. */
export function applyTaskFilters(
  tasks: Task[],
  assignee: string,
  priority: string
): Task[] {
  return tasks.filter(
    (t) =>
      (assignee === "all" ||
        (assignee === "unassigned" ? t.assigneeId === null : isMine(t, assignee))) &&
      (priority === "all" || t.priority === priority)
  );
}

export function TaskFilters({
  assignee,
  onAssignee,
  priority,
  onPriority,
}: {
  assignee: string;
  onAssignee: (v: string) => void;
  priority: string;
  onPriority: (v: string) => void;
}) {
  const { state } = useStore();
  return (
    <>
      <Select value={assignee} onValueChange={onAssignee}>
        <SelectTrigger size="sm" className="h-8 w-36 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Everyone</SelectItem>
          <SelectItem value="unassigned">Unassigned</SelectItem>
          {state.users.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={priority} onValueChange={onPriority}>
        <SelectTrigger size="sm" className="h-8 w-32 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All priorities</SelectItem>
          {PRIORITIES.map((p: Priority) => (
            <SelectItem key={p} value={p}>
              {PRIORITY_META[p].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
