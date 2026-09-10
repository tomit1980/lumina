import type { AppState, StatusDef, TaskStatus } from "./types";

/**
 * The board's columns, and the one place that knows what "finished" means.
 *
 * Before this file, `"done"` was a string literal tested in eighteen places
 * across eight files — the open-task filter, the completed count, the
 * progress bar, reminder suppression, the quick-complete toggle in two views,
 * the overdue guard, the strike-through, and the activity feed's "completed"
 * line. None of them shared a helper, so renaming the column would have
 * broken each one independently and silently: a workspace that called it
 * "Shipped" would have had a progress bar stuck at zero and reminders firing
 * for finished work, with nothing failing loudly enough to notice.
 *
 * `"todo"` had the same problem in miniature as the hardcoded reopen target.
 *
 * Everything here takes the statuses rather than reaching for a module-level
 * constant, because the set is per-workspace now and a component that closed
 * over a stale copy is exactly the bug class this codebase keeps finding.
 */

/** The seeded five, preserving their ids, their old `STATUS_META` labels and
 *  the hex equivalents of their old Tailwind dots. Preserving the ids is what
 *  keeps ~160 status literals across 21 test files valid. */
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: "backlog", name: "Backlog", color: "#a1a1aa", position: 0, isDone: false },
  { id: "todo", name: "To Do", color: "#0ea5e9", position: 1, isDone: false },
  { id: "in-progress", name: "In Progress", color: "#f59e0b", position: 2, isDone: false },
  { id: "in-review", name: "In Review", color: "#8b5cf6", position: 3, isDone: false },
  { id: "done", name: "Done", color: "#10b981", position: 4, isDone: true },
];

/** Board order. `position` is the authority; ties fall back to id so the
 *  order is at least stable rather than arbitrary. */
export function sortedStatuses(statuses: StatusDef[]): StatusDef[] {
  return [...statuses].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

export function statusById(
  statuses: StatusDef[],
  id: TaskStatus
): StatusDef | undefined {
  return statuses.find((s) => s.id === id);
}

/**
 * Is this the column that means the work is finished?
 *
 * Unknown ids answer `false`, which is the safe direction: a task whose
 * status no longer resolves reads as open, so it stays visible and countable
 * rather than silently disappearing into "completed".
 */
export function isDoneStatus(statuses: StatusDef[], id: TaskStatus): boolean {
  return statusById(statuses, id)?.isDone === true;
}

/** Convenience for the many call sites that hold the whole state. */
export function isDone(state: AppState, id: TaskStatus): boolean {
  return isDoneStatus(state.statuses, id);
}

/**
 * Where reopening a finished task sends it, and where a new task starts.
 *
 * The first column by position that is not the done column — replacing a
 * hardcoded `"todo"` in the two quick-complete toggles and in the task
 * dialog's creation default. A workspace whose first column is "Icebox" gets
 * "Icebox"; one that deleted `todo` entirely still works.
 */
export function firstOpenStatus(statuses: StatusDef[]): TaskStatus | undefined {
  return sortedStatuses(statuses).find((s) => !s.isDone)?.id;
}

/** The column a task falls back to when its status does not resolve — the
 *  first by position, done or not, since a workspace could in principle have
 *  only one. Used by the Supabase mapping layer, which must never drop a row
 *  just because its status is unfamiliar. */
export function fallbackStatus(statuses: StatusDef[]): TaskStatus | undefined {
  return sortedStatuses(statuses)[0]?.id;
}
