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
  | "members.manage";

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
  /** Locked roles (admin) always hold every permission and can't be edited. */
  locked?: boolean;
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

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in-progress",
  "in-review",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

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
  /** Key: `${userId}:${conversationId}` (channel or DM) → last-read epoch ms. */
  lastRead: Record<string, number>;
}

export const STATUS_META: Record<
  TaskStatus,
  { label: string; dot: string }
> = {
  backlog: { label: "Backlog", dot: "bg-zinc-400" },
  todo: { label: "To Do", dot: "bg-sky-500" },
  "in-progress": { label: "In Progress", dot: "bg-amber-500" },
  "in-review": { label: "In Review", dot: "bg-violet-500" },
  done: { label: "Done", dot: "bg-emerald-500" },
};

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
}

/** A file on a message. Uploaded in the composer → a full Attachment (dataUrl
 *  inline). Shared from a project's Files tab → same id/name/size/type, but
 *  dataUrl is "" and sourceProjectId is set: the bytes are resolved live from
 *  that project so nothing is stored twice (localStorage is tight). */
export interface MessageAttachment extends Attachment {
  sourceProjectId?: string;
}
