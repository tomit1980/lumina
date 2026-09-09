/**
 * The activity feed's write path — one insert, and three rules about it.
 *
 * **Insert, never read back.** The row is written with no `.select()`. That is
 * not a micro-optimisation: `RETURNING` re-evaluates `activities_read`
 * (20260909000900_activity_scope.sql) against the row as the scan finds it, and
 * a scoped row written a heartbeat before its scope becomes visible would come
 * back empty and be reported as a failure. Task 6 hit that shape twice from the
 * other direction (a caller made invisible to its own row by writing
 * `is_private` first). There is nothing server-assigned on an activity — the
 * id, the timestamp and the actor were all decided by the store — so there is
 * nothing to look at.
 *
 * **A filtered-away insert is an error, and PostgREST already says so.** Unlike
 * the UPDATE/DELETE case that `./workspace.ts` has to guard by hand, an INSERT
 * blocked by `with check` comes back as 42501 rather than as a silent empty
 * result. So the plain error check below really is sufficient here.
 *
 * **A delete-activity cannot be written, and must not be made writable.**
 * `activities.project_id` / `.conversation_id` cascade on delete. A
 * `deleted the X project` row inserted after the delete fails the foreign key
 * (23503); inserted before it, the same cascade removes it moments later. The
 * migration forbids the tempting fix — switching the FK to `set null` would
 * promote the row to workspace-wide and republish the very name 66cddf1 hid.
 * So this function lets the foreign key refuse, `commit` (lib/store.tsx) drops
 * the optimistic line from the feed, and the screen ends up agreeing with the
 * database. A durable record of who deleted what belongs in a server-side audit
 * log with its own access rules, not in a feed every user reads.
 */
import { fromActivity } from "./mapping";
import type { LuminaClient } from "./client";
import type { Activity } from "../../types";

export async function putActivity(
  client: LuminaClient,
  activity: Activity
): Promise<void> {
  const { error } = await client.from("activities").insert(fromActivity(activity));
  if (error) {
    const code = error.code ? ` [${error.code}]` : "";
    throw new Error(`put activity failed${code}: ${error.message}`);
  }
}
