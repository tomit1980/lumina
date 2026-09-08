/**
 * The persistence seam. `lib/store.tsx` owns the in-memory `AppState`, the
 * permission guards and the optimistic patches; everything that has to
 * *outlive the tab* goes through this interface.
 *
 * Shape rules (from the plan's Architecture section):
 * - One method per store write action, named after it, taking plain data —
 *   never a React updater and never the whole `AppState`. The store has
 *   already applied the optimistic patch by the time one of these is called,
 *   so a method only needs the row (or the id + patch) it is persisting.
 * - Methods that create something resolve with the created row, so a real
 *   backend can hand back server-assigned values (ids, positions, timestamps)
 *   for the store to adopt. Everything else resolves with `void`.
 * - A rejection means "this write did not happen". The store rolls back and
 *   toasts; implementations must not swallow their own errors.
 *
 * Two implementations: `LocalBackend` (today's localStorage behaviour, every
 * operation resolving immediately) and, from Task 4, `SupabaseBackend`.
 */
import type {
  AppState,
  Attachment,
  Channel,
  DM,
  Message,
  Permission,
  Project,
  ResourceMember,
  RoleDef,
  Task,
  TaskStatus,
} from "../types";

/** The editable fields of a role, as `updateRole` receives them. */
export interface RolePatch {
  name?: string;
  description?: string;
  color?: string;
  permissions?: Permission[];
}

/** The editable fields of a project, as `updateProject` receives them. */
export type ProjectPatch = Partial<
  Pick<Project, "name" | "description" | "emoji" | "color" | "priority" | "attachments">
>;

/** The editable fields of a task, as `updateTask` receives them. */
export type TaskPatch = Partial<Omit<Task, "id" | "projectId">>;

export interface ChannelAccessPatch {
  isPrivate: boolean;
  members: ResourceMember[];
}

export interface ProjectAccessPatch {
  restricted: boolean;
  members: ResourceMember[];
}

/**
 * What a file hangs off. Attachments ride along inside the project/task/
 * message rows today because `LocalBackend` persists one JSON blob, but their
 * *bytes* cannot live in a Postgres row — Plan 3 moves them to Storage and
 * fills in the two operations below. Declared here now so the seam Tasks 4–8
 * implement against is complete and `SupabaseBackend` has a named place to
 * return its typed "not available yet" from.
 */
export type AttachmentOwner =
  | { kind: "project"; id: string }
  | { kind: "task"; id: string }
  | { kind: "message"; id: string };

export interface Backend {
  /** The whole visible workspace for the current user. */
  hydrate(): Promise<AppState>;
  /** Drops everything this backend holds and resolves with the state to
   *  adopt in its place (a fresh seed locally; a signed-out shell later). */
  reset(): Promise<AppState>;
  /**
   * Called after every state change. `LocalBackend` snapshots the whole
   * `AppState` to localStorage — that snapshot *is* its write path, which is
   * why its per-action methods can resolve immediately. A row-oriented
   * backend has nothing to do here: each operation already wrote its own
   * rows, so it is a no-op.
   */
  persist(state: AppState): void;

  // Members and roles.
  switchUser(userId: string): Promise<void>;
  setUserRole(userId: string, roleId: string): Promise<void>;
  createRole(role: RoleDef): Promise<RoleDef>;
  updateRole(roleId: string, patch: RolePatch): Promise<void>;
  setRolePermission(
    roleId: string,
    permission: Permission,
    enabled: boolean
  ): Promise<void>;
  deleteRole(roleId: string): Promise<void>;

  // Messages, DMs, reactions, read state.
  sendMessage(message: Message): Promise<Message>;
  /** One operation, because a DM's first message must not be able to create
   *  the thread and then fail to post into it. `isNewDm` tells the backend
   *  whether the thread still has to be created. */
  sendToUser(dm: DM, isNewDm: boolean, message: Message): Promise<DM>;
  editMessage(messageId: string, content: string, editedAt: number): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  toggleReaction(messageId: string, emoji: string): Promise<void>;
  markChannelRead(conversationId: string, readAt: number): Promise<void>;

  // Channels and DM threads.
  createChannel(channel: Channel): Promise<Channel>;
  deleteChannel(channelId: string): Promise<void>;
  setChannelAccess(channelId: string, patch: ChannelAccessPatch): Promise<void>;
  openDm(dm: DM): Promise<DM>;

  // Projects.
  createProject(project: Project): Promise<Project>;
  updateProject(projectId: string, patch: ProjectPatch): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  setProjectAccess(projectId: string, patch: ProjectAccessPatch): Promise<void>;

  // Tasks.
  createTask(task: Task): Promise<Task>;
  updateTask(taskId: string, patch: TaskPatch): Promise<void>;
  moveTask(taskId: string, toStatus: TaskStatus, toIndex: number): Promise<void>;
  deleteTask(taskId: string): Promise<void>;

  // Attachment bytes — see `AttachmentOwner` above. Plan 3 wires these to
  // Storage; until then the owning row carries the file inline.
  putAttachment(owner: AttachmentOwner, attachment: Attachment): Promise<void>;
  deleteAttachment(owner: AttachmentOwner, attachmentId: string): Promise<void>;
}
