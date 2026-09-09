/**
 * Channels, projects and access — the writes that decide **who can see what**
 * (store-swap Task 6). `SupabaseBackend` delegates its seven workspace
 * operations here, the same way it delegates chat to `./chat`.
 *
 * The four rules from `./chat` all still apply (the store has already patched
 * the screen; a filtered-away write is a failure, not a success; race-prone
 * decisions belong to the server; files are Task 10's). Four more are specific
 * to this file, and each one is a bug that would otherwise be easy to ship:
 *
 * **A channel is a `conversations` row.** `channels.id` references
 * `conversations(id) on delete cascade` (20260906000200), so creating one is
 * two inserts and deleting one is a single delete of the *parent*. Deleting the
 * `channels` row instead would strand its conversation, and — worse — the
 * `channels_delete` policy demands `channel.delete`, which a channel's own
 * creator need not hold. `conversations_delete` is the policy that mirrors the
 * store's guard (`channel_is_manageable`: not the team channel, and either
 * `channel.delete` or you created it), so the parent is also the *correct* row
 * to aim at.
 *
 * **Let the cascade delete the children.** A channel's messages and a
 * project's tasks are removed by the foreign keys, not by this file. Deleting
 * them by hand would be a second round trip that can fail on its own and leave
 * the delete half-applied.
 *
 * **A creator's membership row cannot be deleted.** `ensure_channel_creator_
 * editor` / `ensure_project_creator_editor` (20260906000500) raise if you try,
 * for as long as the channel/project exists. The store expresses the same rule
 * as `ensureEditor(...)` while a resource is restricted, but sets `members: []`
 * when it is opened up — so a naive "delete every member row" would raise and
 * turn a perfectly legal change into a failure. Every removal below therefore
 * skips the creator. See `setChannelAccess` for what that means on reload.
 *
 * **Membership is delete-plus-*upsert*, never delete-plus-reinsert.**
 * `project_members_prune_collaborators` (20260907000700) fires on every
 * `project_members` DELETE and drops that person's `task_collaborators` rows if
 * they can no longer see the project. Clearing the whole member list and
 * writing it back would fire that trigger for members who are *staying* — and
 * since the trigger sees them momentarily unlisted on a restricted project, it
 * would silently delete collaborator rows the user never asked to lose. Only
 * genuinely removed members are deleted; everyone else is upserted, which is an
 * UPDATE and fires nothing.
 */
import { fail, requireRows } from "./result";
import { syncAttachmentLinks } from "./storage";
import type { LuminaClient } from "./client";
import type { ChannelAccessPatch, ProjectAccessPatch, ProjectPatch } from "../types";
import type { Channel, Project, ResourceMember } from "../../types";

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Which member rows to remove, and which to write.
 *
 * `creator` is excluded from `removed` unconditionally — see the file header.
 * `kept` is the whole next list rather than a diff: an upsert of a row that has
 * not changed is a no-op, and computing "only the changed ones" would need the
 * level of every current row for no benefit.
 */
function membershipPlan(
  current: string[],
  next: ResourceMember[],
  creator: string | null
): { removed: string[]; kept: ResourceMember[] } {
  const wanted = new Set(next.map((m) => m.userId));
  return {
    removed: current.filter((id) => !wanted.has(id) && id !== creator),
    kept: next,
  };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Two inserts plus the member rows, in dependency order.
 *
 * `created_at` is the client's own timestamp rather than `now()`, for the same
 * reason `./chat`'s `messageRow` does it: the optimistic channel is already in
 * the sidebar, and `hydrate` orders channels by `created_at`. A server-stamped
 * row would reshuffle the list on the next load for no reason.
 *
 * A failure after the `conversations` row lands would otherwise leave an
 * unreferenced parent behind — invisible (nothing reads `conversations` on its
 * own) but real. It is swept on the way out, best-effort: the error being
 * reported is the insert's, not the cleanup's.
 */
export async function createChannel(
  client: LuminaClient,
  channel: Channel
): Promise<Channel> {
  const conversation = await client
    .from("conversations")
    .insert({ id: channel.id, kind: "channel" });
  if (conversation.error) fail("creating that channel", conversation.error);

  const row = await client.from("channels").insert({
    id: channel.id,
    name: channel.name,
    description: channel.description,
    is_private: channel.isPrivate,
    // Never `true`: the team channel is seeded, and a partial unique index
    // (20260908000800) rejects a second one anyway.
    is_team: false,
    created_by: channel.createdBy,
    created_at: new Date(channel.createdAt).toISOString(),
  });
  if (row.error) {
    await client.from("conversations").delete().eq("id", channel.id);
    fail("creating that channel", row.error);
  }

  if (channel.members.length > 0) {
    const members = await client.from("channel_members").insert(
      channel.members.map((m) => ({
        channel_id: channel.id,
        user_id: m.userId,
        level: m.level,
      }))
    );
    if (members.error) {
      await client.from("conversations").delete().eq("id", channel.id);
      fail("creating that channel", members.error);
    }
  }

  return channel;
}

/**
 * One delete, of the conversation. The cascade takes the channel row, its
 * members, its messages (and their reactions and attachment links), everybody's
 * read markers for it, and — deliberately — every activity scoped to it. See
 * the note on delete-activities in `index.ts`.
 */
export async function deleteChannel(
  client: LuminaClient,
  channelId: string
): Promise<void> {
  requireRows(
    "deleting that channel",
    "it is not yours to delete",
    await client.from("conversations").delete().eq("id", channelId).select("id")
  );
}

/**
 * Membership first, privacy second. The order is the whole subtlety here, and
 * it was found by the RLS suite rather than reasoned out in advance.
 *
 * A channel's visibility is `can_see_conversation`: public, or you hold a
 * `channel_members` row, or you hold `members.manage`. There is no
 * "you created it" branch (unlike projects). So the moment `is_private` flips
 * to true, a creator who does not yet have a member row **cannot see their own
 * channel** — and that breaks the next two statements in ways that look like
 * permission failures:
 *
 *   * an upsert is `insert ... on conflict do update`, which Postgres requires
 *     the table's SELECT policy for. `channel_members_read` is
 *     `can_see_conversation`, so writing the member list would be refused with
 *     42501 — while a plain INSERT of the identical row succeeds.
 *   * an UPDATE with RETURNING (what `.select()` compiles to) additionally
 *     applies the SELECT policy, evaluated against the row as the scan finds
 *     it. On an already-private channel the scan would find nothing, and
 *     `requireRows` would report "you don't have permission to manage this
 *     channel" about a channel the caller manages perfectly well.
 *
 * Writing the members first means the creator (whom `ensureEditor` always keeps
 * in the list) already holds their row before visibility narrows, and the
 * UPDATE below always scans a row the caller can still see: going private, the
 * old row is public; going public, the caller was a member of the private one.
 *
 * Nothing is half-applied by putting the gate last: `channels_update`'s USING
 * clause and `channel_is_manageable` — which is what the `channel_members`
 * policies check — are the same predicate, so a caller whose member writes were
 * accepted cannot then be refused here.
 *
 * Known, deliberate asymmetry on the way back out: opening a private channel up
 * sets `members: []` in the store, but the creator's own row survives in the
 * database because Invariant 3 forbids deleting it. After a reload that channel
 * therefore carries one member it did not carry a moment earlier. Nothing reads
 * it — `can_see_conversation` short-circuits on `is_private = false`, and so
 * does `channelIsViewerOnly` in the store — and the alternative is worse: the
 * DELETE would raise, and a legal change would be reported as a failure.
 */
export async function setChannelAccess(
  client: LuminaClient,
  channelId: string,
  patch: ChannelAccessPatch
): Promise<void> {
  const what = "updating that channel's access";

  const channel = await client
    .from("channels")
    .select("id,created_by")
    .eq("id", channelId)
    .maybeSingle();
  if (channel.error) fail(what, channel.error);
  if (!channel.data) {
    throw new Error(`${what} failed: you don't have permission to manage this channel`);
  }

  const current = await client
    .from("channel_members")
    .select("user_id")
    .eq("channel_id", channelId);
  if (current.error) fail(what, current.error);

  const plan = membershipPlan(
    (current.data ?? []).map((r) => r.user_id),
    patch.members,
    channel.data.created_by
  );

  if (plan.kept.length > 0) {
    const written = await client.from("channel_members").upsert(
      plan.kept.map((m) => ({
        channel_id: channelId,
        user_id: m.userId,
        level: m.level,
      })),
      { onConflict: "channel_id,user_id" }
    );
    if (written.error) fail(what, written.error);
  }

  requireRows(
    what,
    "you don't have permission to manage this channel",
    await client
      .from("channels")
      .update({ is_private: patch.isPrivate })
      .eq("id", channelId)
      .select("id")
  );

  if (plan.removed.length > 0) {
    const removed = await client
      .from("channel_members")
      .delete()
      .eq("channel_id", channelId)
      .in("user_id", plan.removed);
    if (removed.error) fail(what, removed.error);
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(
  client: LuminaClient,
  project: Project
): Promise<Project> {
  const row = await client.from("projects").insert({
    id: project.id,
    name: project.name,
    description: project.description,
    emoji: project.emoji,
    color: project.color,
    priority: project.priority,
    restricted: project.restricted,
    created_by: project.createdBy,
    created_at: new Date(project.createdAt).toISOString(),
  });
  if (row.error) fail("creating that project", row.error);

  if (project.members.length > 0) {
    const members = await client.from("project_members").insert(
      project.members.map((m) => ({
        project_id: project.id,
        user_id: m.userId,
        level: m.level,
      }))
    );
    if (members.error) {
      await client.from("projects").delete().eq("id", project.id);
      fail("creating that project", members.error);
    }
  }

  // A brand-new project has no files in practice (`createProject` in
  // lib/store.tsx builds it with `attachments: []`), but the parameter can
  // carry them and dropping them silently is the failure mode this plan keeps
  // closing. The bytes are already in Storage by now; this links them.
  if (project.attachments.length > 0) {
    await syncAttachmentLinks(
      client,
      "project",
      project.id,
      project.attachments,
      "creating that project"
    );
  }

  return project;
}

/**
 * The editable fields, `attachments` now included (Task 10).
 *
 * Files are three separate things and this only owns the third. The BYTES are
 * already in Storage before this runs — `readFileAsAttachment` put them there
 * from the file picker's own handler — and a save from an in-app editor has
 * already overwritten them through `saveAttachment`. What is left is the
 * project's *list*: link what arrived, and delete what left, bytes and row
 * together (see `syncAttachmentLinks`).
 *
 * ORDER. The scalar UPDATE goes first and the attachment sync second, which
 * is the safe direction under Task 6's rule: none of `name`/`description`/
 * `emoji`/`colour`/`priority` is an input to `can_see_project`, so neither
 * statement can make the caller lose sight of their own project mid-write —
 * but `project_attachments_insert` is answered by `project_is_manageable`,
 * which reads `projects`, so the sync is the one that would notice. Doing it
 * last means it is never evaluated against a half-written row.
 *
 * NOT TRANSACTIONAL, like `setProjectAccess` and `updateTask` before it: a
 * rename that lands followed by a refused link leaves the rename applied.
 * `commit` rolls the screen back and the next hydrate corrects it, so nothing
 * is shown that a reload would not. An RPC would close the window.
 *
 * A patch that names no persistable field at all is a no-op, not a write — it
 * must not issue an empty UPDATE, which PostgREST rejects outright.
 */
export async function updateProject(
  client: LuminaClient,
  projectId: string,
  patch: ProjectPatch
): Promise<void> {
  // Spread rather than assignment so the object's inferred type stays exactly
  // the set of columns being written — PostgREST's generated `Update` type
  // rejects a `Record<string, unknown>`, and rightly: a typo in a key would
  // otherwise compile and update nothing.
  const row = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
  };
  if (Object.keys(row).length > 0) {
    requireRows(
      "saving that project",
      "you don't have permission to edit this project",
      await client.from("projects").update(row).eq("id", projectId).select("id")
    );
  }

  if (patch.attachments !== undefined) {
    await syncAttachmentLinks(
      client,
      "project",
      projectId,
      patch.attachments,
      "saving that project's files"
    );
  }
}

/** One delete. The cascade takes the project's tasks (and with them their
 *  collaborators and attachment links), its member rows, its attachment links,
 *  and every activity scoped to it. */
export async function deleteProject(
  client: LuminaClient,
  projectId: string
): Promise<void> {
  requireRows(
    "deleting that project",
    "you don't have permission to delete this project",
    await client.from("projects").delete().eq("id", projectId).select("id")
  );
}

/**
 * Restriction plus membership — and the collaborator pruning that has to agree
 * with what the store already did optimistically.
 *
 * The store prunes client-side (`setProjectAccess` in lib/store.tsx: every
 * collaborator on this project's tasks who cannot see the project under the
 * *new* access state is dropped) so the board is correct the instant the dialog
 * closes. The database prunes too, but only through
 * `project_members_prune_collaborators`, which fires on a `project_members`
 * DELETE. That covers **revoking a listed member** and nothing else — so a
 * project going from open to restricted, where nobody's member row is deleted
 * because nobody had one, would leave every collaborator row standing while the
 * screen showed them gone. The sweep at the end closes exactly that gap.
 *
 * The sweep asks the server who can still see the project
 * (`user_can_see_project`, the same function the trigger calls) rather than
 * re-deriving it here. Re-deriving would put a third copy of the visibility
 * rule in the codebase, and the whole point of this operation is that the
 * copies agree.
 *
 * Statement order is load-bearing, and pinned from both ends:
 *   1. read the tasks and their collaborators, and pre-flight the capability,
 *      BEFORE any write — see below.
 *   2. upsert the surviving member list. This must come BEFORE the restriction
 *      for the reason spelled out in `setChannelAccess`: an upsert needs the
 *      table's SELECT policy, and once `restricted` is true a caller with no
 *      member row of their own may no longer satisfy `can_see_project`.
 *   3. `projects.restricted`.
 *   4. remove genuinely departed members — AFTER the restriction, because the
 *      trigger evaluates `user_can_see_project` as it fires. Run before it,
 *      every removal would still see `restricted = false`, conclude everyone
 *      can see the project, and prune nobody.
 *   5. sweep whatever step 4 could not reach.
 *
 * Only removed members are ever deleted; everyone else is upserted, which is an
 * UPDATE and fires no trigger. See the file header for why that matters.
 */
export async function setProjectAccess(
  client: LuminaClient,
  projectId: string,
  patch: ProjectAccessPatch
): Promise<void> {
  const what = "updating that project's access";

  const tasks = await client.from("tasks").select("id").eq("project_id", projectId);
  if (tasks.error) fail(what, tasks.error);
  const taskIds = (tasks.data ?? []).map((t) => t.id);

  const collaborators =
    taskIds.length > 0
      ? await client.from("task_collaborators").select("user_id").in("task_id", taskIds)
      : { data: [] as { user_id: string }[], error: null };
  if (collaborators.error) fail(what, collaborators.error);
  const collaboratorIds = [...new Set((collaborators.data ?? []).map((c) => c.user_id))];

  // Pre-flight, before anything is written. `task_collaborators_delete`
  // additionally requires `task.edit`, which `projects_update` does not — so a
  // custom role holding project.create without task.edit could change the
  // access and then have every pruning delete silently filtered away, leaving
  // revoked people attached to tasks while the screen showed them removed.
  // Refusing up front means the whole operation is undone by `commit` and
  // nothing is half-applied. No role this workspace ships is in that position
  // (Admin holds everything; Member holds task.edit but not project.create), so
  // this is a guard against a role somebody builds, not against today's data.
  if (patch.restricted && collaboratorIds.length > 0) {
    const allowed = await client.rpc("has_permission", { perm: "task.edit" });
    if (allowed.error) fail(what, allowed.error);
    if (allowed.data !== true) {
      throw new Error(
        `${what} failed: changing who can see this project also removes people from its tasks, which your role can't do`
      );
    }
  }

  const existing = await client
    .from("projects")
    .select("id,created_by")
    .eq("id", projectId)
    .maybeSingle();
  if (existing.error) fail(what, existing.error);
  if (!existing.data) {
    throw new Error(`${what} failed: you don't have permission to manage this project`);
  }

  const current = await client
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);
  if (current.error) fail(what, current.error);

  const plan = membershipPlan(
    (current.data ?? []).map((r) => r.user_id),
    patch.members,
    existing.data.created_by
  );

  if (plan.kept.length > 0) {
    const written = await client.from("project_members").upsert(
      plan.kept.map((m) => ({
        project_id: projectId,
        user_id: m.userId,
        level: m.level,
      })),
      { onConflict: "project_id,user_id" }
    );
    if (written.error) fail(what, written.error);
  }

  requireRows(
    what,
    "you don't have permission to manage this project",
    await client
      .from("projects")
      .update({ restricted: patch.restricted })
      .eq("id", projectId)
      .select("id")
  );

  if (plan.removed.length > 0) {
    const removed = await client
      .from("project_members")
      .delete()
      .eq("project_id", projectId)
      .in("user_id", plan.removed);
    if (removed.error) fail(what, removed.error);
  }

  await sweepCollaborators(client, projectId, taskIds, collaboratorIds, what);
}

/**
 * Drop the collaborator rows the trigger could not reach.
 *
 * Runs after the access change, so `user_can_see_project` is answering about
 * the state that now exists rather than a hypothetical one. Rows the trigger
 * already removed simply are not there any more, which makes this idempotent
 * rather than redundant.
 *
 * An unrestricted project needs no sweep at all: `user_can_see_project` returns
 * true for everybody on the `restricted = false` branch, which is also why the
 * trigger prunes nobody when a project is opened up.
 */
async function sweepCollaborators(
  client: LuminaClient,
  projectId: string,
  taskIds: string[],
  collaboratorIds: string[],
  what: string
): Promise<void> {
  if (collaboratorIds.length === 0 || taskIds.length === 0) return;

  const invisible: string[] = [];
  for (const userId of collaboratorIds) {
    const seen = await client.rpc("user_can_see_project", {
      project_id: projectId,
      user_id: userId,
    });
    if (seen.error) fail(what, seen.error);
    if (seen.data !== true) invisible.push(userId);
  }
  if (invisible.length === 0) return;

  const pruned = await client
    .from("task_collaborators")
    .delete()
    .in("task_id", taskIds)
    .in("user_id", invisible)
    .select("user_id");
  if (pruned.error) fail(what, pruned.error);

  // Deliberately no row-count assertion. The trigger in step 3 has usually
  // already deleted some or all of these, so "fewer rows than users" is the
  // normal case, not a filtered-away write. What must be true is that none
  // survive; the pre-flight above is what guarantees the delete was permitted
  // to run at all.
  const survivors = await client
    .from("task_collaborators")
    .select("user_id")
    .in("task_id", taskIds)
    .in("user_id", invisible);
  if (survivors.error) fail(what, survivors.error);
  if ((survivors.data ?? []).length > 0) {
    throw new Error(
      `${what} failed: ${survivors.data!.length} collaborator(s) could not be removed from this project's tasks`
    );
  }
}
