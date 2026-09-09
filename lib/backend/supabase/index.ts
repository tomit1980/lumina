/**
 * `SupabaseBackend` — the real backend.
 *
 * Task 4 implemented the read path; Task 5 the chat writes (delegated to
 * ./chat); Task 6 channels, projects and access (delegated to ./workspace);
 * Task 7 tasks and collaborators (delegated to ./tasks). The remaining writes
 * still reject with a named "not implemented" error, which Task 8 replaces.
 *
 * Why *reject* rather than no-op: the store has already applied the optimistic
 * patch by the time it calls one of these (see `commit` in lib/store.tsx), so
 * a method that resolved would leave the change on screen, toast nothing, and
 * persist nothing — a write that looks like it worked. A rejection is what
 * makes `commit` roll the patch back and tell the user.
 *
 * Why reject rather than `throw` synchronously: `commit` calls `op()` outside
 * a `try`, so a synchronous throw would escape past the rollback with the
 * optimistic patch still applied. `Promise.reject` keeps the failure on the
 * path that undoes it.
 */
import * as activityWrites from "./activity";
import * as chat from "./chat";
import { browserClient, type LuminaClient } from "./client";
import { hydrateWorkspace } from "./hydrate";
import { signedOutState } from "./mapping";
import * as tasks from "./tasks";
import * as workspace from "./workspace";
import type { AppState } from "../../types";
import type {
  Backend,
  ChannelAccessPatch,
  ProjectAccessPatch,
  ProjectPatch,
  TaskPatch,
} from "../types";
import type {
  Activity,
  Channel,
  DM,
  Message,
  Project,
  RoleDef,
  Task,
  TaskStatus,
} from "../../types";

/** `owner` names who fills this in, so a failure in the intervening weeks
 *  points straight at the task that owes it rather than at a mystery. */
function pending(method: string, owner: string): Promise<never> {
  return Promise.reject(
    new Error(`SupabaseBackend.${method}() is not implemented yet (${owner}).`)
  );
}

export class SupabaseBackend implements Backend {
  /** Test seam, mirroring `AuthProvider`'s `client` prop: the RLS suite
   *  builds one of these around a client signed in as a fixture user.
   *  Production passes nothing and the browser client is loaded on demand —
   *  dynamically, so `lib/supabase.ts` never enters the static graph. */
  constructor(private readonly injected?: LuminaClient) {}

  private client(): Promise<LuminaClient> {
    return this.injected ? Promise.resolve(this.injected) : browserClient();
  }

  async hydrate(): Promise<AppState> {
    return hydrateWorkspace(await this.client());
  }

  /** Sign-out. There is nothing to delete server-side — the rows belong to
   *  the workspace, not to this browser — so this only drops what the tab is
   *  holding, which is the whole point on a shared machine. */
  reset(): Promise<AppState> {
    return Promise.resolve(signedOutState());
  }

  /** Deliberately nothing. Each write persists its own rows; there is no
   *  whole-state snapshot to take. `lib/backend/types.ts` specifies exactly
   *  this for a row-oriented backend. */
  persist(): void {}

  /**
   * Identity comes from the session, so there is no "switch" to persist —
   * but there is something to *refuse*. `SessionBridge` calls this only to
   * align the store with the signed-in session, and after `hydrate()` sets
   * `currentUserId` from `auth.uid()` the two already agree. Any other value
   * would be an attempt to view the workspace as somebody else while RLS
   * kept filtering as the real user: the rows would be right and every label
   * and permission check wrong. Rejecting makes `commit` undo it.
   */
  async switchUser(userId: string): Promise<void> {
    const client = await this.client();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      throw new Error("Not signed in.");
    }
    if (data.user.id !== userId) {
      throw new Error("You can only act as the signed-in user.");
    }
  }

  /**
   * The activity feed. Implemented in ./activity; a single insert, never read
   * back. `commit` (lib/store.tsx) calls this after the main write resolves and
   * treats a rejection as "not logged" rather than "not written" — see
   * `Backend.putActivity` in lib/backend/types.ts for why the log line is a
   * separate call instead of a parameter on each write.
   */
  async putActivity(activity: Activity): Promise<void> {
    return activityWrites.putActivity(await this.client(), activity);
  }

  // -------------------------------------------------------------------------
  // Task 8 — roles and users.
  // -------------------------------------------------------------------------
  setUserRole(): Promise<void> {
    return pending("setUserRole", "store-swap task 8");
  }
  createRole(): Promise<RoleDef> {
    return pending("createRole", "store-swap task 8");
  }
  updateRole(): Promise<void> {
    return pending("updateRole", "store-swap task 8");
  }
  setRolePermission(): Promise<void> {
    return pending("setRolePermission", "store-swap task 8");
  }
  deleteRole(): Promise<void> {
    return pending("deleteRole", "store-swap task 8");
  }

  // -------------------------------------------------------------------------
  // Task 5 — messages, DMs, reactions, read state. Implemented in ./chat;
  // these are the seam, so each one is a single delegation.
  //
  // None of them is awaited by its call site: `commit` has already put the
  // message, the edit or the emoji on screen, and chat is the surface where a
  // round trip to Mumbai between keystroke and render would be felt. Each
  // therefore either resolves (the rows are there) or rejects (roll it back).
  // -------------------------------------------------------------------------
  async sendMessage(message: Message): Promise<Message> {
    return chat.sendMessage(await this.client(), message);
  }
  /** `isNewDm` is unused here on purpose — `find_or_create_dm` answers that
   *  question authoritatively, and it is the client's stale belief about it
   *  that the RPC exists to retire. It stays in the seam for `LocalBackend`,
   *  which has no server to ask. */
  async sendToUser(dm: DM, _isNewDm: boolean, message: Message): Promise<DM> {
    return chat.sendToUser(await this.client(), dm, message);
  }
  async editMessage(messageId: string, content: string, editedAt: number): Promise<void> {
    return chat.editMessage(await this.client(), messageId, content, editedAt);
  }
  async deleteMessage(messageId: string): Promise<void> {
    return chat.deleteMessage(await this.client(), messageId);
  }
  async toggleReaction(messageId: string, emoji: string): Promise<void> {
    return chat.toggleReaction(await this.client(), messageId, emoji);
  }
  async markChannelRead(conversationId: string, readAt: number): Promise<void> {
    return chat.markChannelRead(await this.client(), conversationId, readAt);
  }
  async openDm(dm: DM): Promise<DM> {
    return chat.openDm(await this.client(), dm);
  }

  // -------------------------------------------------------------------------
  // Task 6 — channels, projects, access. Implemented in ./workspace; these are
  // the seam, so each one is a single delegation.
  //
  // ON DELETE-ACTIVITIES. Task 6 recorded that none of these seven writes a
  // feed row, because `Backend` carried no way to express one. `putActivity`
  // above closed that for six of them: the store's line for `created the X
  // project`, `updated access for #X` and the rest now reaches Postgres.
  //
  // The two deletes are the exception, and it is a schema fact rather than a
  // choice. `activities.project_id` / `.conversation_id` cascade
  // (20260909000900_activity_scope.sql): sequenced before the delete, a
  // `deleted the X project` row is removed by the same cascade a moment later;
  // sequenced after — which is where `commit` puts it — it fails the foreign
  // key outright (23503). The tempting "fix", switching the scope FK to set
  // null, is the one the migration forbids by name: it would promote the row to
  // workspace-wide and republish the very project and channel names 66cddf1
  // hid. So a delete-activity is simply not persistable, the insert is allowed
  // to fail, and `commit` drops the optimistic line so the feed matches what a
  // reload shows. A durable record of who deleted what belongs in a server-side
  // audit log with its own access rules, not in a feed every user reads.
  // -------------------------------------------------------------------------
  async createChannel(channel: Channel): Promise<Channel> {
    return workspace.createChannel(await this.client(), channel);
  }
  async deleteChannel(channelId: string): Promise<void> {
    return workspace.deleteChannel(await this.client(), channelId);
  }
  async setChannelAccess(channelId: string, patch: ChannelAccessPatch): Promise<void> {
    return workspace.setChannelAccess(await this.client(), channelId, patch);
  }
  async createProject(project: Project): Promise<Project> {
    return workspace.createProject(await this.client(), project);
  }
  async updateProject(projectId: string, patch: ProjectPatch): Promise<void> {
    return workspace.updateProject(await this.client(), projectId, patch);
  }
  async deleteProject(projectId: string): Promise<void> {
    return workspace.deleteProject(await this.client(), projectId);
  }
  async setProjectAccess(projectId: string, patch: ProjectAccessPatch): Promise<void> {
    return workspace.setProjectAccess(await this.client(), projectId, patch);
  }

  // -------------------------------------------------------------------------
  // Task 7 — tasks and collaborators. Implemented in ./tasks; these are the
  // seam, so each one is a single delegation.
  //
  // Two of the four are unlike anything above them. `createTask` does NOT send
  // a position — a `before insert` trigger appends the card to its column and
  // the row is read back so the store adopts the server's number — and
  // `moveTask` renumbers through the `move_task` RPC rather than issuing an
  // update per card. Both replace a client-side computation that was correct
  // only while one person was looking at the board.
  //
  // Unlike the two deletes above, `deleteTask`'s feed line IS persisted:
  // `activities.project_id` cascades from `projects`, and the project outlives
  // the task it scoped.
  // -------------------------------------------------------------------------
  async createTask(task: Task): Promise<Task> {
    return tasks.createTask(await this.client(), task);
  }
  async updateTask(taskId: string, patch: TaskPatch): Promise<void> {
    return tasks.updateTask(await this.client(), taskId, patch);
  }
  async moveTask(taskId: string, toStatus: TaskStatus, toIndex: number): Promise<void> {
    return tasks.moveTask(await this.client(), taskId, toStatus, toIndex);
  }
  async deleteTask(taskId: string): Promise<void> {
    return tasks.deleteTask(await this.client(), taskId);
  }

  // -------------------------------------------------------------------------
  // Plan 3 — attachment bytes in Storage.
  // -------------------------------------------------------------------------
  putAttachment(): Promise<void> {
    return pending("putAttachment", "plan 3 — Storage");
  }
  deleteAttachment(): Promise<void> {
    return pending("deleteAttachment", "plan 3 — Storage");
  }
}
