export type Permission =
  | "channel.create"
  | "channel.delete"
  | "project.create"
  | "project.delete"
  | "task.create"
  | "task.edit"
  | "task.move"
  | "task.delete"
  | "message.send"
  | "message.deleteAny"
  | "members.manage"
  /** Edit the board's columns for the whole workspace — the Owner's one
   *  power beyond Admin, and the line the rank rules defend. */
  | "workspace.statuses";

/** Fine-grained, per-resource access: "editor" is full read/write, "viewer" is read-only. */
export type AccessLevel = "viewer" | "editor";

export interface ResourceMember {
  userId: string;
  level: AccessLevel;
}

/** A role is a first-class, admin-editable entity. */
export interface RoleDef {
  id: string;
  name: string;
  description: string;
  /** Hex accent used for the role badge. */
  color: string;
  permissions: Permission[];
  /** Seeded roles (admin/member/guest) can't be deleted. */
  isSystem?: boolean;
  /** Locked roles (owner, admin) always hold every permission in their own
   *  set and can't be edited. */
  locked?: boolean;
  /**
   * Where this role sits in the hierarchy. Higher outranks lower.
   *
   * Owner 100, Admin 80, Member 40, Guest 20; a role someone creates gets
   * `DEFAULT_ROLE_RANK`. This is what "above" means for the four rules that
   * make Owner a real boundary rather than a label — you cannot grant a
   * permission you do not hold, nor edit, assign or create a role at or above
   * your own rank. Optional so a workspace stored before ranks existed still
   * parses; `migrate()` backfills it.
   */
  rank?: number;
}

export type Presence = "online" | "away" | "offline";

export interface User {
  id: string;
  name: string;
  handle: string;
  title: string;
  roleId: string;
  /** Hex used for the avatar backdrop. */
  color: string;
  presence: Presence;
}

export interface Channel {
  id: string;
  name: string;
  description: string;
  isPrivate: boolean;
  /** The whole-team room: every member belongs, can't be deleted, shown as “Team”. */
  isTeam?: boolean;
  /** Per-member access level. Only meaningful when isPrivate. */
  members: ResourceMember[];
  createdBy: string;
  createdAt: number;
}

/** A direct-message thread between exactly two people. */
export interface DM {
  id: string;
  memberIds: [string, string];
  createdAt: number;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export interface Message {
  id: string;
  /** Id of the containing conversation — a channel id or a DM id. */
  channelId: string;
  authorId: string;
  content: string;
  createdAt: number;
  editedAt?: number;
  reactions: Reaction[];
  /** Files on this message — uploaded in the composer, or shared from a project. */
  attachments: MessageAttachment[];
}

/**
 * A board column, as the workspace defines it.
 *
 * This used to be a five-member union baked into the type system, a `check`
 * constraint and a `STATUS_META` map, so a team could not rename a column to
 * match how they work, add one, or drop one they never use. Statuses are now
 * rows, `tasks.status` is a foreign key to them, and an Owner edits the set.
 *
 * `TaskStatus` is therefore a plain `string` — a foreign key into
 * `AppState.statuses`, exactly as `User.roleId` is one into `roles`. That is
 * also what let this change stay contained: the ~160 status literals across
 * the test suite are still valid, because the five seeded ids are unchanged.
 * Renaming a column changes `name`; `id` never moves.
 */
export type TaskStatus = string;

export interface StatusDef {
  id: string;
  /** What the column is called. The only thing a rename changes. */
  name: string;
  /** Hex, like `RoleDef.color` — NOT a Tailwind class. The old `STATUS_META`
   *  held `bg-sky-500` and friends, which cannot be built from user input
   *  because Tailwind only ships classes it can see at build time. */
  color: string;
  /** Column order on the board. Was the declaration order of an array. */
  position: number;
  /**
   * This column means the work is finished.
   *
   * Exactly one status carries it, enforced by a partial unique index. It
   * replaces the literal `"done"` that eighteen sites used to test — the
   * progress bar, the home statistics, reminder suppression, the
   * quick-complete toggle, the strike-through, and the activity feed's
   * "completed" line — none of which shared a helper, so a rename broke each
   * one independently.
   */
  isDone: boolean;
}

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  /** Epoch ms at midnight local, or null. */
  dueDate: number | null;
  /** "HH:MM" 24h local start time. With a dueDate, this makes the task a
   *  timed, calendar-able block; null means all-day / no specific time. */
  startTime: string | null;
  /** Length of the scheduled block in minutes. Only meaningful with startTime. */
  durationMinutes: number | null;
  /** Minutes before the start to fire an in-app reminder; null = no reminder. */
  reminderMinutes: number | null;
  labels: string[];
  attachments: Attachment[];
  /** Sort position within its status column. */
  order: number;
  createdAt: number;
  createdBy: string;
  /** User ids helping on this task, in addition to assigneeId. */
  collaboratorIds: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  emoji: string;
  /** Hex accent for the project. */
  color: string;
  priority: Priority;
  /** When true, only listed members (plus admins) can see or work in this project. */
  restricted: boolean;
  members: ResourceMember[];
  attachments: Attachment[];
  createdBy: string;
  createdAt: number;
}

export type ActivityKind = "task" | "message" | "channel" | "member" | "project";

export interface Activity {
  id: string;
  ts: number;
  actorId: string;
  text: string;
  kind: ActivityKind;
  /** The resource this activity's text names, so the feed can be filtered to
   *  what the reader is allowed to see (activities_read,
   *  20260909000900_activity_scope.sql). At most one is set: a project, a
   *  conversation (channel or DM — they share one table), or neither, which
   *  marks a workspace-wide event such as a role change that everyone may
   *  read. Text alone is unfilterable, which is how `created the Payroll
   *  project` used to reach every browser. */
  projectId?: string | null;
  conversationId?: string | null;
}

export interface AppState {
  version: number;
  currentUserId: string;
  users: User[];
  channels: Channel[];
  dms: DM[];
  messages: Message[];
  projects: Project[];
  tasks: Task[];
  activities: Activity[];
  /** All roles, including custom ones. The locked admin role is always
   *  full-access, so a workspace can never lock itself out. */
  roles: RoleDef[];
  /** The board's columns, workspace-wide. Ordered by `position` when
   *  rendered — see `sortedStatuses` in lib/statuses.ts. */
  statuses: StatusDef[];
  /** Key: `${userId}:${conversationId}` (channel or DM) → last-read epoch ms. */
  lastRead: Record<string, number>;
}

export const PRIORITY_META: Record<
  Priority,
  { label: string; className: string }
> = {
  high: { label: "High", className: "text-red-500" },
  medium: { label: "Medium", className: "text-amber-500" },
  low: { label: "Low", className: "text-zinc-400" },
};

export const QUICK_EMOJIS = ["👍", "❤️", "🎉", "😂", "👀", "🚀"] as const;

/** A file attached to a task or project. Content is stored inline as a data
 *  URL — there's no backend, so this app persists everything to localStorage. */
export interface Attachment {
  id: string;
  name: string;
  /** Bytes, before base64 encoding. */
  size: number;
  /** MIME type, e.g. "image/png". May be empty if the browser couldn't tell. */
  type: string;
  /** The file's contents as a data: URL. */
  dataUrl: string;
  uploadedBy: string;
  uploadedAt: number;
  /** Set when the file was last saved from Lumina's in-app editor. */
  editedBy?: string;
  editedAt?: number;
}

/** A file on a message. Uploaded in the composer → a full Attachment (dataUrl
 *  inline). Shared from a project's Files tab → same id/name/size/type, but
 *  dataUrl is "" and sourceProjectId is set: the bytes are resolved live from
 *  that project so nothing is stored twice (localStorage is tight). */
export interface MessageAttachment extends Attachment {
  sourceProjectId?: string;
}
