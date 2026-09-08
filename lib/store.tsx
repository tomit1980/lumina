"use client";

import * as React from "react";
import { toast } from "sonner";

import { createBackend } from "./backend";
import type {
  Backend,
  ChannelAccessPatch,
  ProjectAccessPatch,
  ProjectPatch,
  RolePatch,
  TaskPatch,
} from "./backend/types";
import { PERMISSION_META, resourceMemberLevel, roleHas } from "./permissions";
import type {
  AccessLevel,
  Activity,
  ActivityKind,
  AppState,
  Attachment,
  Channel,
  DM,
  Message,
  MessageAttachment,
  Permission,
  Priority,
  Project,
  ResourceMember,
  RoleDef,
  Task,
  TaskStatus,
  User,
} from "./types";

const MAX_ACTIVITIES = 60;

export function uid(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Placeholder for users whose role was somehow removed — zero permissions. */
const NO_ROLE: RoleDef = {
  id: "none",
  name: "No role",
  description: "This role no longer exists.",
  color: "#71717a",
  permissions: [],
};

export interface TaskInput {
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  dueDate: number | null;
  startTime: string | null;
  durationMinutes: number | null;
  reminderMinutes: number | null;
  labels: string[];
  attachments: Attachment[];
  collaboratorIds?: string[];
}

export interface RoleInput {
  name: string;
  description: string;
  color: string;
  permissions: Permission[];
}

interface StoreValue {
  state: AppState;
  currentUser: User;

  /** Resolve a role id to its definition (never undefined). */
  getRole: (roleId: string) => RoleDef;
  /** The role of a user (default: the current user). */
  userRole: (user?: User) => RoleDef;
  /** Live permission check against the editable role registry. */
  can: (permission: Permission, user?: User) => boolean;
  canDeleteMessage: (message: Message) => boolean;
  canDeleteChannel: (channel: Channel) => boolean;
  canSeeChannel: (channel: Channel, user?: User) => boolean;
  /** "editor" everywhere except a restricted resource where this user is a
   *  plain viewer (or, defensively, not a member at all). Admins always get "editor". */
  channelAccessLevel: (channel: Channel, user?: User) => AccessLevel;
  canSeeProject: (project: Project, user?: User) => boolean;
  projectAccessLevel: (project: Project, user?: User) => AccessLevel;

  // ---------------------------------------------------------------------
  // Write actions. Every one of them is optimistic: the patch is applied to
  // `AppState` synchronously, the returned promise settles once the backend
  // has accepted (or refused) the write.
  //
  // A guard refusal and a backend failure both resolve with the same falsy
  // value — `false` / `null` / `undefined` — so a caller that announces
  // success only when the result is truthy cannot claim a write that did not
  // happen. The store toasts the reason itself in both cases; nothing here
  // ever rejects, so fire-and-forget call sites (chat send, reactions, drag
  // & drop) stay safe and instant.
  // ---------------------------------------------------------------------
  switchUser: (userId: string) => Promise<void>;
  setUserRole: (userId: string, roleId: string) => Promise<boolean>;
  createRole: (input: RoleInput) => Promise<RoleDef | null>;
  updateRole: (roleId: string, patch: RolePatch) => Promise<boolean>;
  setRolePermission: (
    roleId: string,
    permission: Permission,
    enabled: boolean
  ) => Promise<boolean>;
  deleteRole: (roleId: string) => Promise<boolean>;
  resetDemo: () => Promise<void>;

  /** Post to a channel or DM. Empty content is allowed when files are attached.
   *  Resolves false when denied or when the write failed. */
  sendMessage: (
    conversationId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => Promise<boolean>;
  /** Find-or-create the DM with `otherUserId` and post into it atomically
   *  (safe to call right after picking a person, unlike openDm + sendMessage). */
  sendToUser: (
    otherUserId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => Promise<DM | null>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  markChannelRead: (conversationId: string) => Promise<void>;
  createChannel: (input: {
    name: string;
    description: string;
    isPrivate: boolean;
  }) => Promise<Channel | null>;
  deleteChannel: (channelId: string) => Promise<void>;
  /** Sets privacy + the per-member access list in one go. The channel's
   *  creator is always kept as an editor so they can't lock themselves out. */
  setChannelAccess: (
    channelId: string,
    patch: ChannelAccessPatch
  ) => Promise<boolean>;
  /** Find-or-create the DM with `otherUserId`. Resolves null when the store
   *  isn't hydrated yet or the thread couldn't be created — callers navigate
   *  to the returned thread, so they must not be handed one that doesn't
   *  exist. */
  openDm: (otherUserId: string) => Promise<DM | null>;

  createProject: (input: {
    name: string;
    description: string;
    emoji: string;
    color: string;
    priority: Priority;
  }) => Promise<Project | null>;
  updateProject: (projectId: string, patch: ProjectPatch) => Promise<boolean>;
  deleteProject: (projectId: string) => Promise<void>;
  /** Sets restriction + the per-member access list in one go. The project's
   *  creator is always kept as an editor so they can't lock themselves out. */
  setProjectAccess: (
    projectId: string,
    patch: ProjectAccessPatch
  ) => Promise<boolean>;

  createTask: (input: TaskInput) => Promise<Task | null>;
  /** Resolves false when denied (no permission, view-only project, or a
   *  collaborator in the resulting list can't see the project). */
  updateTask: (taskId: string, patch: TaskPatch) => Promise<boolean>;
  moveTask: (
    taskId: string,
    toStatus: TaskStatus,
    toIndex: number
  ) => Promise<void>;
  deleteTask: (taskId: string) => Promise<boolean>;
}

const StoreContext = React.createContext<StoreValue | null>(null);

function activity(
  state: AppState,
  kind: ActivityKind,
  text: string,
  actorId?: string
): Activity[] {
  const entry: Activity = {
    id: uid("a"),
    ts: Date.now(),
    actorId: actorId ?? state.currentUserId,
    text,
    kind,
  };
  return [...state.activities, entry].slice(-MAX_ACTIVITIES);
}

function findRole(s: AppState, roleId: string | undefined): RoleDef | undefined {
  return s.roles.find((r) => r.id === roleId);
}

function actorRole(s: AppState): RoleDef | undefined {
  const actor = s.users.find((u) => u.id === s.currentUserId);
  return findRole(s, actor?.roleId);
}

/** True when the acting user can only read (not post/edit) in this channel:
 *  restricted, not an admin, and not listed as an editor member. */
function channelIsViewerOnly(s: AppState, channel: Channel): boolean {
  if (!channel.isPrivate) return false;
  if (roleHas(actorRole(s), "members.manage")) return false;
  return resourceMemberLevel(channel.members, s.currentUserId) !== "editor";
}

/** Same idea for a restricted project's tasks. */
function projectIsViewerOnly(s: AppState, project: Project): boolean {
  if (!project.restricted) return false;
  if (roleHas(actorRole(s), "members.manage")) return false;
  return resourceMemberLevel(project.members, s.currentUserId) !== "editor";
}

/** Who may change a channel's privacy/membership — same bar as deleting it. */
function channelIsManageable(s: AppState, channel: Channel): boolean {
  if (channel.isTeam) return false;
  return roleHas(actorRole(s), "channel.delete") || channel.createdBy === s.currentUserId;
}

/** Who may change a project's access/membership or edit its fields —
 *  creator, anyone with members.manage, or a project.create holder who
 *  isn't merely a viewer on this (possibly restricted) project. */
function projectIsManageable(s: AppState, project: Project): boolean {
  if (roleHas(actorRole(s), "members.manage")) return true;
  if (project.createdBy === s.currentUserId) return true;
  return roleHas(actorRole(s), "project.create") && !projectIsViewerOnly(s, project);
}

/** Role of an arbitrary user, not just the acting one — actorRole only ever
 *  answers for s.currentUserId. */
function roleOfUser(s: AppState, userId: string): RoleDef | undefined {
  const user = s.users.find((u) => u.id === userId);
  return findRole(s, user?.roleId);
}

/** Per-user form of the project visibility rule: unrestricted → everyone;
 *  restricted → a listed member, the creator, or anyone with members.manage.
 *  The provider's `canSeeProject` (below) delegates here for the current
 *  user so the two can't drift apart — this is what the collaborator picker
 *  and the assignment guard need for an arbitrary user. */
export function canUserSeeProject(
  s: AppState,
  project: Project,
  userId: string
): boolean {
  if (!project.restricted) return true;
  if (project.createdBy === userId) return true;
  if (resourceMemberLevel(project.members, userId) !== null) return true;
  return roleHas(roleOfUser(s, userId), "members.manage");
}

/** Drops the owner and any duplicates from a collaborator list, keeping
 *  order. Pure, and also used by the task dialog to preview the resulting
 *  list before saving. */
export function normaliseCollaborators(
  ownerId: string | null,
  ids: string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id === ownerId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Can this user still see the project a task belongs to? Every "mine"-style
 *  read site (the home page's task list, the schedule .ics export, the
 *  reminder gate) must ask this in addition to `isMine`/`isMineOrUnclaimed`
 *  (lib/permissions.ts) — otherwise a revoked collaborator, or an owner
 *  whose access changed since, keeps seeing a task whose project the
 *  database would no longer return the row for. A missing project (should
 *  never happen — deleteProject cascades its tasks) is treated as
 *  not-visible, matching the write-time guards' fail-closed shape. Shared
 *  here, not duplicated at each call site, and kept out of
 *  lib/permissions.ts so that module stays free of the store's React
 *  imports. */
export function canUserSeeTaskProject(
  s: AppState,
  task: Pick<Task, "projectId">,
  userId: string
): boolean {
  const project = s.projects.find((p) => p.id === task.projectId);
  return !!project && canUserSeeProject(s, project, userId);
}

/** One activity line per person affected by an owner/collaborator change,
 *  diffing the previous and next (already-normalised) task. Shared so the
 *  owner-change and collaborator-add/remove branches aren't duplicated at
 *  each call site. */
function assignmentActivityTexts(s: AppState, prev: Task, next: Task): string[] {
  const nameOf = (userId: string) =>
    s.users.find((u) => u.id === userId)?.name ?? "Someone";
  // Every line names the task by its *resulting* title — a patch that
  // renames and reassigns in the same call must log the assignment against
  // the new name, not the one being replaced.
  const title = next.title;
  const texts: string[] = [];
  if (next.assigneeId !== prev.assigneeId) {
    texts.push(
      next.assigneeId
        ? `assigned “${title}” to ${nameOf(next.assigneeId)}`
        : `unassigned “${title}”`
    );
  }
  for (const id of next.collaboratorIds) {
    if (!prev.collaboratorIds.includes(id)) {
      texts.push(`added ${nameOf(id)} to “${title}”`);
    }
  }
  for (const id of prev.collaboratorIds) {
    if (!next.collaboratorIds.includes(id)) {
      texts.push(`removed ${nameOf(id)} from “${title}”`);
    }
  }
  return texts;
}

/** Can the acting user see this conversation at all (channel or DM)? Used to
 *  keep reactions from leaking into places the user couldn't otherwise read. */
function canSeeConversation(s: AppState, conversationId: string): boolean {
  const channel = s.channels.find((c) => c.id === conversationId);
  if (channel) {
    if (!channel.isPrivate) return true;
    return (
      channel.members.some((m) => m.userId === s.currentUserId) ||
      roleHas(actorRole(s), "members.manage")
    );
  }
  const dm = s.dms.find((d) => d.id === conversationId);
  return !!dm && dm.memberIds.includes(s.currentUserId);
}

/** Keeps the creator as an editor no matter what the UI submitted. */
function ensureEditor(members: ResourceMember[], creatorId: string): ResourceMember[] {
  return [
    { userId: creatorId, level: "editor" as const },
    ...members.filter((m) => m.userId !== creatorId),
  ];
}

/** Unread messages for a user in a conversation (their own never count). */
export function getUnreadCount(
  state: AppState,
  userId: string,
  conversationId: string
): number {
  const lastRead = state.lastRead[`${userId}:${conversationId}`] ?? 0;
  let count = 0;
  for (const m of state.messages) {
    if (
      m.channelId === conversationId &&
      m.authorId !== userId &&
      m.createdAt > lastRead
    ) {
      count += 1;
    }
  }
  return count;
}


export function StoreProvider({
  children,
  backend: injectedBackend,
}: React.PropsWithChildren<{
  /** Test seam: swap in a `Backend` double (see `FailingBackend` in
   *  tests/qa/_support.ts). Production always takes the flag's backend. */
  backend?: Backend;
}>) {
  const backend = React.useMemo(
    () => injectedBackend ?? createBackend(),
    [injectedBackend]
  );
  const [state, setState] = React.useState<AppState | null>(null);

  // `stateRef` — not `state` — is the synchronous source of truth actions
  // read and patch from. React defers the re-render that would refresh a
  // render-time ref assignment, so two writes dispatched in the same tick
  // would otherwise both see (and both patch) the pre-first-write state.
  // Every path that changes the workspace goes through `adopt`.
  const stateRef = React.useRef<AppState | null>(null);

  const adopt = React.useCallback((next: AppState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Hydration: the loading screen below shows until this resolves.
  React.useEffect(() => {
    let cancelled = false;
    void backend.hydrate().then((next) => {
      if (!cancelled) adopt(next);
    });
    return () => {
      cancelled = true;
    };
  }, [backend, adopt]);

  React.useEffect(() => {
    if (!state) return;
    backend.persist(state);
  }, [state, backend]);

  const update = React.useCallback(
    (fn: (s: AppState) => AppState) => {
      const base = stateRef.current;
      if (!base) return;
      adopt(fn(base));
    },
    [adopt]
  );

  /** Monotonic count of optimistic patches applied. A failing write compares
   *  the value it took against this to find out whether anything landed on
   *  top of it — see `commit` below. */
  const writeSeq = React.useRef(0);

  const actions = React.useMemo(() => {
    /** Action-layer enforcement: every mutation is denied — with feedback —
     *  when the acting user's role lacks the permission. UI gating is
     *  cosmetic on top of this. */
    const guard = (permission: Permission): boolean => {
      const s = stateRef.current;
      if (!s) return false;
      const ok = roleHas(actorRole(s), permission);
      if (!ok) {
        toast.error("Not allowed", {
          description: `Your role doesn't include “${PERMISSION_META[permission].label}”.`,
        });
      }
      return ok;
    };

    const deny = (why: string) => toast.error("Not allowed", { description: why });

    /**
     * The one implementation of the plan's write sequence. Every write action
     * ends in a call to this — the optimistic/rollback logic exists here and
     * nowhere else, so Tasks 5–8 change backends without re-rolling it.
     *
     * Steps 1 and 2 (the synchronous `guard()` fast path, and computing the
     * patch) belong to the action, because only the action knows what it is
     * allowed to do and what the resulting rows look like. A refused action
     * returns `Promise.resolve(<falsy>)` without ever getting here. Steps 2–4
     * are below:
     *
     * 2. apply `patch` to `AppState`, snapshotting what it replaced;
     * 3. `await op()`;
     * 4. resolve with `outcome.ok(result)`, or roll back, toast, and resolve
     *    with `outcome.failed` — the same falsy value a guard refusal gives,
     *    so callers need only one check to stay honest.
     *
     * Rollback rule: if no later optimistic write landed while `op` was in
     * flight (`writeSeq` still holds this write's number), the snapshot is
     * restored exactly. If one did, restoring would silently discard it — so
     * the whole `AppState` is re-hydrated from the backend instead of
     * guessing at an inverse patch.
     */
    function commit<R, T>(
      patch: (s: AppState) => AppState,
      op: () => Promise<R>,
      outcome: {
        /** Success value, from whatever the backend returned — the seam a
         *  real backend hands server-assigned ids and positions back through. */
        ok: (result: R) => T;
        /** Failure value. Must match what this action's guards return. */
        failed: T;
        /** Verb phrase for the failure toast: "We couldn't ${describe}." */
        describe: string;
      }
    ): Promise<T> {
      const snapshot = stateRef.current;
      if (!snapshot) return Promise.resolve(outcome.failed);
      update(patch);
      const seq = (writeSeq.current += 1);
      return op().then(
        (result) => outcome.ok(result),
        () => {
          toast.error("Couldn't save", {
            description: `We couldn't ${outcome.describe}. Your change has been undone.`,
          });
          if (writeSeq.current === seq) {
            adopt(snapshot);
            return outcome.failed;
          }
          return backend.hydrate().then(
            (fresh) => {
              adopt(fresh);
              return outcome.failed;
            },
            () => {
              toast.error("Out of sync", {
                description: "Reload the page to see the current workspace.",
              });
              return outcome.failed;
            }
          );
        }
      );
    }

    const switchUser: StoreValue["switchUser"] = (userId) =>
      commit(
        (s) => ({ ...s, currentUserId: userId }),
        () => backend.switchUser(userId),
        { ok: () => undefined, failed: undefined, describe: "switch user" }
      );

    const setUserRole: StoreValue["setUserRole"] = (userId, roleId) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return Promise.resolve(false);
      if (userId === s.currentUserId) {
        deny("You can't change your own role.");
        return Promise.resolve(false);
      }
      const target = s.users.find((u) => u.id === userId);
      const role = findRole(s, roleId);
      if (!target || !role || target.roleId === roleId) return Promise.resolve(false);
      const targetRole = findRole(s, target.roleId);
      if (targetRole?.locked) {
        const admins = s.users.filter((u) => findRole(s, u.roleId)?.locked);
        if (admins.length <= 1) {
          deny("A workspace needs at least one admin.");
          return Promise.resolve(false);
        }
      }
      return commit(
        (st) => ({
          ...st,
          users: st.users.map((u) => (u.id === userId ? { ...u, roleId } : u)),
          activities: activity(st, "member", `made ${target.name} a ${role.name}`),
        }),
        () => backend.setUserRole(userId, roleId),
        {
          ok: () => true,
          failed: false,
          describe: `make ${target.name} a ${role.name}`,
        }
      );
    };

    const createRole: StoreValue["createRole"] = (input) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return Promise.resolve(null);
      const name = input.name.trim();
      if (s.roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        deny(`A role called “${name}” already exists.`);
        return Promise.resolve(null);
      }
      const role: RoleDef = {
        id: uid("r"),
        name,
        description: input.description,
        color: input.color,
        permissions: [...input.permissions],
      };
      return commit(
        (st) => ({
          ...st,
          roles: [...st.roles, role],
          activities: activity(st, "member", `created the ${name} role`),
        }),
        () => backend.createRole(role),
        {
          ok: (created) => created,
          failed: null,
          describe: `create the ${name} role`,
        }
      );
    };

    const updateRole: StoreValue["updateRole"] = (roleId, patch) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return Promise.resolve(false);
      const role = findRole(s, roleId);
      if (!role) return Promise.resolve(false);
      if (role.locked) {
        deny("The admin role is locked.");
        return Promise.resolve(false);
      }
      const nextName = patch.name?.trim();
      if (
        nextName &&
        s.roles.some(
          (r) => r.id !== roleId && r.name.toLowerCase() === nextName.toLowerCase()
        )
      ) {
        deny(`A role called “${nextName}” already exists.`);
        return Promise.resolve(false);
      }
      return commit(
        (st) => ({
          ...st,
          roles: st.roles.map((r) =>
            r.id === roleId
              ? {
                  ...r,
                  name: nextName ?? r.name,
                  description: patch.description ?? r.description,
                  color: patch.color ?? r.color,
                  permissions: patch.permissions ?? r.permissions,
                }
              : r
          ),
        }),
        () => backend.updateRole(roleId, patch),
        {
          ok: () => true,
          failed: false,
          describe: `update the ${role.name} role`,
        }
      );
    };

    const setRolePermission: StoreValue["setRolePermission"] = (
      roleId,
      permission,
      enabled
    ) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return Promise.resolve(false);
      const role = findRole(s, roleId);
      if (!role) return Promise.resolve(false);
      if (role.locked) {
        deny("The admin role is locked at full access.");
        return Promise.resolve(false);
      }
      if (enabled === role.permissions.includes(permission)) return Promise.resolve(false);
      return commit(
        (st) => ({
          ...st,
          roles: st.roles.map((r) =>
            r.id === roleId
              ? {
                  ...r,
                  permissions: enabled
                    ? [...r.permissions, permission]
                    : r.permissions.filter((p) => p !== permission),
                }
              : r
          ),
          activities: activity(
            st,
            "member",
            `${enabled ? "granted" : "revoked"} “${PERMISSION_META[permission].label}” ${enabled ? "to" : "for"} ${role.name}s`
          ),
        }),
        () => backend.setRolePermission(roleId, permission, enabled),
        {
          ok: () => true,
          failed: false,
          describe: `change what ${role.name}s can do`,
        }
      );
    };

    const deleteRole: StoreValue["deleteRole"] = (roleId) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return Promise.resolve(false);
      const role = findRole(s, roleId);
      if (!role) return Promise.resolve(false);
      if (role.isSystem || role.locked) {
        deny(`${role.name} is a built-in role and can't be deleted.`);
        return Promise.resolve(false);
      }
      if (s.users.some((u) => u.roleId === roleId)) {
        deny("Reassign its members to another role first.");
        return Promise.resolve(false);
      }
      return commit(
        (st) => ({
          ...st,
          roles: st.roles.filter((r) => r.id !== roleId),
          activities: activity(st, "member", `deleted the ${role.name} role`),
        }),
        () => backend.deleteRole(roleId),
        {
          ok: () => true,
          failed: false,
          describe: `delete the ${role.name} role`,
        }
      );
    };

    const resetDemo: StoreValue["resetDemo"] = () =>
      backend.reset().then((fresh) => {
        adopt(fresh);
      });

    /** Builds the activity line for a message that carries files. */
    const shareNote = (
      s: AppState,
      attachments: MessageAttachment[],
      channel: Channel | undefined,
      otherUserId: string | undefined
    ): string | null => {
      if (attachments.length === 0) return null;
      const extra = attachments.length > 1 ? ` +${attachments.length - 1} more` : "";
      const other = otherUserId ? s.users.find((u) => u.id === otherUserId) : undefined;
      const where = channel ? `in #${channel.name}` : other ? `with ${other.name}` : "";
      return `shared “${attachments[0].name}”${extra} ${where}`.trim();
    };

    /** The message row, built before the patch so the optimistic copy and the
     *  one handed to the backend are the same object — a real backend must
     *  not be sent a second `Date.now()` or a second `uid()`. */
    const buildMessage = (
      s: AppState,
      conversationId: string,
      content: string,
      attachments: MessageAttachment[]
    ): Message => ({
      id: uid("m"),
      channelId: conversationId,
      authorId: s.currentUserId,
      content,
      createdAt: Date.now(),
      reactions: [],
      attachments,
    });

    const appendMessage = (
      st: AppState,
      message: Message,
      note: string | null
    ): AppState => ({
      ...st,
      messages: [...st.messages, message],
      lastRead: {
        ...st.lastRead,
        [`${st.currentUserId}:${message.channelId}`]: message.createdAt,
      },
      activities: note ? activity(st, "message", note) : st.activities,
    });

    const sendMessage: StoreValue["sendMessage"] = (
      conversationId,
      content,
      attachments = []
    ) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve(false);
      if (!content.trim() && attachments.length === 0) return Promise.resolve(false);
      // DMs are open to everyone (but only their two participants); posting
      // in channels is gated by a permission.
      const channel = s.channels.find((c) => c.id === conversationId);
      let otherUserId: string | undefined;
      if (channel) {
        if (!guard("message.send")) return Promise.resolve(false);
        if (channelIsViewerOnly(s, channel)) {
          deny("You have view-only access to this channel.");
          return Promise.resolve(false);
        }
      } else {
        const dm = s.dms.find((d) => d.id === conversationId);
        if (!dm || !dm.memberIds.includes(s.currentUserId)) return Promise.resolve(false);
        otherUserId = dm.memberIds.find((id) => id !== s.currentUserId);
      }
      const note = shareNote(s, attachments, channel, otherUserId);
      const message = buildMessage(s, conversationId, content, attachments);
      return commit(
        (st) => appendMessage(st, message, note),
        () => backend.sendMessage(message),
        { ok: () => true, failed: false, describe: "send your message" }
      );
    };

    const sendToUser: StoreValue["sendToUser"] = (
      otherUserId,
      content,
      attachments = []
    ) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve(null);
      if (!content.trim() && attachments.length === 0) return Promise.resolve(null);
      if (otherUserId === s.currentUserId || !s.users.some((u) => u.id === otherUserId)) {
        return Promise.resolve(null);
      }
      const me = s.currentUserId;
      const existing = s.dms.find(
        (d) => d.memberIds.includes(me) && d.memberIds.includes(otherUserId)
      );
      const dm: DM = existing ?? {
        id: uid("d"),
        memberIds: [me, otherUserId],
        createdAt: Date.now(),
      };
      const note = shareNote(s, attachments, undefined, otherUserId);
      const message = buildMessage(s, dm.id, content, attachments);
      return commit(
        (st) =>
          appendMessage(existing ? st : { ...st, dms: [...st.dms, dm] }, message, note),
        // One operation: creating the thread and posting the first message
        // must succeed or fail together.
        () => backend.sendToUser(dm, !existing, message),
        { ok: (row) => row, failed: null, describe: "send your message" }
      );
    };

    const editMessage: StoreValue["editMessage"] = (messageId, content) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve();
      const message = s.messages.find((m) => m.id === messageId);
      if (!message || message.authorId !== s.currentUserId) {
        deny("You can only edit your own messages.");
        return Promise.resolve();
      }
      const editedAt = Date.now();
      return commit(
        (st) => ({
          ...st,
          messages: st.messages.map((m) =>
            m.id === messageId ? { ...m, content, editedAt } : m
          ),
        }),
        () => backend.editMessage(messageId, content, editedAt),
        { ok: () => undefined, failed: undefined, describe: "edit that message" }
      );
    };

    const deleteMessage: StoreValue["deleteMessage"] = (messageId) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve();
      const message = s.messages.find((m) => m.id === messageId);
      if (!message) return Promise.resolve();
      if (message.authorId !== s.currentUserId && !guard("message.deleteAny")) {
        return Promise.resolve();
      }
      return commit(
        (st) => ({
          ...st,
          messages: st.messages.filter((m) => m.id !== messageId),
        }),
        () => backend.deleteMessage(messageId),
        { ok: () => undefined, failed: undefined, describe: "delete that message" }
      );
    };

    const toggleReaction: StoreValue["toggleReaction"] = (messageId, emoji) => {
      const s0 = stateRef.current;
      const message0 = s0?.messages.find((m) => m.id === messageId);
      if (!s0 || !message0 || !canSeeConversation(s0, message0.channelId)) {
        return Promise.resolve();
      }
      return commit(
        (s) => ({
          ...s,
          messages: s.messages.map((m) => {
            if (m.id !== messageId) return m;
            const existing = m.reactions.find((r) => r.emoji === emoji);
            let reactions;
            if (!existing) {
              reactions = [...m.reactions, { emoji, userIds: [s.currentUserId] }];
            } else if (existing.userIds.includes(s.currentUserId)) {
              reactions = m.reactions
                .map((r) =>
                  r.emoji === emoji
                    ? { ...r, userIds: r.userIds.filter((u) => u !== s.currentUserId) }
                    : r
                )
                .filter((r) => r.userIds.length > 0);
            } else {
              reactions = m.reactions.map((r) =>
                r.emoji === emoji ? { ...r, userIds: [...r.userIds, s.currentUserId] } : r
              );
            }
            return { ...m, reactions };
          }),
        }),
        () => backend.toggleReaction(messageId, emoji),
        { ok: () => undefined, failed: undefined, describe: "add that reaction" }
      );
    };

    const markChannelRead: StoreValue["markChannelRead"] = (conversationId) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve();
      const key = `${s.currentUserId}:${conversationId}`;
      const latest = s.messages.reduce(
        (acc, m) => (m.channelId === conversationId ? Math.max(acc, m.createdAt) : acc),
        0
      );
      // Nothing new to mark — don't burn a write on it. (Was the `return s`
      // short-circuit inside the old updater.)
      if ((s.lastRead[key] ?? 0) >= latest) return Promise.resolve();
      const readAt = Date.now();
      return commit(
        (st) => ({ ...st, lastRead: { ...st.lastRead, [key]: readAt } }),
        () => backend.markChannelRead(conversationId, readAt),
        { ok: () => undefined, failed: undefined, describe: "mark this conversation read" }
      );
    };

    const createChannel: StoreValue["createChannel"] = (input) => {
      if (!guard("channel.create")) return Promise.resolve(null);
      const s = stateRef.current;
      if (!s) return Promise.resolve(null);
      const channel: Channel = {
        id: uid("c"),
        name: input.name,
        description: input.description,
        isPrivate: input.isPrivate,
        // Explicit false so a channel created today never has a missing
        // isTeam key for the legacy-migration name-based backfill to catch.
        isTeam: false,
        members: input.isPrivate
          ? [{ userId: s.currentUserId, level: "editor" }]
          : [],
        createdBy: s.currentUserId,
        createdAt: Date.now(),
      };
      return commit(
        (st) => ({
          ...st,
          channels: [...st.channels, channel],
          activities: activity(st, "channel", `created #${input.name}`),
        }),
        () => backend.createChannel(channel),
        {
          ok: (created) => created,
          failed: null,
          describe: `create #${input.name}`,
        }
      );
    };

    const setChannelAccess: StoreValue["setChannelAccess"] = (channelId, patch) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve(false);
      const channel = s.channels.find((c) => c.id === channelId);
      if (!channel) return Promise.resolve(false);
      if (!channelIsManageable(s, channel)) {
        deny("You don't have permission to manage this channel.");
        return Promise.resolve(false);
      }
      const members = patch.isPrivate
        ? ensureEditor(patch.members, channel.createdBy)
        : [];
      const resolved = { isPrivate: patch.isPrivate, members };
      return commit(
        (st) => ({
          ...st,
          channels: st.channels.map((c) =>
            c.id === channelId ? { ...c, ...resolved } : c
          ),
          activities: activity(st, "channel", `updated access for #${channel.name}`),
        }),
        () => backend.setChannelAccess(channelId, resolved),
        {
          ok: () => true,
          failed: false,
          describe: `update access for #${channel.name}`,
        }
      );
    };

    const deleteChannel: StoreValue["deleteChannel"] = (channelId) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve();
      const channel = s.channels.find((c) => c.id === channelId);
      if (!channel) return Promise.resolve();
      if (channel.isTeam) {
        deny("The team channel can't be deleted.");
        return Promise.resolve();
      }
      if (channel.createdBy !== s.currentUserId && !guard("channel.delete")) {
        return Promise.resolve();
      }
      return commit(
        (st) => ({
          ...st,
          channels: st.channels.filter((c) => c.id !== channelId),
          messages: st.messages.filter((m) => m.channelId !== channelId),
          activities: activity(st, "channel", `deleted #${channel.name}`),
        }),
        () => backend.deleteChannel(channelId),
        { ok: () => undefined, failed: undefined, describe: `delete #${channel.name}` }
      );
    };

    const openDm: StoreValue["openDm"] = (otherUserId) => {
      const s = stateRef.current;
      // Was `throw new Error("Store not hydrated")`. Inside a promise-returning
      // action a throw is just a rejection, which every call site would have to
      // catch to avoid an unhandled one — so an unhydrated store is reported the
      // same way a refusal is, and the four navigation call sites check for null
      // instead of routing to a thread that doesn't exist.
      if (!s) return Promise.resolve(null);
      const me = s.currentUserId;
      const existing = s.dms.find(
        (d) => d.memberIds.includes(me) && d.memberIds.includes(otherUserId)
      );
      if (existing) return Promise.resolve(existing);
      const dm: DM = {
        id: uid("d"),
        memberIds: [me, otherUserId],
        createdAt: Date.now(),
      };
      return commit(
        (st) => ({ ...st, dms: [...st.dms, dm] }),
        () => backend.openDm(dm),
        { ok: (row) => row, failed: null, describe: "open that conversation" }
      );
    };

    const createProject: StoreValue["createProject"] = (input) => {
      if (!guard("project.create")) return Promise.resolve(null);
      const s = stateRef.current;
      if (!s) return Promise.resolve(null);
      const project: Project = {
        id: uid("p"),
        ...input,
        restricted: false,
        members: [],
        attachments: [],
        createdBy: s.currentUserId,
        createdAt: Date.now(),
      };
      return commit(
        (st) => ({
          ...st,
          projects: [...st.projects, project],
          activities: activity(st, "project", `created the ${input.name} project`),
        }),
        () => backend.createProject(project),
        {
          ok: (created) => created,
          failed: null,
          describe: `create the ${input.name} project`,
        }
      );
    };

    const updateProject: StoreValue["updateProject"] = (projectId, patch) => {
      // Editing a project is part of the "manage projects" capability.
      if (!guard("project.create")) return Promise.resolve(false);
      // Every patch (not just attachments) is subject to the same
      // object-level manageability check as channel access changes.
      const cur = stateRef.current;
      const target = cur?.projects.find((p) => p.id === projectId);
      if (cur && target && !projectIsManageable(cur, target)) {
        deny("You don't have permission to edit this project.");
        return Promise.resolve(false);
      }
      return commit(
        (s) => {
        const prev = s.projects.find((p) => p.id === projectId);
        if (!prev) return s;
        const renamed =
          patch.name !== undefined && patch.name !== prev.name;
        const edited = patch.attachments?.find((a) => {
          const before = prev.attachments.find((b) => b.id === a.id);
          return before !== undefined && before.dataUrl !== a.dataUrl;
        });
        const attachmentNote = !patch.attachments
          ? null
          : patch.attachments.length > prev.attachments.length
            ? `attached a file to “${prev.name}”`
            : patch.attachments.length < prev.attachments.length
              ? `removed an attachment from “${prev.name}”`
              : edited
                ? `updated “${edited.name}” in “${prev.name}”`
                : null;
        return {
          ...s,
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, ...patch } : p
          ),
          activities: renamed
            ? activity(
                s,
                "project",
                `renamed “${prev.name}” to “${patch.name}”`
              )
            : attachmentNote
              ? activity(s, "project", attachmentNote)
              : s.activities,
        };
        },
        () => backend.updateProject(projectId, patch),
        {
          ok: () => true,
          failed: false,
          describe: `save ${target ? `“${target.name}”` : "this project"}`,
        }
      );
    };

    const deleteProject: StoreValue["deleteProject"] = (projectId) => {
      if (!guard("project.delete")) return Promise.resolve();
      const s = stateRef.current;
      const project = s?.projects.find((p) => p.id === projectId);
      if (!s || !project) return Promise.resolve();
      return commit(
        (st) => ({
          ...st,
          projects: st.projects.filter((p) => p.id !== projectId),
          tasks: st.tasks.filter((t) => t.projectId !== projectId),
          activities: activity(st, "project", `deleted the ${project.name} project`),
        }),
        () => backend.deleteProject(projectId),
        {
          ok: () => undefined,
          failed: undefined,
          describe: `delete the ${project.name} project`,
        }
      );
    };

    const setProjectAccess: StoreValue["setProjectAccess"] = (projectId, patch) => {
      // Managing a project's membership is part of the "manage projects"
      // capability — same requirement updateProject already enforces.
      if (!guard("project.create")) return Promise.resolve(false);
      const s = stateRef.current;
      if (!s) return Promise.resolve(false);
      const project = s.projects.find((p) => p.id === projectId);
      if (!project) return Promise.resolve(false);
      if (!projectIsManageable(s, project)) {
        deny("You don't have permission to manage this project.");
        return Promise.resolve(false);
      }
      const members = patch.restricted
        ? ensureEditor(patch.members, project.createdBy)
        : [];
      const resolved = { restricted: patch.restricted, members };
      const updatedProject: Project = { ...project, ...resolved };
      return commit(
        (st) => {
        // Revocation must not leave stale collaborator rows: anyone on this
        // project's tasks who can no longer see it (per the *new*
        // restricted/members state) is pruned — the same rule the write-time
        // guard enforces, applied retroactively.
        const tasks = st.tasks.map((t) => {
          if (t.projectId !== projectId) return t;
          const kept = t.collaboratorIds.filter((id) =>
            canUserSeeProject(st, updatedProject, id)
          );
          return kept.length === t.collaboratorIds.length
            ? t
            : { ...t, collaboratorIds: kept };
        });
        return {
          ...st,
          projects: st.projects.map((p) => (p.id === projectId ? updatedProject : p)),
          tasks,
          activities: activity(st, "project", `updated access for ${project.name}`),
        };
        },
        () => backend.setProjectAccess(projectId, resolved),
        {
          ok: () => true,
          failed: false,
          describe: `update access for ${project.name}`,
        }
      );
    };

    const createTask: StoreValue["createTask"] = (input) => {
      if (!guard("task.create")) return Promise.resolve(null);
      const s0 = stateRef.current;
      const project0 = s0?.projects.find((p) => p.id === input.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return Promise.resolve(null);
      }
      const collaboratorIds = normaliseCollaborators(
        input.assigneeId,
        input.collaboratorIds ?? []
      );
      // Fail closed: a task whose projectId doesn't resolve to a real
      // project can't have its owner/collaborators checked against
      // anything, so it must be refused rather than let the write fall
      // through unchecked.
      if (!s0 || !project0) {
        deny("That project doesn't exist.");
        return Promise.resolve(null);
      }
      {
        // Assignment never grants access: the owner is checked exactly like
        // a collaborator — a person who can't see the project can't be put
        // on its tasks in either slot.
        const blockedId =
          input.assigneeId && !canUserSeeProject(s0, project0, input.assigneeId)
            ? input.assigneeId
            : collaboratorIds.find((id) => !canUserSeeProject(s0, project0, id));
        if (blockedId) {
          const name = s0.users.find((u) => u.id === blockedId)?.name ?? "That person";
          deny(`${name} can't see this project.`);
          return Promise.resolve(null);
        }
      }
      const columnSize = s0.tasks.filter(
        (t) => t.projectId === input.projectId && t.status === input.status
      ).length;
      const task: Task = {
        id: uid("t"),
        ...input,
        collaboratorIds,
        order: columnSize,
        createdAt: Date.now(),
        createdBy: s0.currentUserId,
      };
      return commit(
        (s) => ({
          ...s,
          tasks: [...s.tasks, task],
          activities: activity(s, "task", `created “${input.title}”`),
        }),
        () => backend.createTask(task),
        {
          ok: (created) => created,
          failed: null,
          describe: `create “${input.title}”`,
        }
      );
    };

    const updateTask: StoreValue["updateTask"] = (taskId, patch) => {
      if (!guard("task.edit")) return Promise.resolve(false);
      const s0 = stateRef.current;
      const task0 = s0?.tasks.find((t) => t.id === taskId);
      const project0 = task0 && s0?.projects.find((p) => p.id === task0.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return Promise.resolve(false);
      }
      if (!s0 || !task0) return Promise.resolve(false);
      // Fail closed: a task whose project can't be resolved can't have its
      // owner/collaborators checked against anything, so the write must be
      // refused rather than let the check fall through unrun.
      if (!project0) {
        deny("That project doesn't exist.");
        return Promise.resolve(false);
      }
      // Resolve against the *resulting* owner — a patch may change both the
      // owner and the collaborator list in the same call.
      const resultingOwner =
        patch.assigneeId !== undefined ? patch.assigneeId : task0.assigneeId;
      const resultingCollaborators = normaliseCollaborators(
        resultingOwner,
        patch.collaboratorIds !== undefined ? patch.collaboratorIds : task0.collaboratorIds
      );
      // Assignment never grants access: the resulting owner is checked
      // exactly like a collaborator.
      //
      // Only what this patch actually ASSIGNS is checked. A person who was
      // already on the task and has since lost sight of the project is not
      // this caller's doing, and refusing over them would make the task
      // uneditable by anyone — the same trap the dialog's prune-on-open
      // fixed for collaborators, and it reaches further: marking a task done
      // from the home page passes no assignment at all. Stale entries are
      // cleaned up where access is revoked, and pruned by the dialog.
      const ownerIsNewlyAssigned =
        patch.assigneeId !== undefined && patch.assigneeId !== task0.assigneeId;
      const newlyAddedCollaborators = resultingCollaborators.filter(
        (id) => !task0.collaboratorIds.includes(id)
      );
      const blockedId =
        ownerIsNewlyAssigned &&
        resultingOwner &&
        !canUserSeeProject(s0, project0, resultingOwner)
          ? resultingOwner
          : newlyAddedCollaborators.find((id) => !canUserSeeProject(s0, project0, id));
      if (blockedId) {
        const name = s0.users.find((u) => u.id === blockedId)?.name ?? "That person";
        deny(`${name} can't see this project.`);
        return Promise.resolve(false);
      }
      // The collaborator list the guards just approved is part of the write,
      // so the backend gets the same resolved patch the optimistic copy did.
      const resolved: TaskPatch = { ...patch, collaboratorIds: resultingCollaborators };
      return commit(
        (s) => {
          const prev = s.tasks.find((t) => t.id === taskId);
          if (!prev) return s;
          const completed = patch.status === "done" && prev.status !== "done";
          const next: Task = { ...prev, ...resolved };
          const assignmentTexts = assignmentActivityTexts(s, prev, next);
          let activities = completed
            ? activity(s, "task", `completed “${prev.title}”`)
            : s.activities;
          for (const text of assignmentTexts) {
            activities = activity({ ...s, activities }, "task", text);
          }
          return {
            ...s,
            tasks: s.tasks.map((t) => (t.id === taskId ? next : t)),
            activities,
          };
        },
        () => backend.updateTask(taskId, resolved),
        { ok: () => true, failed: false, describe: `save “${task0.title}”` }
      );
    };

    const moveTask: StoreValue["moveTask"] = (taskId, toStatus, toIndex) => {
      if (!guard("task.move")) return Promise.resolve();
      const s0 = stateRef.current;
      const task0 = s0?.tasks.find((t) => t.id === taskId);
      const project0 = task0 && s0?.projects.find((p) => p.id === task0.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return Promise.resolve();
      }
      if (!s0 || !task0) return Promise.resolve();
      return commit(
        (s) => {
        const task = s.tasks.find((t) => t.id === taskId);
        if (!task) return s;
        const column = s.tasks
          .filter(
            (t) =>
              t.projectId === task.projectId &&
              t.status === toStatus &&
              t.id !== taskId
          )
          .sort((a, b) => a.order - b.order);
        const clamped = Math.max(0, Math.min(toIndex, column.length));
        column.splice(clamped, 0, { ...task, status: toStatus });
        const reordered = new Map(
          column.map((t, i) => [t.id, { ...t, status: toStatus, order: i }])
        );
        if (task.status !== toStatus) {
          // The task actually changed columns — renumber the source column
          // too so its `order` values stay a dense 0..n-1 sequence instead
          // of leaving a gap where the moved task used to be.
          const sourceColumn = s.tasks
            .filter(
              (t) =>
                t.projectId === task.projectId &&
                t.status === task.status &&
                t.id !== taskId
            )
            .sort((a, b) => a.order - b.order);
          sourceColumn.forEach((t, i) => reordered.set(t.id, { ...t, order: i }));
        }
        const completed = toStatus === "done" && task.status !== "done";
        return {
          ...s,
          tasks: s.tasks.map((t) => reordered.get(t.id) ?? t),
          activities: completed
            ? activity(s, "task", `completed “${task.title}”`)
            : s.activities,
        };
        },
        () => backend.moveTask(taskId, toStatus, toIndex),
        { ok: () => undefined, failed: undefined, describe: `move “${task0.title}”` }
      );
    };

    const deleteTask: StoreValue["deleteTask"] = (taskId) => {
      if (!guard("task.delete")) return Promise.resolve(false);
      const s0 = stateRef.current;
      const task0 = s0?.tasks.find((t) => t.id === taskId);
      const project0 = task0 && s0?.projects.find((p) => p.id === task0.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return Promise.resolve(false);
      }
      if (!task0) return Promise.resolve(false);
      return commit(
        (s) => {
          const task = s.tasks.find((t) => t.id === taskId);
          if (!task) return s;
          return {
            ...s,
            tasks: s.tasks.filter((t) => t.id !== taskId),
            activities: activity(s, "task", `deleted “${task.title}”`),
          };
        },
        () => backend.deleteTask(taskId),
        { ok: () => true, failed: false, describe: `delete “${task0.title}”` }
      );
    };

    return {
      switchUser,
      setUserRole,
      createRole,
      updateRole,
      setRolePermission,
      deleteRole,
      resetDemo,
      sendMessage,
      sendToUser,
      editMessage,
      deleteMessage,
      toggleReaction,
      markChannelRead,
      createChannel,
      deleteChannel,
      setChannelAccess,
      openDm,
      createProject,
      updateProject,
      deleteProject,
      setProjectAccess,
      createTask,
      updateTask,
      moveTask,
      deleteTask,
    };
  }, [update, adopt, backend]);

  if (!state) {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="flex size-11 animate-pulse items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
            <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
              <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z" />
            </svg>
          </div>
          <span className="text-xs text-muted-foreground">Loading Lumina…</span>
        </div>
      </div>
    );
  }

  const currentUser =
    state.users.find((u) => u.id === state.currentUserId) ?? state.users[0];

  const getRole: StoreValue["getRole"] = (roleId) =>
    state.roles.find((r) => r.id === roleId) ?? NO_ROLE;

  const userRole: StoreValue["userRole"] = (user = currentUser) =>
    getRole(user.roleId);

  const can: StoreValue["can"] = (permission, user = currentUser) =>
    roleHas(getRole(user.roleId), permission);

  const canDeleteMessage: StoreValue["canDeleteMessage"] = (message) =>
    message.authorId === currentUser.id || can("message.deleteAny");

  const canDeleteChannel: StoreValue["canDeleteChannel"] = (channel) =>
    !channel.isTeam &&
    (can("channel.delete") || channel.createdBy === currentUser.id);

  const canSeeChannel: StoreValue["canSeeChannel"] = (channel, user = currentUser) => {
    if (!channel.isPrivate) return true;
    return channel.members.some((m) => m.userId === user.id) || can("members.manage", user);
  };

  const channelAccessLevel: StoreValue["channelAccessLevel"] = (
    channel,
    user = currentUser
  ) => {
    if (!channel.isPrivate || can("members.manage", user)) return "editor";
    return resourceMemberLevel(channel.members, user.id) ?? "viewer";
  };

  const canSeeProject: StoreValue["canSeeProject"] = (project, user = currentUser) =>
    canUserSeeProject(state, project, user.id);

  const projectAccessLevel: StoreValue["projectAccessLevel"] = (
    project,
    user = currentUser
  ) => {
    if (!project.restricted || can("members.manage", user)) return "editor";
    return resourceMemberLevel(project.members, user.id) ?? "viewer";
  };

  return (
    <StoreContext.Provider
      value={{
        state,
        currentUser,
        getRole,
        userRole,
        can,
        canDeleteMessage,
        canDeleteChannel,
        canSeeChannel,
        channelAccessLevel,
        canSeeProject,
        projectAccessLevel,
        ...actions,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const ctx = React.useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within a StoreProvider");
  return ctx;
}
