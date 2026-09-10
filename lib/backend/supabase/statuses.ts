/**
 * The board's columns, against Postgres.
 *
 * Gated on `workspace.statuses`, which only the Owner role holds — so every
 * function here is one an Admin's session will be refused, by
 * `statuses_write` in 20260910005000_statuses.sql, not by anything in this
 * file. The client's own guard exists for the message, not the enforcement.
 *
 * TWO RULES ARE THE DATABASE'S AND ARE NOT RESTATED HERE:
 *
 *   * a status still holding tasks cannot be deleted — `tasks.status` is a
 *     foreign key with `on delete restrict`, so a raw PostgREST call gets the
 *     same refusal the interface does;
 *   * exactly one status may be `is_done` — a partial unique index says so.
 *
 * Restating either in TypeScript would mean two rules that have to agree, and
 * the one in the database is the only one that cannot be walked around.
 */
import { fail } from "./result";
import { toStatusDef } from "./mapping";
import type { LuminaClient } from "./client";
import type { StatusPatch } from "../types";
import type { StatusDef } from "../../types";

export async function createStatus(
  client: LuminaClient,
  status: StatusDef
): Promise<StatusDef> {
  const what = "adding that column";
  const { data, error } = await client
    .from("statuses")
    .insert({
      id: status.id,
      name: status.name,
      color: status.color,
      position: status.position,
      is_done: status.isDone,
    })
    .select("*");
  if (error) fail(what, error);
  const created = data?.[0];
  // Zero rows back from an insert the policy filtered out — the same
  // false-success shape the rest of this module refuses to report.
  if (!created) {
    throw new Error(`${what} failed: you don't have permission to edit columns`);
  }
  return toStatusDef(created);
}

export async function updateStatus(
  client: LuminaClient,
  statusId: string,
  patch: StatusPatch
): Promise<void> {
  const what = "saving that column";
  const { data, error } = await client
    .from("statuses")
    .update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.isDone !== undefined ? { is_done: patch.isDone } : {}),
    })
    .eq("id", statusId)
    .select("id");
  if (error) fail(what, error);
  if (!data || data.length === 0) {
    throw new Error(`${what} failed: you don't have permission to edit columns`);
  }
}

export async function deleteStatus(
  client: LuminaClient,
  statusId: string
): Promise<void> {
  const what = "removing that column";
  const { data, error } = await client
    .from("statuses")
    .delete()
    .eq("id", statusId)
    .select("id");
  if (error) fail(what, error);
  if (!data || data.length === 0) {
    throw new Error(`${what} failed: you don't have permission to edit columns`);
  }
}

export async function reorderStatuses(
  client: LuminaClient,
  order: Array<{ id: string; position: number }>
): Promise<void> {
  const what = "reordering the columns";
  // One statement per column rather than an upsert of the whole set: an
  // upsert would need every column of every row, and sending a stale `name`
  // or `is_done` alongside a position is exactly the "a patch that asserts
  // more than it means" shape this codebase has been removing. Awaited in
  // sequence so a refusal stops the rest instead of leaving a half-applied
  // order behind.
  for (const { id, position } of order) {
    const { error } = await client.from("statuses").update({ position }).eq("id", id);
    if (error) fail(what, error);
  }
}
