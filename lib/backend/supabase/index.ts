/**
 * `SupabaseBackend` — the real backend.
 *
 * Task 4 implemented the read path; Task 5 the chat writes (delegated to
 * ./chat). The remaining writes still reject with a named "not implemented"
 * error, which Tasks 6–8 replace one group at a time.
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
import * as chat from "./chat";
import { browserClient, type LuminaClient } from "./client";
import { hydrateWorkspace } from "./hydrate";
import { signedOutState } from "./mapping";
import type { AppState } from "../../types";
import type { Backend } from "../types";
import type { Channel, DM, Message, Project, RoleDef, Task } from "../../types";

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
  // Task 6 — channels, projects, access.
  // -------------------------------------------------------------------------
  createChannel(): Promise<Channel> {
    return pending("createChannel", "store-swap task 6");
  }
  deleteChannel(): Promise<void> {
    return pending("deleteChannel", "store-swap task 6");
  }
  setChannelAccess(): Promise<void> {
    return pending("setChannelAccess", "store-swap task 6");
  }
  createProject(): Promise<Project> {
    return pending("createProject", "store-swap task 6");
  }
  updateProject(): Promise<void> {
    return pending("updateProject", "store-swap task 6");
  }
  deleteProject(): Promise<void> {
    return pending("deleteProject", "store-swap task 6");
  }
  setProjectAccess(): Promise<void> {
    return pending("setProjectAccess", "store-swap task 6");
  }

  // -------------------------------------------------------------------------
  // Task 7 — tasks and collaborators.
  // -------------------------------------------------------------------------
  createTask(): Promise<Task> {
    return pending("createTask", "store-swap task 7");
  }
  updateTask(): Promise<void> {
    return pending("updateTask", "store-swap task 7");
  }
  moveTask(): Promise<void> {
    return pending("moveTask", "store-swap task 7");
  }
  deleteTask(): Promise<void> {
    return pending("deleteTask", "store-swap task 7");
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
