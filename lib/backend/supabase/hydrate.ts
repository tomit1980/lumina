/**
 * The read path: one round trip's worth of parallel selects, then
 * `toAppState`.
 *
 * Two rules govern this file.
 *
 * **Parallel, not sequential.** `hydrate()` runs at sign-in and again after a
 * failed write, and the database is a long way from the browser. Nineteen
 * sequential round trips to Mumbai is nineteen times the latency of one; every
 * request below is issued before any of them is awaited.
 *
 * **No client-side `WHERE` that restates a policy.** RLS is the filter. It is
 * tempting to add `.eq("user_id", me)` to `read_state`, or to skip private
 * channels the user is not in — but each of those would produce a correct
 * looking `AppState` even if the corresponding policy were broken, which is
 * precisely the bug class this migration exists to close (QA-001). The only
 * narrowing here is `activities`' `MAX_ACTIVITIES` cap, which is a display
 * budget the store already applies to its own feed, not an access rule.
 */
import { toAppState, type HydrateRows,
  signedOutState,
} from "./mapping";
import { sessionIsAssured } from "./assurance.ts";
import type { LuminaClient } from "./client";
import type { AppState } from "../../types";

/** `lib/store.tsx`'s own cap on the activity feed. Kept in step by hand: the
 *  store's constant is module-private, and exporting it would be a change to
 *  a file this task may only touch in one narrow place. */
const MAX_ACTIVITIES = 60;

/** A PostgREST result, unwrapped. supabase-js *resolves* on a database error
 *  rather than rejecting, so an unchecked `.data` is silently `null` — this is
 *  the single place that turns a query error into a real rejection.
 *
 *  Never write an existence check as `.select("*", { head: true })`: verified
 *  in this project, a head request returns `error: null` for a table that does
 *  not exist, and `{ count: "exact" }` does not change that. Only a body
 *  select surfaces `PGRST205`. Everything below is a body select. */
function unwrap<T>(label: string, result: { data: T[] | null; error: { message: string; code?: string } | null }): T[] {
  if (result.error) {
    const code = result.error.code ? ` [${result.error.code}]` : "";
    throw new Error(`hydrate: reading ${label} failed${code}: ${result.error.message}`);
  }
  return result.data ?? [];
}

/**
 * Fetches everything the signed-in user is allowed to see and assembles it
 * into an `AppState`.
 *
 * Rejects — it never resolves with a partial or seeded workspace. A caller
 * that swallowed the failure and showed a seed would be putting fictional
 * colleagues in front of a real user; `StoreProvider` shows a retry instead.
 */
export async function hydrateWorkspace(client: LuminaClient): Promise<AppState> {
  // QA-104, and BEFORE the selects rather than after them, which is the whole
  // point: a password-only session on an account with a verified second
  // factor holds a token PostgREST accepts, so asking first and discarding
  // the answer later would still have fetched the workspace. A session behind
  // an unanswered factor gets exactly what a signed-out visitor gets — the
  // empty shell — and `AuthGate` is already showing them the login screen.
  // See ./assurance.ts; the policy that refuses the same session server-side
  // is supabase/migrations/20260910004000_require_assurance.sql.
  if (!(await sessionIsAssured(client))) return signedOutState();

  const [
    auth,
    profiles,
    roles,
    statuses,
    channels,
    channelMembers,
    dms,
    dmMembers,
    messages,
    reactions,
    messageAttachments,
    attachments,
    projects,
    projectMembers,
    projectAttachments,
    tasks,
    taskCollaborators,
    taskAttachments,
    activities,
    readState,
  ] = await Promise.all([
    client.auth.getUser(),
    client.from("profiles").select("*").order("name"),
    client.from("roles").select("*").order("id"),
    // Ordered by position: this IS the board's column order.
    client.from("statuses").select("*").order("position"),
    client.from("channels").select("*").order("created_at"),
    client.from("channel_members").select("*"),
    client.from("dms").select("*").order("created_at"),
    client.from("dm_members").select("*"),
    client.from("messages").select("*").order("created_at"),
    client.from("reactions").select("*").order("emoji"),
    client.from("message_attachments").select("*"),
    client.from("attachments").select("*"),
    client.from("projects").select("*").order("created_at"),
    client.from("project_members").select("*"),
    client.from("project_attachments").select("*"),
    client.from("tasks").select("*").order("position"),
    client.from("task_collaborators").select("*"),
    client.from("task_attachments").select("*"),
    // Newest first so the cap keeps the *recent* feed, then reversed below:
    // `AppState.activities` is oldest-first (the store appends and slices).
    client.from("activities").select("*").order("ts", { ascending: false }).limit(MAX_ACTIVITIES),
    client.from("read_state").select("*"),
  ]);

  // Nobody signed in is a normal state, not a failure. Throwing here made
  // `StoreProvider` render its "couldn't load your workspace" screen *instead
  // of* its children, so the login screen never mounted and the one action
  // that would fix the error was unreachable. A signed-out visitor gets the
  // empty shell and `AuthGate` shows them the login screen; hydrate runs
  // again for real once they are in. Found by the end-to-end pass — every
  // unit and policy test passed, because this needs the real backend and a
  // real browser at the same time.
  const currentUserId = auth.error ? undefined : auth.data.user?.id;
  if (!currentUserId) {
    return signedOutState();
  }

  const rows: HydrateRows = {
    currentUserId,
    profiles: unwrap("profiles", profiles),
    roles: unwrap("roles", roles),
    statuses: unwrap("statuses", statuses),
    channels: unwrap("channels", channels),
    channelMembers: unwrap("channel_members", channelMembers),
    dms: unwrap("dms", dms),
    dmMembers: unwrap("dm_members", dmMembers),
    messages: unwrap("messages", messages),
    reactions: unwrap("reactions", reactions),
    messageAttachments: unwrap("message_attachments", messageAttachments),
    attachments: unwrap("attachments", attachments),
    projects: unwrap("projects", projects),
    projectMembers: unwrap("project_members", projectMembers),
    projectAttachments: unwrap("project_attachments", projectAttachments),
    tasks: unwrap("tasks", tasks),
    taskCollaborators: unwrap("task_collaborators", taskCollaborators),
    taskAttachments: unwrap("task_attachments", taskAttachments),
    activities: unwrap("activities", activities).reverse(),
    readState: unwrap("read_state", readState),
  };

  return toAppState(rows);
}
