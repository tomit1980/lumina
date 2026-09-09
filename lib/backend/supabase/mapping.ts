/**
 * Row → model mapping. Pure: no client, no network, no `Date.now()`, so the
 * whole translation layer is testable from fixture rows alone (see
 * tests/qa/supabase-mapping.test.ts).
 *
 * The database and `lib/types.ts` do not agree on names, shapes or units, and
 * every disagreement is resolved here rather than being smeared across the
 * query file. The full list, because each one is a place a silent bug could
 * live:
 *
 *   1. `tasks.position` (int) → `Task.order`. Different name, same meaning.
 *   2. `task_collaborators` join rows → `Task.collaboratorIds`. One row per
 *      collaborator; the model wants one array per task.
 *   3. `read_state` rows → `AppState.lastRead`, keyed `${userId}:${convId}`.
 *      The key carries the user id even though RLS only ever returns the
 *      current user's rows, because the model's key shape is per-user.
 *   4. `timestamptz` strings → epoch milliseconds. Every timestamp column:
 *      `created_at`, `edited_at`, `due_date`, `ts`, `last_read_at`,
 *      `uploaded_at`, `attachments.edited_at`.
 *   5. `messages.conversation_id` → `Message.channelId`. The model's field
 *      predates DMs and holds a channel id *or* a DM id.
 *   6. `dm_members` join rows → `DM.memberIds`, which is a fixed
 *      `[string, string]` tuple. A thread that does not have exactly two
 *      visible members cannot be represented and is dropped (see `toDms`).
 *   7. `reactions` rows (message_id, emoji, user_id) → `Reaction[]`, one
 *      entry per emoji with a `userIds` array.
 *   8. `attachments.mime` → `Attachment.type`, and `storage_path` has no
 *      model field at all: the bytes live in Storage, which Plan 3 wires up.
 *      Until then `dataUrl` is the empty string — not a fabricated value.
 *   9. Nullable owner columns. `created_by`, `author_id`, `actor_id` and
 *      `uploaded_by` are all `on delete set null` in the schema but
 *      non-nullable in the model. Null becomes `""`, which matches no user
 *      and renders as unknown, rather than being dropped.
 *  10. `profiles` has no presence column — the schema carries no presence at
 *      all. The signed-in user is `online`, everyone else `offline`. This is
 *      the honest answer to "we do not know", not a guess.
 *  11. Generated column types are widened to `string` where Postgres uses a
 *      CHECK constraint (`status`, `priority`, `kind`, `level`) or a text
 *      array (`roles.permissions`). Each is narrowed back to its union here.
 *  12. `profiles.email` and `profiles.mfa_required` exist in the database and
 *      have no model field. Deliberately not carried into `AppState`: auth
 *      owns both, and `AppState` is handed to every component.
 */
import { ALL_PERMISSIONS } from "../../permissions";
import { SEED_VERSION } from "../../seed";
import type { Database } from "../../database.types";
import {
  PRIORITIES,
  TASK_STATUSES,
  type AccessLevel,
  type Activity,
  type ActivityKind,
  type AppState,
  type Attachment,
  type Channel,
  type DM,
  type Message,
  type MessageAttachment,
  type Permission,
  type Priority,
  type Project,
  type Reaction,
  type ResourceMember,
  type RoleDef,
  type Task,
  type TaskStatus,
  type User,
} from "../../types";

type Row<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

export type ProfileRow = Row<"profiles">;
export type RoleRow = Row<"roles">;
export type ChannelRow = Row<"channels">;
export type ChannelMemberRow = Row<"channel_members">;
export type DmRow = Row<"dms">;
export type DmMemberRow = Row<"dm_members">;
export type MessageRow = Row<"messages">;
export type ReactionRow = Row<"reactions">;
export type MessageAttachmentRow = Row<"message_attachments">;
export type AttachmentRow = Row<"attachments">;
export type ProjectRow = Row<"projects">;
export type ProjectMemberRow = Row<"project_members">;
export type ProjectAttachmentRow = Row<"project_attachments">;
export type TaskRow = Row<"tasks">;
export type TaskCollaboratorRow = Row<"task_collaborators">;
export type TaskAttachmentRow = Row<"task_attachments">;
export type ActivityRow = Row<"activities">;
export type ReadStateRow = Row<"read_state">;

/** Everything one `hydrate()` fetched, before any of it is a model. */
export interface HydrateRows {
  /** `auth.uid()`, which is also `profiles.id` — the chain the plan asks for. */
  currentUserId: string;
  profiles: ProfileRow[];
  roles: RoleRow[];
  channels: ChannelRow[];
  channelMembers: ChannelMemberRow[];
  dms: DmRow[];
  dmMembers: DmMemberRow[];
  messages: MessageRow[];
  reactions: ReactionRow[];
  messageAttachments: MessageAttachmentRow[];
  attachments: AttachmentRow[];
  projects: ProjectRow[];
  projectMembers: ProjectMemberRow[];
  projectAttachments: ProjectAttachmentRow[];
  tasks: TaskRow[];
  taskCollaborators: TaskCollaboratorRow[];
  taskAttachments: TaskAttachmentRow[];
  activities: ActivityRow[];
  readState: ReadStateRow[];
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Mismatch 4. Postgres hands back ISO-8601 with a zone offset and up to
 *  microsecond precision; `Date.parse` truncates to milliseconds, which is
 *  exactly the model's unit. */
export function toEpoch(ts: string): number {
  return Date.parse(ts);
}

export function toEpochOrNull(ts: string | null): number | null {
  return ts === null ? null : Date.parse(ts);
}

/** Mismatch 9. */
function owner(id: string | null): string {
  return id ?? "";
}

/** Mismatch 11. */
function toLevel(level: string): AccessLevel {
  return level === "viewer" ? "viewer" : "editor";
}

function toStatus(status: string): TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(status)
    ? (status as TaskStatus)
    : "backlog";
}

function toPriority(priority: string): Priority {
  return (PRIORITIES as readonly string[]).includes(priority)
    ? (priority as Priority)
    : "medium";
}

const ACTIVITY_KINDS: readonly string[] = [
  "task",
  "message",
  "channel",
  "member",
  "project",
];

function toKind(kind: string): ActivityKind {
  return ACTIVITY_KINDS.includes(kind) ? (kind as ActivityKind) : "message";
}

/** Drops permission strings this build does not know about, so an unknown
 *  value can never reach the permission UI as a checkbox nobody can explain.
 *  A role that gains a permission the client is too old to render simply does
 *  not show it — the server still enforces it. */
function toPermissions(permissions: string[]): Permission[] {
  return permissions.filter((p): p is Permission =>
    (ALL_PERMISSIONS as string[]).includes(p)
  );
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupBy<T, K extends string>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Mismatch 10 and 12. */
export function toUser(row: ProfileRow, currentUserId: string): User {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    title: row.title,
    roleId: row.role_id,
    color: row.color,
    presence: row.id === currentUserId ? "online" : "offline",
  };
}

export function toRole(row: RoleRow): RoleDef {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    permissions: toPermissions(row.permissions),
    isSystem: row.is_system,
    locked: row.locked,
  };
}

export function toChannel(row: ChannelRow, members: ResourceMember[]): Channel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isPrivate: row.is_private,
    isTeam: row.is_team,
    members,
    createdBy: owner(row.created_by),
    createdAt: toEpoch(row.created_at),
  };
}

/** Mismatch 8. `storage_path` is not carried: it is a Storage key, and the
 *  component layer only ever reads `dataUrl`. Plan 3 fills that in; an
 *  invented value here would render as a broken image and look like a bug in
 *  the file rather than in the plan. */
export function toAttachment(row: AttachmentRow): Attachment {
  const editedAt = toEpochOrNull(row.edited_at);
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    type: row.mime,
    dataUrl: "",
    uploadedBy: owner(row.uploaded_by),
    uploadedAt: toEpoch(row.uploaded_at),
    ...(row.edited_by !== null ? { editedBy: row.edited_by } : {}),
    ...(editedAt !== null ? { editedAt } : {}),
  };
}

export function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    ts: toEpoch(row.ts),
    actorId: owner(row.actor_id),
    text: row.text,
    kind: toKind(row.kind),
  };
}

/** Mismatch 7. Emoji keep first-seen order; each `userIds` keeps row order. */
export function toReactions(rows: ReactionRow[]): Reaction[] {
  const byEmoji = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = byEmoji.get(row.emoji);
    if (bucket) bucket.push(row.user_id);
    else byEmoji.set(row.emoji, [row.user_id]);
  }
  return [...byEmoji].map(([emoji, userIds]) => ({ emoji, userIds }));
}

/** Mismatch 6. A DM row whose membership does not resolve to exactly two
 *  visible people cannot be expressed as `[string, string]`, so it is
 *  dropped rather than padded with an id that matches nobody. Ids are sorted
 *  so the tuple is stable across hydrates; no caller depends on the order
 *  (`lib/store.tsx` only ever uses `.includes` and `.find` on it). */
export function toDms(rows: DmRow[], memberRows: DmMemberRow[]): DM[] {
  const byDm = groupBy(memberRows, (r) => r.dm_id);
  const out: DM[] = [];
  for (const row of rows) {
    const ids = (byDm.get(row.id) ?? []).map((m) => m.user_id).sort();
    if (ids.length !== 2) continue;
    out.push({ id: row.id, memberIds: [ids[0], ids[1]], createdAt: toEpoch(row.created_at) });
  }
  return out;
}

/** Mismatch 3. */
export function toLastRead(rows: ReadStateRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[`${row.user_id}:${row.conversation_id}`] = toEpoch(row.last_read_at);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole workspace
// ---------------------------------------------------------------------------

/**
 * Assembles one `AppState`. Everything in `rows` has already been filtered by
 * RLS — this function adds no visibility rules of its own, on purpose: a row
 * that reached here is a row the database decided the user may hold, and
 * re-filtering it client-side would mask a policy bug instead of surfacing it.
 */
export function toAppState(rows: HydrateRows): AppState {
  const attachmentsById = new Map(rows.attachments.map((a) => [a.id, a]));

  const channelMembersByChannel = groupBy(rows.channelMembers, (r) => r.channel_id);
  const projectMembersByProject = groupBy(rows.projectMembers, (r) => r.project_id);
  const reactionsByMessage = groupBy(rows.reactions, (r) => r.message_id);
  const messageAttachmentsByMessage = groupBy(rows.messageAttachments, (r) => r.message_id);
  const projectAttachmentsByProject = groupBy(rows.projectAttachments, (r) => r.project_id);
  const taskAttachmentsByTask = groupBy(rows.taskAttachments, (r) => r.task_id);
  const collaboratorsByTask = groupBy(rows.taskCollaborators, (r) => r.task_id);

  const members = (
    rowsForResource: Array<{ user_id: string; level: string }> | undefined
  ): ResourceMember[] =>
    (rowsForResource ?? []).map((m) => ({ userId: m.user_id, level: toLevel(m.level) }));

  /** Join rows whose attachment the caller cannot see are skipped. That can
   *  happen legitimately: `attachments_read` and the join table's own read
   *  policy are separate gates. */
  const filesFor = (ids: string[]): Attachment[] =>
    ids
      .map((id) => attachmentsById.get(id))
      .filter((a): a is AttachmentRow => a !== undefined)
      .map(toAttachment);

  return {
    version: SEED_VERSION,
    currentUserId: rows.currentUserId,
    users: rows.profiles.map((p) => toUser(p, rows.currentUserId)),
    roles: rows.roles.map(toRole),
    channels: rows.channels.map((c) =>
      toChannel(c, members(channelMembersByChannel.get(c.id)))
    ),
    dms: toDms(rows.dms, rows.dmMembers),
    messages: rows.messages.map((m): Message => {
      const links = messageAttachmentsByMessage.get(m.id) ?? [];
      return {
        id: m.id,
        // Mismatch 5.
        channelId: m.conversation_id,
        authorId: owner(m.author_id),
        content: m.content,
        createdAt: toEpoch(m.created_at),
        ...(m.edited_at !== null ? { editedAt: toEpoch(m.edited_at) } : {}),
        reactions: toReactions(reactionsByMessage.get(m.id) ?? []),
        attachments: links
          .map((link): MessageAttachment | null => {
            const file = attachmentsById.get(link.attachment_id);
            if (!file) return null;
            return {
              ...toAttachment(file),
              ...(link.source_project_id !== null
                ? { sourceProjectId: link.source_project_id }
                : {}),
            };
          })
          .filter((a): a is MessageAttachment => a !== null),
      };
    }),
    projects: rows.projects.map(
      (p): Project => ({
        id: p.id,
        name: p.name,
        description: p.description,
        emoji: p.emoji,
        color: p.color,
        priority: toPriority(p.priority),
        restricted: p.restricted,
        members: members(projectMembersByProject.get(p.id)),
        attachments: filesFor(
          (projectAttachmentsByProject.get(p.id) ?? []).map((l) => l.attachment_id)
        ),
        createdBy: owner(p.created_by),
        createdAt: toEpoch(p.created_at),
      })
    ),
    tasks: rows.tasks.map(
      (t): Task => ({
        id: t.id,
        projectId: t.project_id,
        title: t.title,
        description: t.description,
        status: toStatus(t.status),
        priority: toPriority(t.priority),
        assigneeId: t.assignee_id,
        dueDate: toEpochOrNull(t.due_date),
        startTime: t.start_time,
        durationMinutes: t.duration_minutes,
        reminderMinutes: t.reminder_minutes,
        labels: t.labels,
        attachments: filesFor(
          (taskAttachmentsByTask.get(t.id) ?? []).map((l) => l.attachment_id)
        ),
        // Mismatch 1.
        order: t.position,
        createdAt: toEpoch(t.created_at),
        createdBy: owner(t.created_by),
        // Mismatch 2.
        collaboratorIds: (collaboratorsByTask.get(t.id) ?? []).map((c) => c.user_id),
      })
    ),
    activities: rows.activities.map(toActivity),
    lastRead: toLastRead(rows.readState),
  };
}

/**
 * The workspace of a signed-out browser: structurally valid, entirely empty,
 * and — critically — carrying no rows from whoever was signed in a moment ago.
 * `Backend.reset()` resolves with this.
 *
 * `users` is not empty: `lib/store.tsx` computes `currentUser` as
 * `users.find(...) ?? users[0]`, and `SessionBridge` renders *outside*
 * `AuthGate`, so it reads `currentUser.id` on the signed-out screen too. A
 * genuinely empty array would make that a TypeError on every sign-out. The
 * single entry is a nobody — no name, no permissions, an id that matches no
 * profile — not a fabricated colleague.
 */
export function signedOutState(): AppState {
  return {
    version: SEED_VERSION,
    currentUserId: "",
    users: [
      {
        id: "",
        name: "",
        handle: "",
        title: "",
        roleId: "",
        color: "#71717a",
        presence: "offline",
      },
    ],
    channels: [],
    dms: [],
    messages: [],
    projects: [],
    tasks: [],
    activities: [],
    roles: [],
    lastRead: {},
  };
}
