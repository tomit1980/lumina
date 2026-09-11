/**
 * Reusable task sets, against Postgres.
 *
 * Gated on `workspace.taskSets`, which Owner and Admin hold — so every write
 * here is one a Member's session is refused, by `task_sets_write` and
 * `task_set_items_write` in 20260911000200_task_sets.sql, not by anything in
 * this file. The client's own guard exists for the message, not the rule.
 *
 * TWO THINGS ARE THE DATABASE'S AND ARE NOT RESTATED HERE:
 *
 *   * `updated_at` — a trigger bumps the parent set when an ITEM changes, so
 *     "last updated" stays true when somebody only reorders a line. Setting it
 *     from here would mean two writers for one fact, and the one that runs on
 *     every path is the trigger;
 *   * deleting a set cascades its items, by the foreign key.
 *
 * Every write reads its rows back and throws when none return. PostgREST
 * reports a policy-filtered write as `error: null` with an empty body, so
 * "no error" is not the same claim as "it happened" — the shape `requireRows`
 * exists for, and the one this module refuses to report as success.
 */
import { fail } from "./result";
import { toTaskSet } from "./mapping";
import type { LuminaClient } from "./client";
import type { TaskSetItemPatch, TaskSetPatch } from "../types";
import type { TaskSet, TaskSetItem } from "../../types";

/** Rows for a set's lines, in the shape the table takes. */
function itemRows(taskSetId: string, items: TaskSetItem[]) {
  return items.map((item) => ({
    id: item.id,
    task_set_id: taskSetId,
    title: item.title,
    description: item.description,
    priority: item.priority,
    labels: item.labels,
    position: item.position,
  }));
}

/**
 * Parent and lines in one call.
 *
 * Not transactional — supabase-js has no client transaction and this is not
 * worth an RPC: a set with no items is a legitimate state the editor starts
 * from, so a half-created set is a set somebody can finish rather than a
 * broken one. What it does do is sweep the parent away when the items are
 * refused, so a refusal does not leave a set the caller did not ask for. Same
 * shape as `createTask`'s collaborator insert.
 */
export async function createTaskSet(
  client: LuminaClient,
  set: TaskSet
): Promise<TaskSet> {
  const what = "creating that task set";
  const { data, error } = await client
    .from("task_sets")
    .insert({
      id: set.id,
      name: set.name,
      description: set.description,
      created_by: set.createdBy || null,
      created_at: new Date(set.createdAt).toISOString(),
    })
    .select("*");
  if (error) fail(what, error);
  const created = data?.[0];
  if (!created) {
    throw new Error(`${what} failed: you don't have permission to manage task sets`);
  }

  if (set.items.length > 0) {
    const items = await client.from("task_set_items").insert(itemRows(set.id, set.items));
    if (items.error) {
      await client.from("task_sets").delete().eq("id", set.id);
      fail(what, items.error);
    }
  }

  return toTaskSet(created, set.items);
}

export async function updateTaskSet(
  client: LuminaClient,
  taskSetId: string,
  patch: TaskSetPatch
): Promise<void> {
  const what = "saving that task set";
  const { data, error } = await client
    .from("task_sets")
    .update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    })
    .eq("id", taskSetId)
    .select("id");
  if (error) fail(what, error);
  if ((data ?? []).length === 0) {
    throw new Error(`${what} failed: you don't have permission to manage task sets`);
  }
}

export async function archiveTaskSet(
  client: LuminaClient,
  taskSetId: string,
  archived: boolean
): Promise<void> {
  const what = archived ? "archiving that task set" : "restoring that task set";
  const { data, error } = await client
    .from("task_sets")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", taskSetId)
    .select("id");
  if (error) fail(what, error);
  if ((data ?? []).length === 0) {
    throw new Error(`${what} failed: you don't have permission to manage task sets`);
  }
}

export async function createTaskSetItem(
  client: LuminaClient,
  taskSetId: string,
  item: TaskSetItem
): Promise<void> {
  const what = "adding that line";
  const { data, error } = await client
    .from("task_set_items")
    .insert(itemRows(taskSetId, [item])[0])
    .select("id");
  if (error) fail(what, error);
  if ((data ?? []).length === 0) {
    throw new Error(`${what} failed: you don't have permission to manage task sets`);
  }
}

export async function updateTaskSetItem(
  client: LuminaClient,
  itemId: string,
  patch: TaskSetItemPatch
): Promise<void> {
  const what = "saving that line";
  const { data, error } = await client
    .from("task_set_items")
    .update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
    })
    .eq("id", itemId)
    .select("id");
  if (error) fail(what, error);
  if ((data ?? []).length === 0) {
    throw new Error(`${what} failed: you don't have permission to manage task sets`);
  }
}

export async function deleteTaskSetItem(
  client: LuminaClient,
  itemId: string
): Promise<void> {
  const what = "removing that line";
  const { data, error } = await client
    .from("task_set_items")
    .delete()
    .eq("id", itemId)
    .select("id");
  if (error) fail(what, error);
  if ((data ?? []).length === 0) {
    throw new Error(`${what} failed: you don't have permission to manage task sets`);
  }
}

/**
 * The whole ordered list, one row at a time, awaited in sequence.
 *
 * Sequential so a refusal stops the rest rather than leaving half an order —
 * the same reasoning as `reorderStatuses`. Not an upsert, which would have to
 * send a possibly-stale title alongside the position.
 */
export async function reorderTaskSetItems(
  client: LuminaClient,
  order: Array<{ id: string; position: number }>
): Promise<void> {
  const what = "reordering those lines";
  for (const { id, position } of order) {
    const { data, error } = await client
      .from("task_set_items")
      .update({ position })
      .eq("id", id)
      .select("id");
    if (error) fail(what, error);
    if ((data ?? []).length === 0) {
      throw new Error(`${what} failed: you don't have permission to manage task sets`);
    }
  }
}
