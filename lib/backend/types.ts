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
  Activity,
  AppState,
  Attachment,
  Channel,
  DM,
  Message,
  Permission,
  Project,
  ResourceMember,
  RoleDef,
  Priority,
  StatusDef,
  Task,
  TaskSet,
  TaskSetItem,
  TaskStatus,
} from "../types";

/** The editable fields of a role, as `updateRole` receives them. */
export interface RolePatch {
  name?: string;
  description?: string;
  color?: string;
  permissions?: Permission[];
}

/**
 * Files a patch takes AWAY, named one by one.
 *
 * `attachments` is a list the caller believes in, not an assertion about the
 * server: every producer of one is a snapshot (a dialog's form state, a
 * render's closure) that a colleague's upload can invalidate at any moment.
 * A backend must therefore never read "absent from this array" as "delete
 * this file" — that is QA-101, where saving a task dialog to change its title
 * permanently destroyed a file somebody else had attached while it was open.
 *
 * So a removal has to be *said*. Only the UI that ran the remove knows one
 * happened, and only these ids are ever deleted.
 */
export interface AttachmentRemovals {
  /** Ids the user removed in this edit. Absent means "this patch removes
   *  nothing", which is what every caller that only adds or edits wants. */
  removedAttachmentIds?: string[];
}

/** The editable fields of a project, as `updateProject` receives them. */
export type ProjectPatch = Partial<
  Pick<Project, "name" | "description" | "emoji" | "color" | "priority" | "attachments">
> &
  AttachmentRemovals;

/** The editable fields of a task, as `updateTask` receives them. */
export type TaskPatch = Partial<Omit<Task, "id" | "projectId">> & AttachmentRemovals;

/** The editable fields of a status. `id` never changes — that is what keeps
 *  every existing task resolving and every status literal in the suite valid. */
export interface StatusPatch {
  name?: string;
  color?: string;
  isDone?: boolean;
}

/** The editable fields of a task set. `items` are edited through their own
 *  methods, so a rename cannot silently rewrite the list. */
export interface TaskSetPatch {
  name?: string;
  description?: string;
}

/** The editable fields of one line. `position` is changed by reordering the
 *  whole set, never by patching one row — same rule as a task's `order`. */
export interface TaskSetItemPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
}

export interface ChannelAccessPatch {
  isPrivate: boolean;
  members: ResourceMember[];
}

export interface ProjectAccessPatch {
  restricted: boolean;
  members: ResourceMember[];
}

/**
 * What kind of thing a file hangs off, which is all these two operations need
 * to know. Deliberately NOT the owning row's id: bytes are uploaded from the
 * composer and from the "add file" button *before* the message or the task
 * they will belong to exists, and the link that makes a file part of a
 * project, a task or a message is written by that row's own action
 * (`updateProject` / `createTask` / `sendMessage`), not here.
 *
 * On `SupabaseBackend` this selects the bucket; on `LocalBackend` it is
 * ignored, because the bytes go inline into the one JSON blob either way.
 */
export type AttachmentOwner = "project" | "task" | "message";

/**
 * A change the server pushed.
 *
 * `message-insert` is the one event applied directly — a brand-new message has
 * no reactions or attachments yet, so its row is self-contained, and it is the
 * case where latency is felt. Everything else is `stale`: the row-to-model
 * functions build from lookups grouped per load, so a lone row cannot rebuild
 * a task, project or DM (see the spec's "Why not per-row patching").
 *
 * A UNION, and deliberately an open-ended one: Task 4 added
 * `{ kind: "presence"; onlineUserIds: string[] }` — the WHOLE current online
 * set, not a delta, so the apply core can mark everyone else offline in the
 * same pass — and Task 5 added `{ kind: "connection"; online: boolean }`,
 * the channel's own subscribe status (SUBSCRIBED / CHANNEL_ERROR /
 * TIMED_OUT / CLOSED), so the store can say when it has stopped receiving
 * anything at all and reload once it starts again — a reconnect is the only
 * way to recover changes that happened while the socket was down, since the
 * server does not replay them. The apply core switches on `kind` with a
 * `default` that ignores what it does not know, so a variant added here
 * cannot crash a store that has not learned about it yet.
 */
export type RealtimeEvent =
  | { kind: "message-insert"; message: Message }
  | { kind: "stale" }
  | { kind: "presence"; onlineUserIds: string[] }
  | { kind: "connection"; online: boolean };

/** Teardown for `Backend.subscribe`. */
export type Unsubscribe = () => void;

export interface Backend {
  /** The whole visible workspace for the current user. */
  hydrate(): Promise<AppState>;
  /**
   * Appends one line to the activity feed.
   *
   * The exception to the "one method per write action" rule above, and
   * deliberately so. An activity is not part of the row a write produces: it
   * is an append-only *log line about* that write, several actions emit more
   * than one, and — critically — it must not be able to undo the thing it
   * describes. Bundling it into `createProject(project, activity)` would put
   * both writes behind one promise, so a rejected log line would reject the
   * project too and `commit` would roll a project that really exists off the
   * screen. (It would not even buy atomicity in exchange: supabase-js has no
   * client-side transaction, so a bundled parameter is still two statements.)
   *
   * `commit` (lib/store.tsx) therefore calls this AFTER the main write has
   * resolved, and treats a rejection as "the line was not logged", not "the
   * write did not happen": the real change stands, and the optimistic feed
   * entry is removed from `AppState` so the screen matches what a reload
   * would show. That reconciliation is the whole point — an activity that
   * appears and then vanishes on reload is the exact failure this seam exists
   * to stop.
   *
   * Resolves with `void`, never with the stored row. Reading an activity back
   * would evaluate `activities_read` against the row as the scan finds it,
   * which is the `RETURNING`/`on conflict` trap Task 6 hit twice; there is
   * nothing server-assigned to adopt here, so there is no reason to look.
   */
  putActivity(activity: Activity): Promise<void>;
  /** Drops everything this backend holds and resolves with the state to
   *  adopt in its place (a fresh seed locally; a signed-out shell later). */
  reset(): Promise<AppState>;
  /**
   * Live changes from the server. Returns a teardown. `LocalBackend` returns
   * an inert one: the demo has no server to hear from.
   *
   * The callback is the store's second writer, so what it is handed matters as
   * much as when. See `RealtimeEvent` below, and the apply core in
   * lib/store.tsx for the three rules that keep a pushed change from
   * interleaving destructively with an optimistic one.
   */
  subscribe(onEvent: (event: RealtimeEvent) => void): Unsubscribe;
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

  /**
   * Add a teammate: create their account outright, with a password the admin
   * chooses and passes on.
   *
   * Not a table write. Creating an account needs the service-role key, which
   * cannot ship to a browser, so this crosses to a Supabase Edge Function
   * (`supabase/functions/create-user`). The function re-derives every rule
   * from the caller's own token — it does not trust that the interface only
   * offered the button to an admin.
   *
   * No email is sent and none is needed, which keeps this clear of Supabase's
   * shared mail service and its few-per-hour cap.
   *
   * Resolves the new user's id. Rejects with a message fit to show.
   */
  createUser(input: {
    email: string;
    password: string;
    roleId: string;
    name?: string;
  }): Promise<string>;

  // The board's columns, workspace-wide. Gated on `workspace.statuses`, which
  // only the Owner role holds — see 20260910006000_owner_role.sql.
  createStatus(status: StatusDef): Promise<StatusDef>;
  updateStatus(statusId: string, patch: StatusPatch): Promise<void>;
  /** Refused by the database while any task still carries this status: the
   *  foreign key is `on delete restrict`, so the rule cannot be bypassed by
   *  calling the API directly. */
  deleteStatus(statusId: string): Promise<void>;
  /** Positions for the whole set at once — reordering is a rearrangement, not
   *  a series of independent edits, and sending it as one call keeps the
   *  board from passing through orders nobody asked for. */
  reorderStatuses(order: Array<{ id: string; position: number }>): Promise<void>;

  // Reusable task sets. Gated on `workspace.taskSets`, held by Owner and
  // Admin — see 20260911000200_task_sets.sql for why it is not `project.create`.
  /** Parent and lines in one call, so a set never exists without the items it
   *  was created with. Duplicating a set is this method with fresh ids, which
   *  is why there is no separate `duplicateTaskSet` to drift from it. */
  createTaskSet(set: TaskSet): Promise<TaskSet>;
  updateTaskSet(taskSetId: string, patch: TaskSetPatch): Promise<void>;
  /** Archive, not delete: reversible, and it keeps a project's
   *  `createdFromTaskSetId` pointing at something real. */
  archiveTaskSet(taskSetId: string, archived: boolean): Promise<void>;
  createTaskSetItem(taskSetId: string, item: TaskSetItem): Promise<void>;
  updateTaskSetItem(itemId: string, patch: TaskSetItemPatch): Promise<void>;
  deleteTaskSetItem(itemId: string): Promise<void>;
  /** The whole ordered list, like `reorderStatuses`. */
  reorderTaskSetItems(order: Array<{ id: string; position: number }>): Promise<void>;

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
  /**
   * A project, and the tasks a task set contributes to it.
   *
   * One call because they must arrive together: a project with half its tasks
   * is worse than no project. `tasks` is empty when no set was chosen, which
   * is the ordinary case and the one this signature must not make awkward.
   */
  createProject(project: Project, tasks: Task[]): Promise<Project>;
  updateProject(projectId: string, patch: ProjectPatch): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  setProjectAccess(projectId: string, patch: ProjectAccessPatch): Promise<void>;

  // Tasks.
  createTask(task: Task): Promise<Task>;
  updateTask(taskId: string, patch: TaskPatch): Promise<void>;
  moveTask(taskId: string, toStatus: TaskStatus, toIndex: number): Promise<void>;
  deleteTask(taskId: string): Promise<void>;

  // Attachment bytes — see `AttachmentOwner` above.
  //
  // These two are the only methods on this seam that take raw bytes, and the
  // only ones not called from a store action: `lib/attachments.ts` calls them
  // directly, because a file is turned into an `Attachment` in the file
  // picker's own handler, long before any write action sees it.
  /**
   * Stores a file's bytes and resolves with the reference to put in
   * `Attachment.dataUrl`: the `data:` URL itself on `LocalBackend`, a
   * `"<bucket>/<attachment-id>"` Storage path on `SupabaseBackend`.
   *
   * Rejecting means the file is not stored, and `readFileAsAttachment` turns
   * that into `{ ok: false, error }` — the same discriminated result a file
   * over the size cap produces, so callers have exactly one failure shape.
   */
  putAttachment(
    owner: AttachmentOwner,
    attachment: Attachment,
    file: Blob
  ): Promise<string>;
  /**
   * Replaces the bytes behind a file that already exists — the in-app
   * editors' Save. Resolves with the reference to store, which on
   * `SupabaseBackend` is the SAME one it had (the object is overwritten in
   * place, so every copy of the path stays valid).
   */
  saveAttachment(
    attachment: Attachment,
    file: Blob,
    editedBy: string,
    editedAt: number
  ): Promise<string>;
  /**
   * Discards stored bytes that never became part of anything — a file removed
   * from the chat composer before the message was sent. Attachments that were
   * saved and are later removed go out through their owner's write
   * (`updateProject` / `updateTask`), which knows what else changed.
   */
  deleteAttachment(attachment: Attachment): Promise<void>;
  /** A URL the browser can put in `src`/`href`. The reference itself on
   *  `LocalBackend`; a signed URL, minted per call, on `SupabaseBackend`. */
  attachmentUrl(ref: string, downloadName?: string): Promise<string>;
  /** The file's bytes as a `data:` URL — what the three document editors
   *  parse. `mime` restores the type Storage does not record. */
  readAttachment(ref: string, mime: string): Promise<string>;
}
