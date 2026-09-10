/**
 * The task write path — the kanban board, its owner and its collaborators
 * (store-swap Task 7). `SupabaseBackend` delegates `createTask`, `updateTask`,
 * `moveTask` and `deleteTask` here, the same way it delegates chat to `./chat`
 * and channels/projects to `./workspace`.
 *
 * The rules `./chat.ts` and `./workspace.ts` state all still hold (the store
 * has already patched the screen; a filtered-away write is a failure, not a
 * success; race-prone decisions belong to the server; files are Task 10's).
 * Five more are specific to this file, and every one of them is a bug that is
 * easy to ship:
 *
 * **The position is the server's, not ours.** `tasks.position` defaults to the
 * sentinel `-1` and `tasks_default_position` (20260908000800_store_swap.sql)
 * replaces it with `max(position) + 1` for that project/status. The insert
 * below therefore names no position at all, and the row is read back so the
 * store can adopt the number the trigger chose. The client-side `columnSize`
 * count this replaces was read before a network round trip: two people adding a
 * card to the same column both saw the same count and both claimed it.
 *
 * **Reordering is one RPC.** `move_task` (20260906000500_invariants.sql)
 * renumbers the destination column, opens a slot, and closes the gap in the
 * source column in a single statement per column. Doing it from here would be
 * a read, a decision, and N updates with other people's moves interleaved
 * through the middle of them.
 *
 * **A collaborator change is a delete plus an insert.** `task_collaborators`
 * has no UPDATE policy, deliberately (20260907000600): a row carries no mutable
 * payload, and an update policy would open a path to rewrite `task_id` or
 * `user_id` on a row whose pre-image was the only thing ever checked.
 *
 * **Only what the patch NEWLY assigns may be re-validated.** This is the rule
 * the whole file is arranged around; see `updateTask`.
 *
 * **The tasks row is written before its collaborators, always.** Two triggers
 * make the order load-bearing rather than stylistic:
 * `check_task_collaborator` refuses an insert naming the task's *current*
 * owner, and `drop_collaborator_on_assign` deletes the new owner's collaborator
 * row when `assignee_id` changes. Handing over ownership — A becomes a
 * collaborator, B becomes the owner — only works if `assignee_id` lands first;
 * the other order tries to add A while A is still the owner and raises.
 */
import { fail, requireRows } from "./result";
import { syncAttachmentLinks } from "./storage";
import type { LuminaClient } from "./client";
import type { TaskPatch } from "../types";
import type { Task, TaskStatus } from "../../types";

/** Postgres `integer`, which is what `move_task(p_index)` takes. The board's
 *  "drop at the end of the column" callers pass `Number.MAX_SAFE_INTEGER`
 *  (components/kanban/board.tsx, list-view.tsx) — nine quadrillion, which
 *  int4 cannot hold, so an unclamped call is a `22003` every time rather than
 *  an append. The RPC clamps to the column length itself; this only has to get
 *  the value through the wire protocol. */
const INT4_MAX = 2147483647;

/** Epoch ms → timestamptz, preserving null. */
function toTimestamp(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Keys that exist on `TaskPatch` (it is `Partial<Omit<Task, "id"|"projectId">>`)
 * but have no honest UPDATE behind them, refused rather than silently dropped.
 *
 * `order` is the interesting one: writing it would set a position without
 * renumbering the column around it, leaving two cards claiming the same slot.
 * Reordering has an operation of its own and the error says so. `createdAt` and
 * `createdBy` are provenance — the store never patches either, and a backend
 * that quietly ignored them would hide a caller that had started to.
 */
function refuseFrozen(patch: TaskPatch): void {
  // `projectId` is not even a key of `TaskPatch`, so only a cast can put it
  // here — but re-parenting a task is the review's F3, and the database's
  // answer to it is to silently prune the collaborators who cannot see the
  // destination. Dropping the key quietly would leave a caller believing a move
  // happened; the type is the first guard and this is the second.
  if ("projectId" in patch) {
    throw new Error("A task cannot be moved to a different project.");
  }
  const frozen = (["order", "createdAt", "createdBy"] as const).filter(
    (key) => patch[key] !== undefined
  );
  if (frozen.length === 0) return;
  throw new Error(
    frozen.includes("order")
      ? "A task's position is changed by moving it, not by saving it."
      : `A task's ${frozen.join(" and ")} cannot be changed after it is created.`
  );
}

/**
 * Insert the task, then its collaborators.
 *
 * No `position`: see the file header. The row IS read back for the one the
 * trigger assigned, and that read-back is safe here in a way Task 6's were not.
 * `RETURNING` applies the SELECT policy to the row as the scan finds it, so the
 * question is always "can this caller still see what they just wrote" —
 * `tasks_insert` demands `can_see_project(project_id) and not
 * project_is_viewer_only(...)`, `tasks_read` demands `can_see_project(...)`,
 * and nothing on a `tasks` row feeds either predicate (both read `projects` and
 * `project_members`). The insert's own check therefore strictly implies the
 * read. Contrast `setChannelAccess`, where the column being written was itself
 * an input to the visibility rule.
 *
 * `created_at` is the client's own timestamp rather than `now()`, for the same
 * reason `./chat`'s `messageRow` does it: the optimistic card is already on the
 * board, and a server-stamped row would reshuffle ties on the next load.
 *
 * A failure after the task row lands would otherwise leave a task on the board
 * missing the people the dialog said were on it. It is swept on the way out,
 * best-effort: the error reported is the collaborator insert's, not the
 * cleanup's.
 */
export async function createTask(client: LuminaClient, task: Task): Promise<Task> {
  const what = "creating that task";

  const inserted = await client
    .from("tasks")
    .insert({
      id: task.id,
      project_id: task.projectId,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      assignee_id: task.assigneeId,
      due_date: toTimestamp(task.dueDate),
      start_time: task.startTime,
      duration_minutes: task.durationMinutes,
      reminder_minutes: task.reminderMinutes,
      labels: task.labels,
      created_by: task.createdBy,
      // Not `toTimestamp`: `created_at` is NOT NULL, and `Task.createdAt` is
      // never null either, so the nullable helper's type would be wrong here.
      created_at: new Date(task.createdAt).toISOString(),
    })
    .select("id,position");
  // `requireRows` inlined so the row stays typed — the position below is the
  // whole reason for the read-back, and `unknown[]` would lose it.
  if (inserted.error) fail(what, inserted.error);
  const created = inserted.data?.[0];
  if (!created) {
    throw new Error(`${what} failed: you don't have permission to add tasks to this project`);
  }

  if (task.collaboratorIds.length > 0) {
    const { error } = await client
      .from("task_collaborators")
      .insert(task.collaboratorIds.map((userId) => ({ task_id: task.id, user_id: userId })));
    if (error) {
      await client.from("tasks").delete().eq("id", task.id);
      fail(what, error);
    }
  }

  // Files picked in the new-task dialog. Their bytes are already in Storage;
  // this is the link, and it is swept the same way the collaborators are if
  // it fails — a task on the board missing the files the dialog showed is the
  // same half-write.
  //
  // PERMISSION NOTE, and it is a real mismatch rather than a hypothetical:
  // `task_attachments_insert` requires `has_permission('task.edit')`, while
  // the store guards this action on `task.create`. A role holding
  // `task.create` but not `task.edit` gets a 42501 here — LOUDLY, so `commit`
  // rolls the card back and says so, unlike Task 7's `move_task`, where the
  // same class of mismatch produced a clean void return having moved nothing.
  // Neither default role is in that position (Member holds both). Recorded in
  // task-10-report.md rather than papered over with a client-side check.
  if (task.attachments.length > 0) {
    try {
      await syncAttachmentLinks(
        client,
        "task",
        task.id,
        task.attachments,
        what
      );
    } catch (err) {
      await client.from("tasks").delete().eq("id", task.id);
      throw err;
    }
  }

  return { ...task, order: created.position };
}

/**
 * The editable fields, then the collaborator list.
 *
 * **The rule this function exists to preserve.** "Assignment never grants
 * access" is enforced by two triggers — `tasks_check_assignee` on
 * `assignee_id`, and `check_task_collaborator` on every
 * `task_collaborators` INSERT — and both are absolute: they refuse a person who
 * cannot see the project *at the moment they fire*, with no interest in whether
 * this caller is the one who put them there. The store deliberately checks only
 * the people a patch NEWLY assigns, because refusing over somebody already on
 * the task makes it uneditable by everyone (including the home page's
 * quick-complete, which assigns nobody at all). If this file re-sent the whole
 * assignment on every save, the database would restore exactly the bug the
 * store's distinction removes.
 *
 * So neither trigger is allowed to fire for a person who was already there:
 *
 *   * `assignee_id` is written ONLY when it differs from the row's current
 *     value. `tasks_check_assignee` is `before insert or update of assignee_id`
 *     — "of assignee_id" means the SET list, not a changed value — so including
 *     an unchanged owner would re-validate them. The task dialog sends
 *     `assigneeId` on every save (components/task-dialog.tsx), so this is the
 *     common path, not a corner.
 *   * collaborators are DIFFED against the rows that are actually there, and
 *     only genuinely new ones are inserted. A stale collaborator stays in the
 *     list the store sent, is already in the table, and is therefore never
 *     re-validated.
 *
 * Statement order: the tasks row first (see the file header), then the
 * collaborator diff — which is read AFTER the update on purpose, so that a
 * collaborator `drop_collaborator_on_assign` has just removed does not look
 * like a row this function failed to delete.
 */
export async function updateTask(
  client: LuminaClient,
  taskId: string,
  patch: TaskPatch
): Promise<void> {
  const what = "saving that task";
  const denied = "you don't have permission to edit this task";
  refuseFrozen(patch);

  // Before any write: the current owner, which decides whether `assignee_id`
  // belongs in the SET list at all. A task the caller cannot see reads as
  // absent (tasks_read), which is a refusal, not an empty patch.
  const existing = await client
    .from("tasks")
    .select("id,assignee_id")
    .eq("id", taskId)
    .maybeSingle();
  if (existing.error) fail(what, existing.error);
  if (!existing.data) throw new Error(`${what} failed: ${denied}`);

  // Spread rather than assignment so the object's inferred type stays exactly
  // the set of columns being written — PostgREST's generated `Update` type
  // rejects a `Record<string, unknown>`, and rightly: a typo in a key would
  // otherwise compile and update nothing.
  const row = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.dueDate !== undefined ? { due_date: toTimestamp(patch.dueDate) } : {}),
    ...(patch.startTime !== undefined ? { start_time: patch.startTime } : {}),
    ...(patch.durationMinutes !== undefined
      ? { duration_minutes: patch.durationMinutes }
      : {}),
    ...(patch.reminderMinutes !== undefined
      ? { reminder_minutes: patch.reminderMinutes }
      : {}),
    ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
    ...(patch.assigneeId !== undefined && patch.assigneeId !== existing.data.assignee_id
      ? { assignee_id: patch.assigneeId }
      : {}),
  };

  // A patch naming no persistable column is a no-op, not a write: an empty
  // UPDATE is rejected by PostgREST outright, and there is nothing to report a
  // failure about. Reassigning collaborators alone reaches here.
  if (Object.keys(row).length > 0) {
    requireRows(
      what,
      denied,
      await client.from("tasks").update(row).eq("id", taskId).select("id")
    );
  }

  if (patch.collaboratorIds !== undefined) {
    await syncCollaborators(client, taskId, patch.collaboratorIds, what);
  }

  // Last, for the same reason the collaborator diff is not first: everything
  // above narrows nothing the attachment policies read, but going in this
  // order means the file links are never evaluated against a half-written
  // task row. `task_attachments_*` all name `task.edit`, which is exactly
  // what the store guards `updateTask` on — no mismatch here.
  if (patch.attachments !== undefined || patch.removedAttachmentIds?.length) {
    await syncAttachmentLinks(
      client,
      "task",
      taskId,
      patch.attachments ?? [],
      "saving that task's files",
      // Only what the dialog itself removed. The form's `attachments` is the
      // snapshot it took when it opened, so anything a colleague attached
      // since is missing from it — and QA-101 was that absence being read as
      // a deletion.
      patch.removedAttachmentIds
    );
  }
}

/**
 * Delete the collaborators who left, insert the ones who arrived, touch nobody
 * else. See `updateTask` for why the diff is the point rather than an
 * optimisation.
 *
 * The delete asks for its rows back because `task_collaborators_delete`
 * additionally requires `task.edit`, and a policy that filters every candidate
 * away is reported as `error: null` with an empty body. Zero rows for a
 * non-empty removal list is that shape and is refused. A *partial* return is
 * not: the rows that did not come back were already gone (a concurrent edit, or
 * `drop_collaborator_on_assign` firing between the read and the delete), which
 * is the state being asked for.
 */
async function syncCollaborators(
  client: LuminaClient,
  taskId: string,
  next: string[],
  what: string
): Promise<void> {
  const current = await client
    .from("task_collaborators")
    .select("user_id")
    .eq("task_id", taskId);
  if (current.error) fail(what, current.error);

  const have = new Set((current.data ?? []).map((r) => r.user_id));
  const wanted = new Set(next);
  const removed = [...have].filter((id) => !wanted.has(id));
  const added = next.filter((id) => !have.has(id));

  if (removed.length > 0) {
    requireRows(
      what,
      "you don't have permission to change who is on this task",
      await client
        .from("task_collaborators")
        .delete()
        .eq("task_id", taskId)
        .in("user_id", removed)
        .select("user_id")
    );
  }

  if (added.length > 0) {
    const { error } = await client
      .from("task_collaborators")
      .insert(added.map((userId) => ({ task_id: taskId, user_id: userId })));
    if (error) fail(what, error);
  }
}

/**
 * One RPC, plus the capability check the RPC cannot make for itself.
 *
 * `move_task` is `security invoker`, so its three UPDATEs run under
 * `tasks_update` — which requires **`task.edit`**. The store's guard for this
 * action is **`task.move`**. Every role this workspace ships holds both or
 * neither, but roles are editable in the app, so a "Contributor" built with
 * `task.move` alone would reach a `move_task` whose every UPDATE is filtered to
 * zero rows, and a plpgsql function has no complaint to make about an UPDATE
 * that matched nothing: the RPC returns void, cleanly, having done nothing.
 * That is the false-success shape, on the surface the user manipulates most.
 *
 * The check is issued CONCURRENTLY with the move rather than before it, so a
 * drag costs one round trip and not two. Safe in both directions: if the answer
 * is `false`, the same missing permission is what filtered the RPC's updates
 * away, so there is nothing half-applied to undo; if it is `true`, the pre-flight
 * was free.
 *
 * The RPC still raises on its own for a task the caller cannot see at all — the
 * `select ... into v_project` at the top runs under `tasks_read`.
 */
export async function moveTask(
  client: LuminaClient,
  taskId: string,
  toStatus: TaskStatus,
  toIndex: number
): Promise<void> {
  const what = "moving that task";

  const [moved, allowed] = await Promise.all([
    client.rpc("move_task", {
      p_task_id: taskId,
      p_status: toStatus,
      // Only to fit int4 — the RPC clamps to the real column length.
      p_index: Math.min(Math.max(0, Math.trunc(toIndex)), INT4_MAX),
    }),
    client.rpc("has_permission", { perm: "task.edit" }),
  ]);

  if (moved.error) fail(what, moved.error);
  if (allowed.error) fail(what, allowed.error);
  if (allowed.data !== true) {
    throw new Error(`${what} failed: your role can't edit tasks`);
  }
}

/**
 * One delete. The cascade takes the task's collaborator rows and its attachment
 * links.
 *
 * The `deleted "X"` feed line this produces IS persistable, unlike the project
 * and channel deletes in `./workspace.ts`: `activities.project_id` cascades from
 * `projects`, not from `tasks`, and the project outlives the task. Nothing here
 * has to arrange that — `commit` in lib/store.tsx logs whatever the patch
 * appended once this resolves.
 */
export async function deleteTask(client: LuminaClient, taskId: string): Promise<void> {
  requireRows(
    "deleting that task",
    "you don't have permission to delete this task",
    await client.from("tasks").delete().eq("id", taskId).select("id")
  );
}
