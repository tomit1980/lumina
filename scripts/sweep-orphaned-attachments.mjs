// Removes attachment bytes that nothing points at any more.
//
// WHY THIS EXISTS (final-review.md finding 4). `attachments` has no foreign
// key to `projects` or `tasks` -- only the join rows do. Deleting a project or
// a task therefore cascades `project_attachments` / `task_attachments` away
// and leaves the `attachments` row behind, unlinked, with its object still
// sitting in the bucket. The same thing happens, more mildly, when a user
// picks a file and then cancels the dialog: `lib/attachments.ts` uploads on
// file-pick, so the row and object exist before anything links them.
//
// The decision recorded in 20260909001000_attachment_link_visibility.sql is to
// SWEEP rather than cascade, and the reason is in that migration: bytes live
// in Storage, not in Postgres, so a row cascade would delete the only durable
// pointer to the object and leave the object itself behind -- and, because
// `attachment_objects_delete` is answered FROM the attachments row, it would
// leave it undeletable by every authenticated client forever.
//
// So: object first, row second. That is the same order
// lib/backend/supabase/storage.ts uses and for the same reason.
//
// Usage (dry run by default -- it prints what it WOULD remove and exits 0):
//
//   node scripts/sweep-orphaned-attachments.mjs
//   node scripts/sweep-orphaned-attachments.mjs --apply
//   node scripts/sweep-orphaned-attachments.mjs --apply --older-than=1
//
// `--older-than=<hours>` (default 24) is a grace period, not a nicety: an
// upload in flight has a row and no link yet, and sweeping it would delete a
// file out from under the person choosing it.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });

// Every exit below sets `process.exitCode` and returns rather than calling
// `process.exit()`. On Windows, tearing the process down while supabase-js
// still holds an open handle aborts libuv ("!(handle->flags &
// UV_HANDLE_CLOSING)") and reports exit 127 — a sweep that worked would look
// like a crash to whatever schedules it.
async function main() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    console.error("Missing SUPABASE_URL / SUPABASE_SECRET_KEY.");
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const hoursArg = args.find((a) => a.startsWith("--older-than="));
  const hours = hoursArg ? Number(hoursArg.split("=")[1]) : 24;
  if (!Number.isFinite(hours) || hours < 0) {
    console.error(`--older-than must be a non-negative number of hours, got "${hoursArg}"`);
    process.exitCode = 1;
    return;
  }

  // `orphaned_attachments` is SECURITY DEFINER and granted to service_role
  // only: "what is orphaned" is defined once, in SQL, beside the policies that
  // make it matter. Re-deriving it here would be the second copy of a rule
  // this repo keeps getting bitten by.
  const svc = createClient(url, secret, { auth: { persistSession: false } });

  const { data, error } = await svc.rpc("orphaned_attachments", {
    older_than: `${hours} hours`,
  });
  if (error) {
    console.error(`orphaned_attachments failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const rows = data ?? [];
  console.log(`${rows.length} orphaned attachment(s) older than ${hours}h on ${new URL(url).host}`);
  if (rows.length === 0) return;

  for (const row of rows) {
    console.log(`  ${row.id}  ${row.storage_path}  ${row.name}`);
  }

  if (!apply) {
    console.log("\nDry run — nothing removed. Re-run with --apply to sweep.");
    return;
  }

  const sweepable = [];
  let failed = 0;

  for (const row of rows) {
    // `storage_path` is "<bucket>/<attachment-id>" — self-describing, so a
    // delete never has to guess the bucket (20260910001000_storage.sql).
    const slash = String(row.storage_path ?? "").indexOf("/");
    if (slash <= 0) {
      console.log(`  SKIP ${row.id}: unusable storage_path "${row.storage_path}"`);
      failed++;
      continue;
    }
    const bucket = row.storage_path.slice(0, slash);
    const path = row.storage_path.slice(slash + 1);
    const gone = await svc.storage.from(bucket).remove([path]);
    if (gone.error) {
      console.log(`  FAILED ${row.id}: ${gone.error.message}`);
      failed++;
      continue;
    }
    // Only rows whose OBJECT is now gone become sweepable. A row whose delete
    // failed keeps its storage_path so the next run can try again — dropping
    // it would strand the object with no pointer left to find it by.
    sweepable.push(row.id);
  }

  const deleted = sweepable.length
    ? await svc.from("attachments").delete().in("id", sweepable).select("id")
    : { data: [], error: null };
  if (deleted.error) {
    console.error(`\nrow delete failed: ${deleted.error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nswept ${sweepable.length} object(s) and ${(deleted.data ?? []).length} row(s)` +
      (failed ? `; ${failed} could not be removed and were left for the next run` : "")
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
