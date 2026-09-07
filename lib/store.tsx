"use client";

import * as React from "react";
import { toast } from "sonner";

import { DEFAULT_ROLES, PERMISSION_META, resourceMemberLevel, roleHas } from "./permissions";
import { createSeed, SEED_VERSION } from "./seed";
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

const STORAGE_KEY = "lumina:v1";
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

  switchUser: (userId: string) => void;
  /** These return false when the action was denied by a guard, so callers
   *  only announce success when something actually changed. */
  setUserRole: (userId: string, roleId: string) => boolean;
  createRole: (input: RoleInput) => RoleDef | null;
  updateRole: (roleId: string, patch: Partial<RoleInput>) => boolean;
  setRolePermission: (
    roleId: string,
    permission: Permission,
    enabled: boolean
  ) => boolean;
  deleteRole: (roleId: string) => boolean;
  resetDemo: () => void;

  /** Post to a channel or DM. Empty content is allowed when files are attached.
   *  Returns false when denied. */
  sendMessage: (
    conversationId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => boolean;
  /** Find-or-create the DM with `otherUserId` and post into it atomically
   *  (safe to call right after picking a person, unlike openDm + sendMessage). */
  sendToUser: (
    otherUserId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => DM | null;
  editMessage: (messageId: string, content: string) => void;
  deleteMessage: (messageId: string) => void;
  toggleReaction: (messageId: string, emoji: string) => void;
  markChannelRead: (conversationId: string) => void;
  createChannel: (input: {
    name: string;
    description: string;
    isPrivate: boolean;
  }) => Channel | null;
  deleteChannel: (channelId: string) => void;
  /** Sets privacy + the per-member access list in one go. The channel's
   *  creator is always kept as an editor so they can't lock themselves out. */
  setChannelAccess: (
    channelId: string,
    patch: { isPrivate: boolean; members: ResourceMember[] }
  ) => boolean;
  openDm: (otherUserId: string) => DM;

  createProject: (input: {
    name: string;
    description: string;
    emoji: string;
    color: string;
    priority: Priority;
  }) => Project | null;
  updateProject: (
    projectId: string,
    patch: Partial<
      Pick<
        Project,
        "name" | "description" | "emoji" | "color" | "priority" | "attachments"
      >
    >
  ) => boolean;
  deleteProject: (projectId: string) => void;
  /** Sets restriction + the per-member access list in one go. The project's
   *  creator is always kept as an editor so they can't lock themselves out. */
  setProjectAccess: (
    projectId: string,
    patch: { restricted: boolean; members: ResourceMember[] }
  ) => boolean;

  createTask: (input: TaskInput) => Task | null;
  /** Returns false when denied (no permission, view-only project, or a
   *  collaborator in the resulting list can't see the project). */
  updateTask: (
    taskId: string,
    patch: Partial<Omit<Task, "id" | "projectId">>
  ) => boolean;
  moveTask: (taskId: string, toStatus: TaskStatus, toIndex: number) => void;
  deleteTask: (taskId: string) => boolean;
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

/** Legacy (pre-v4) persisted shapes we migrate from. */
interface LegacyState
  extends Omit<
    AppState,
    "roles" | "users" | "projects" | "tasks" | "channels" | "messages"
  > {
  messages: Array<Omit<Message, "attachments"> & { attachments?: MessageAttachment[] }>;
  users: Array<Omit<User, "roleId"> & { roleId?: string; role?: string }>;
  roles?: RoleDef[];
  rolePermissions?: Record<string, Permission[]>;
  projects: Array<
    Omit<Project, "priority" | "restricted" | "members" | "attachments"> & {
      priority?: Priority;
      restricted?: boolean;
      members?: ResourceMember[];
      attachments?: Attachment[];
    }
  >;
  tasks: Array<
    Omit<
      Task,
      | "priority"
      | "attachments"
      | "startTime"
      | "durationMinutes"
      | "reminderMinutes"
      | "collaboratorIds"
    > & {
      priority: Priority | "urgent";
      attachments?: Attachment[];
      startTime?: string | null;
      durationMinutes?: number | null;
      reminderMinutes?: number | null;
      collaboratorIds?: string[];
    }
  >;
  channels: Array<
    Omit<Channel, "members"> & { members?: ResourceMember[]; memberIds?: string[] }
  >;
}

function migrate(parsed: LegacyState, parsedVersion: number): AppState {
  const roles: RoleDef[] =
    parsed.roles ??
    DEFAULT_ROLES.map((r) => ({
      ...r,
      permissions: r.locked
        ? [...r.permissions]
        : [...(parsed.rolePermissions?.[r.id] ?? r.permissions)],
    }));
  return {
    version: SEED_VERSION,
    currentUserId: parsed.currentUserId,
    users: parsed.users.map((u) => {
      const { role, ...rest } = u;
      return { ...rest, roleId: u.roleId ?? role ?? "member" };
    }),
    channels: parsed.channels.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      isPrivate: c.isPrivate,
      // Backfill the team flag for workspaces created before it existed.
      // Only for genuinely legacy data — the current schema always sets
      // isTeam explicitly, so re-running this on every load (regardless of
      // version) would wrongly re-flag a brand-new channel just named
      // "general" as the undeletable team channel.
      isTeam: c.isTeam ?? (parsedVersion < SEED_VERSION && c.name === "general" ? true : undefined),
      // Flat memberIds → per-member access, defaulting existing members to editor.
      members:
        c.members ?? (c.memberIds ?? []).map((userId) => ({ userId, level: "editor" as const })),
      createdBy: c.createdBy,
      createdAt: c.createdAt,
    })),
    dms: parsed.dms ?? [],
    // Message attachments are new — older messages have none.
    messages: parsed.messages.map((m) => ({ ...m, attachments: m.attachments ?? [] })),
    // Priority dropped the "urgent" tier — fold it into "high".
    // Project access-control is new — default fully open (unchanged behavior).
    projects: parsed.projects.map((p) => ({
      ...p,
      priority: p.priority ?? "medium",
      restricted: p.restricted ?? false,
      members: p.members ?? [],
      attachments: p.attachments ?? [],
    })),
    tasks: parsed.tasks.map((t) => ({
      ...t,
      priority: t.priority === "urgent" ? "high" : t.priority,
      attachments: t.attachments ?? [],
      // Scheduling is new — older tasks are unscheduled (date-only at most).
      startTime: t.startTime ?? null,
      durationMinutes: t.durationMinutes ?? null,
      reminderMinutes: t.reminderMinutes ?? null,
      // Collaborators are new — older tasks have none.
      collaboratorIds: t.collaboratorIds ?? [],
    })),
    activities: parsed.activities ?? [],
    roles,
    lastRead: parsed.lastRead ?? {},
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AppState | null>(null);

  React.useEffect(() => {
    let next: AppState | null = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LegacyState;
        if (
          typeof parsed?.version === "number" &&
          parsed.version >= 1 &&
          parsed.version <= SEED_VERSION
        ) {
          next = migrate(parsed, parsed.version);
        }
      }
    } catch {
      // Corrupt storage → fall through to a fresh seed.
    }
    setState(next ?? createSeed());
  }, []);

  // Edge-triggered: only warn on the transition into failure, so a large
  // attachment doesn't re-toast on every unrelated state change afterward.
  const lastPersistOk = React.useRef(true);
  React.useEffect(() => {
    if (!state) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      lastPersistOk.current = true;
    } catch {
      if (lastPersistOk.current) {
        toast.error("Couldn't save — local storage is full", {
          description: "Your last change only exists for this tab. Try removing a large attachment.",
        });
      }
      lastPersistOk.current = false;
    }
  }, [state]);

  const update = React.useCallback((fn: (s: AppState) => AppState) => {
    setState((s) => (s ? fn(s) : s));
  }, []);

  // Lets actions read the latest state synchronously without invalidating
  // the memoized actions object.
  const stateRef = React.useRef(state);
  stateRef.current = state;

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

    const switchUser = (userId: string) =>
      update((s) => ({ ...s, currentUserId: userId }));

    const setUserRole = (userId: string, roleId: string): boolean => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return false;
      if (userId === s.currentUserId) {
        deny("You can't change your own role.");
        return false;
      }
      const target = s.users.find((u) => u.id === userId);
      const role = findRole(s, roleId);
      if (!target || !role || target.roleId === roleId) return false;
      const targetRole = findRole(s, target.roleId);
      if (targetRole?.locked) {
        const admins = s.users.filter((u) => findRole(s, u.roleId)?.locked);
        if (admins.length <= 1) {
          deny("A workspace needs at least one admin.");
          return false;
        }
      }
      update((st) => ({
        ...st,
        users: st.users.map((u) => (u.id === userId ? { ...u, roleId } : u)),
        activities: activity(st, "member", `made ${target.name} a ${role.name}`),
      }));
      return true;
    };

    const createRole: StoreValue["createRole"] = (input) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return null;
      const name = input.name.trim();
      if (s.roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        deny(`A role called “${name}” already exists.`);
        return null;
      }
      const role: RoleDef = {
        id: uid("r"),
        name,
        description: input.description,
        color: input.color,
        permissions: [...input.permissions],
      };
      update((st) => ({
        ...st,
        roles: [...st.roles, role],
        activities: activity(st, "member", `created the ${name} role`),
      }));
      return role;
    };

    const updateRole: StoreValue["updateRole"] = (roleId, patch) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return false;
      const role = findRole(s, roleId);
      if (!role) return false;
      if (role.locked) {
        deny("The admin role is locked.");
        return false;
      }
      const nextName = patch.name?.trim();
      if (
        nextName &&
        s.roles.some(
          (r) => r.id !== roleId && r.name.toLowerCase() === nextName.toLowerCase()
        )
      ) {
        deny(`A role called “${nextName}” already exists.`);
        return false;
      }
      update((st) => ({
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
      }));
      return true;
    };

    const setRolePermission: StoreValue["setRolePermission"] = (
      roleId,
      permission,
      enabled
    ) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return false;
      const role = findRole(s, roleId);
      if (!role) return false;
      if (role.locked) {
        deny("The admin role is locked at full access.");
        return false;
      }
      if (enabled === role.permissions.includes(permission)) return false;
      update((st) => ({
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
      }));
      return true;
    };

    const deleteRole = (roleId: string): boolean => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return false;
      const role = findRole(s, roleId);
      if (!role) return false;
      if (role.isSystem || role.locked) {
        deny(`${role.name} is a built-in role and can't be deleted.`);
        return false;
      }
      if (s.users.some((u) => u.roleId === roleId)) {
        deny("Reassign its members to another role first.");
        return false;
      }
      update((st) => ({
        ...st,
        roles: st.roles.filter((r) => r.id !== roleId),
        activities: activity(st, "member", `deleted the ${role.name} role`),
      }));
      return true;
    };

    const resetDemo = () => {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {}
      setState(createSeed());
    };

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

    const appendMessage = (
      st: AppState,
      conversationId: string,
      content: string,
      attachments: MessageAttachment[],
      note: string | null
    ): AppState => ({
      ...st,
      messages: [
        ...st.messages,
        {
          id: uid("m"),
          channelId: conversationId,
          authorId: st.currentUserId,
          content,
          createdAt: Date.now(),
          reactions: [],
          attachments,
        },
      ],
      lastRead: {
        ...st.lastRead,
        [`${st.currentUserId}:${conversationId}`]: Date.now(),
      },
      activities: note ? activity(st, "message", note) : st.activities,
    });

    const sendMessage: StoreValue["sendMessage"] = (
      conversationId,
      content,
      attachments = []
    ) => {
      const s = stateRef.current;
      if (!s) return false;
      if (!content.trim() && attachments.length === 0) return false;
      // DMs are open to everyone (but only their two participants); posting
      // in channels is gated by a permission.
      const channel = s.channels.find((c) => c.id === conversationId);
      let otherUserId: string | undefined;
      if (channel) {
        if (!guard("message.send")) return false;
        if (channelIsViewerOnly(s, channel)) {
          deny("You have view-only access to this channel.");
          return false;
        }
      } else {
        const dm = s.dms.find((d) => d.id === conversationId);
        if (!dm || !dm.memberIds.includes(s.currentUserId)) return false;
        otherUserId = dm.memberIds.find((id) => id !== s.currentUserId);
      }
      const note = shareNote(s, attachments, channel, otherUserId);
      update((st) => appendMessage(st, conversationId, content, attachments, note));
      return true;
    };

    const sendToUser: StoreValue["sendToUser"] = (
      otherUserId,
      content,
      attachments = []
    ) => {
      const s = stateRef.current;
      if (!s) return null;
      if (!content.trim() && attachments.length === 0) return null;
      if (otherUserId === s.currentUserId || !s.users.some((u) => u.id === otherUserId)) {
        return null;
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
      update((st) =>
        appendMessage(
          existing ? st : { ...st, dms: [...st.dms, dm] },
          dm.id,
          content,
          attachments,
          note
        )
      );
      return dm;
    };

    const editMessage = (messageId: string, content: string) => {
      const s = stateRef.current;
      if (!s) return;
      const message = s.messages.find((m) => m.id === messageId);
      if (!message || message.authorId !== s.currentUserId) {
        deny("You can only edit your own messages.");
        return;
      }
      update((st) => ({
        ...st,
        messages: st.messages.map((m) =>
          m.id === messageId ? { ...m, content, editedAt: Date.now() } : m
        ),
      }));
    };

    const deleteMessage = (messageId: string) => {
      const s = stateRef.current;
      if (!s) return;
      const message = s.messages.find((m) => m.id === messageId);
      if (!message) return;
      if (message.authorId !== s.currentUserId && !guard("message.deleteAny")) return;
      update((st) => ({
        ...st,
        messages: st.messages.filter((m) => m.id !== messageId),
      }));
    };

    const toggleReaction = (messageId: string, emoji: string) => {
      const s0 = stateRef.current;
      const message0 = s0?.messages.find((m) => m.id === messageId);
      if (!s0 || !message0 || !canSeeConversation(s0, message0.channelId)) return;
      update((s) => ({
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
      }));
    };

    const markChannelRead = (conversationId: string) =>
      update((s) => {
        const key = `${s.currentUserId}:${conversationId}`;
        const latest = s.messages.reduce(
          (acc, m) =>
            m.channelId === conversationId ? Math.max(acc, m.createdAt) : acc,
          0
        );
        if ((s.lastRead[key] ?? 0) >= latest) return s;
        return { ...s, lastRead: { ...s.lastRead, [key]: Date.now() } };
      });

    const createChannel: StoreValue["createChannel"] = (input) => {
      if (!guard("channel.create")) return null;
      const channel: Channel = {
        id: uid("c"),
        name: input.name,
        description: input.description,
        isPrivate: input.isPrivate,
        // Explicit false so a channel created today never has a missing
        // isTeam key for the legacy-migration name-based backfill to catch.
        isTeam: false,
        members: [],
        createdBy: "",
        createdAt: Date.now(),
      };
      update((s) => {
        const withOwner: Channel = {
          ...channel,
          createdBy: s.currentUserId,
          members: input.isPrivate
            ? [{ userId: s.currentUserId, level: "editor" }]
            : [],
        };
        return {
          ...s,
          channels: [...s.channels, withOwner],
          activities: activity(s, "channel", `created #${input.name}`),
        };
      });
      return channel;
    };

    const setChannelAccess: StoreValue["setChannelAccess"] = (channelId, patch) => {
      const s = stateRef.current;
      if (!s) return false;
      const channel = s.channels.find((c) => c.id === channelId);
      if (!channel) return false;
      if (!channelIsManageable(s, channel)) {
        deny("You don't have permission to manage this channel.");
        return false;
      }
      const members = patch.isPrivate
        ? ensureEditor(patch.members, channel.createdBy)
        : [];
      update((st) => ({
        ...st,
        channels: st.channels.map((c) =>
          c.id === channelId ? { ...c, isPrivate: patch.isPrivate, members } : c
        ),
        activities: activity(st, "channel", `updated access for #${channel.name}`),
      }));
      return true;
    };

    const deleteChannel = (channelId: string) => {
      const s = stateRef.current;
      if (!s) return;
      const channel = s.channels.find((c) => c.id === channelId);
      if (!channel) return;
      if (channel.isTeam) {
        deny("The team channel can't be deleted.");
        return;
      }
      if (channel.createdBy !== s.currentUserId && !guard("channel.delete")) return;
      update((st) => ({
        ...st,
        channels: st.channels.filter((c) => c.id !== channelId),
        messages: st.messages.filter((m) => m.channelId !== channelId),
        activities: activity(st, "channel", `deleted #${channel.name}`),
      }));
    };

    const openDm: StoreValue["openDm"] = (otherUserId) => {
      const s = stateRef.current;
      if (!s) throw new Error("Store not hydrated");
      const me = s.currentUserId;
      const existing = s.dms.find(
        (d) => d.memberIds.includes(me) && d.memberIds.includes(otherUserId)
      );
      if (existing) return existing;
      const dm: DM = {
        id: uid("d"),
        memberIds: [me, otherUserId],
        createdAt: Date.now(),
      };
      update((st) => ({ ...st, dms: [...st.dms, dm] }));
      return dm;
    };

    const createProject: StoreValue["createProject"] = (input) => {
      if (!guard("project.create")) return null;
      const project: Project = {
        id: uid("p"),
        ...input,
        restricted: false,
        members: [],
        attachments: [],
        createdBy: "",
        createdAt: Date.now(),
      };
      update((s) => ({
        ...s,
        projects: [...s.projects, { ...project, createdBy: s.currentUserId }],
        activities: activity(s, "project", `created the ${input.name} project`),
      }));
      return project;
    };

    const updateProject: StoreValue["updateProject"] = (projectId, patch) => {
      // Editing a project is part of the "manage projects" capability.
      if (!guard("project.create")) return false;
      // Every patch (not just attachments) is subject to the same
      // object-level manageability check as channel access changes.
      const cur = stateRef.current;
      const target = cur?.projects.find((p) => p.id === projectId);
      if (cur && target && !projectIsManageable(cur, target)) {
        deny("You don't have permission to edit this project.");
        return false;
      }
      update((s) => {
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
      });
      return true;
    };

    const deleteProject = (projectId: string) => {
      if (!guard("project.delete")) return;
      update((s) => {
        const project = s.projects.find((p) => p.id === projectId);
        if (!project) return s;
        return {
          ...s,
          projects: s.projects.filter((p) => p.id !== projectId),
          tasks: s.tasks.filter((t) => t.projectId !== projectId),
          activities: activity(s, "project", `deleted the ${project.name} project`),
        };
      });
    };

    const setProjectAccess: StoreValue["setProjectAccess"] = (projectId, patch) => {
      // Managing a project's membership is part of the "manage projects"
      // capability — same requirement updateProject already enforces.
      if (!guard("project.create")) return false;
      const s = stateRef.current;
      if (!s) return false;
      const project = s.projects.find((p) => p.id === projectId);
      if (!project) return false;
      if (!projectIsManageable(s, project)) {
        deny("You don't have permission to manage this project.");
        return false;
      }
      const members = patch.restricted
        ? ensureEditor(patch.members, project.createdBy)
        : [];
      const updatedProject: Project = { ...project, restricted: patch.restricted, members };
      update((st) => {
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
      });
      return true;
    };

    const createTask: StoreValue["createTask"] = (input) => {
      if (!guard("task.create")) return null;
      const s0 = stateRef.current;
      const project0 = s0?.projects.find((p) => p.id === input.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return null;
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
        return null;
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
          return null;
        }
      }
      const columnSize = s0
        ? s0.tasks.filter((t) => t.projectId === input.projectId && t.status === input.status)
            .length
        : 0;
      const task: Task = {
        id: uid("t"),
        ...input,
        collaboratorIds,
        order: columnSize,
        createdAt: Date.now(),
        createdBy: "",
      };
      update((s) => ({
        ...s,
        tasks: [...s.tasks, { ...task, createdBy: s.currentUserId }],
        activities: activity(s, "task", `created “${input.title}”`),
      }));
      return task;
    };

    const updateTask: StoreValue["updateTask"] = (taskId, patch) => {
      if (!guard("task.edit")) return false;
      const s0 = stateRef.current;
      const task0 = s0?.tasks.find((t) => t.id === taskId);
      const project0 = task0 && s0?.projects.find((p) => p.id === task0.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return false;
      }
      if (!s0 || !task0) return false;
      // Fail closed: a task whose project can't be resolved can't have its
      // owner/collaborators checked against anything, so the write must be
      // refused rather than let the check fall through unrun.
      if (!project0) {
        deny("That project doesn't exist.");
        return false;
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
        return false;
      }
      update((s) => {
        const prev = s.tasks.find((t) => t.id === taskId);
        if (!prev) return s;
        const completed = patch.status === "done" && prev.status !== "done";
        const next: Task = { ...prev, ...patch, collaboratorIds: resultingCollaborators };
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
      });
      return true;
    };

    const moveTask: StoreValue["moveTask"] = (taskId, toStatus, toIndex) => {
      if (!guard("task.move")) return;
      const s0 = stateRef.current;
      const task0 = s0?.tasks.find((t) => t.id === taskId);
      const project0 = task0 && s0?.projects.find((p) => p.id === task0.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return;
      }
      update((s) => {
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
      });
    };

    const deleteTask = (taskId: string): boolean => {
      if (!guard("task.delete")) return false;
      const s0 = stateRef.current;
      const task0 = s0?.tasks.find((t) => t.id === taskId);
      const project0 = task0 && s0?.projects.find((p) => p.id === task0.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return false;
      }
      if (!task0) return false;
      update((s) => {
        const task = s.tasks.find((t) => t.id === taskId);
        if (!task) return s;
        return {
          ...s,
          tasks: s.tasks.filter((t) => t.id !== taskId),
          activities: activity(s, "task", `deleted “${task.title}”`),
        };
      });
      return true;
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
  }, [update]);

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
