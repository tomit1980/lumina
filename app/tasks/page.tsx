"use client";

import * as React from "react";

import { Board } from "@/components/kanban/board";
import { TaskFilters, applyTaskFilters } from "@/components/kanban/task-filters";
import { canUserSeeTaskProject, useStore } from "@/lib/store";

/**
 * Every task the person can see, across every project, on one board.
 *
 * Same six columns as a project board — statuses are workspace-wide — with
 * each card prefixed by its project. No per-column add buttons, because there
 * is no project to add to; open a card to reach its project. Cards from a
 * project this person may only view are not draggable, and the store refuses
 * the move anyway if the screen is wrong about that.
 */
export default function AllTasksPage() {
  const { state, currentUser, projectAccessLevel } = useStore();
  const [assignee, setAssignee] = React.useState("all");
  const [priority, setPriority] = React.useState("all");

  const visible = state.tasks.filter((t) => canUserSeeTaskProject(state, t, currentUser.id));
  const tasks = applyTaskFilters(visible, assignee, priority);
  const projectOf = (t: { projectId: string }) => state.projects.find((p) => p.id === t.projectId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-6 pt-5 pb-3">
        <h1 className="text-base font-semibold">All tasks</h1>
        <p className="text-xs text-muted-foreground">
          {visible.length} across {new Set(visible.map((t) => t.projectId)).size} projects
        </p>
        <div className="mt-3">
          <TaskFilters assignee={assignee} onAssignee={setAssignee} priority={priority} onPriority={setPriority} />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <Board
          tasks={tasks}
          label={(t) => projectOf(t)?.name}
          readOnly={(t) => {
            const p = projectOf(t);
            return !p || projectAccessLevel(p) === "viewer";
          }}
          crossProject
        />
      </div>
    </div>
  );
}
