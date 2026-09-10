"use client";

import * as React from "react";
import { toast } from "sonner";

import { backendKind, createBackend } from "./backend";
import { isDoneStatus } from "./statuses";
import type {
  AttachmentRemovals,
  Backend,
  ChannelAccessPatch,
  ProjectAccessPatch,
  ProjectPatch,
  RealtimeEvent,
  RolePatch,
  StatusPatch,
  TaskPatch,
} from "./backend/types";
import {
  DEFAULT_ROLE_RANK,
  PERMISSION_META,
  rankOf,
  resourceMemberLevel,
  roleHas,
} from "./permissions";
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
  StatusDef,
  Task,
  TaskStatus,
  User,
} from "./types";

const MAX_ACTIVITIES = 60;

/**
 * A patch with its `removedAttachmentIds` taken off.
 *
 * That key tells the backend which files the user deliberately removed (see
 * `AttachmentRemovals` in lib/backend/types.ts). It is an instruction, not a
 * field of a Project or a Task, so it goes to the backend and never into
 * `AppState`.
 */
function withoutRemovals<T extends AttachmentRemovals>(
  patch: T
): Omit<T, "removedAttachmentIds"> {
  const fields = { ...patch };
  delete fields.removedAttachmentIds;
  return fields;
}

/** How long a `stale` event waits for company before it costs a reload. One
 *  upstream change often produces several published rows (a task and its
 *  collaborators, a DM and its two members), and one reload answers all of
 *  them. Short enough that a live change still feels immediate. */
const STALE_RELOAD_MS = 250;

/**
 * Applies the live presence set to a whole state the backend just handed back.
 *
 * Presence is CHANNEL state, not row state. Nothing in Postgres knows who has
 * a tab open, so `hydrate()` cannot answer it — the Supabase mapping marks
 * every profile `"offline"` for exactly that reason (see `toUser` in
 * lib/backend/supabase/mapping.ts), and the only thing that ever says
 * otherwise is a `presence` event off the channel.
 *
 * So a reload that adopted a hydrate's answer verbatim would BLANK every dot
 * — on every coalesced `stale` reload, which is most workspace changes — and
 * leave them blank until somebody happened to join or leave, which may be
 * minutes. That is the stale-dot failure the brief calls worse than no dot at
 * all, arriving from the direction nobody was watching. Rows come from
 * `fresh`; presence comes from what the channel last said.
 *
 * `online` is the SET the channel reported, not the previous state's users,
 * and that distinction is load-bearing: at sign-in the presence event arrives
 * while the store still holds the signed-out shell, whose user list does not
 * contain the person signing in. Carrying presence forward user-by-user would
 * have nothing to carry, and the dot would stay dark until the next join or
 * leave — which is exactly what a browser showed. The set survives the gap;
 * the reload that introduces the user then lights them.
 *
 * `null` means the channel has never said anything (a `LocalBackend` session
 * never will), and then `fresh` is taken exactly as given.
 */
function withLivePresence(fresh: AppState, online: ReadonlySet<string> | null): AppState {
  if (!online) return fresh;
  return {
    ...fresh,
    users: fresh.users.map((u) => ({
      ...u,
      presence: online.has(u.id) ? "online" : "offline",
    })),
  };
}

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
  /** Whether the last `connection` event this store heard said the socket
   *  was up. Defaults to `true` — see the state declaration below for why —
   *  so this is meaningful only once a real backend's channel has actually
   *  reported a drop; `LocalBackend`'s inert `subscribe()` never emits one,
   *  so it never leaves `true`. `ConnectionStatus` renders off this and
   *  nothing else. */
  connected: boolean;

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

  /**
   * Invite someone to the workspace by email.
   *
   * Deliberately NOT routed through `commit`: there is no optimistic state to
   * apply. The invited person has no profile until they accept, so there is
   * nothing to show on screen and nothing to roll back — inventing a
   * placeholder member would be a claim the workspace cannot back up.
   *
   * Resolves the error message on failure, `null` on success, so the dialog
   * can show what the server actually said rather than a generic failure.
   */
  inviteUser: (email: string, roleId: string) => Promise<string | null>;

  /**
   * The board's columns. Owner only — `workspace.statuses` is the one
   * permission that separates Owner from Admin.
   *
   * The refusals live here as well as in the database on purpose: the
   * database's are absolute (a foreign key, a unique index) but arrive as
   * constraint errors, and a person deleting a column deserves "3 tasks are
   * still in Backlog" rather than a Postgres message.
   */
  createStatus: (input: { name: string; color: string }) => Promise<StatusDef | null>;
  updateStatus: (statusId: string, patch: StatusPatch) => Promise<boolean>;
  deleteStatus: (statusId: string) => Promise<boolean>;
  reorderStatuses: (orderedIds: string[]) => Promise<boolean>;
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
  /** Resolves `false` when the edit was refused or rolled back, so the caller
   *  can give the user back what they typed — see `deleteMessage`. */
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  /**
   * Resolves `false` when the delete was refused or rolled back.
   *
   * It used to be `Promise<void>` — the only two write actions that handed
   * the caller nothing to check — so `components/chat/message-item.tsx` had
   * no way to avoid announcing a delete the store then undid (QA-122).
   */
  deleteMessage: (messageId: string) => Promise<boolean>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  markChannelRead: (conversationId: string) => Promise<void>;
  createChannel: (input: {
    name: string;
    description: string;
    isPrivate: boolean;
  }) => Promise<Channel | null>;
  deleteChannel: (channelId: string) => Promise<boolean>;
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
  updateProject: (
    projectId: string,
    patch: ProjectPatch,
    /** Replaces "Your change has been undone." in the failure toast. The
     *  document editors pass one because by the time they call this the
     *  file's bytes have already been replaced in Storage, and a rollback
     *  cannot put the old ones back — see `commit`. */
    opts?: { undone?: string }
  ) => Promise<boolean>;
  deleteProject: (projectId: string) => Promise<boolean>;
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
  /** Resolves `false` when the move was refused (no `task.move`, a view-only
   *  project) or rolled back — see `deleteMessage` for why these two grew a
   *  return value. */
  moveTask: (
    taskId: string,
    toStatus: TaskStatus,
    toIndex: number
  ) => Promise<boolean>;
  deleteTask: (taskId: string) => Promise<boolean>;
}

const StoreContext = React.createContext<StoreValue | null>(null);

/** Which resource an activity's text names. At most one field is set; `{}`
 *  (spelled WORKSPACE_WIDE at the call sites) means the event belongs to
 *  nobody in particular and everyone may read it. */
interface ActivityScope {
  projectId?: string;
  conversationId?: string;
}

/** A role change, a new role, a permission grant: these name no project and no
 *  channel, so there is nothing to hide and every user sees them. */
const WORKSPACE_WIDE: ActivityScope = {};

/** `scope` is required rather than optional on purpose. Defaulting it would
 *  make "workspace-wide" — the one value that is readable by everyone — the
 *  thing you get by forgetting, which is precisely how `created the Payroll
 *  project` ended up in every browser. Making it explicit means a new call
 *  site cannot leak by omission; it fails to compile instead. */
function activity(
  state: AppState,
  kind: ActivityKind,
  text: string,
  scope: ActivityScope,
  actorId?: string
): Activity[] {
  const entry: Activity = {
    id: uid("a"),
    ts: Date.now(),
    actorId: actorId ?? state.currentUserId,
    text,
    kind,
    projectId: scope.projectId ?? null,
    conversationId: scope.conversationId ?? null,
  };
  return [...state.activities, entry].slice(-MAX_ACTIVITIES);
}

/** The ids `patch` appended to the feed — i.e. the log lines this one write
 *  produced. Diffed rather than passed in, so the ~15 `activity(...)` call
 *  sites need no second argument and a call site added by a later task is
 *  persisted the moment it exists. Ids, not the entries themselves: `commit`
 *  re-reads them from state after the backend has resolved, because
 *  `adoptDmId` can rewrite an entry's `conversationId` in exactly that window
 *  and the stale id would name a conversation the server never had. */
function appendedActivityIds(before: AppState, after: AppState | null): string[] {
  if (!after || after.activities === before.activities) return [];
  const had = new Set(before.activities.map((a) => a.id));
  return after.activities.filter((a) => !had.has(a.id)).map((a) => a.id);
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
  // Only a session-backed backend has anything to re-fetch when the signed-in
  // user changes. The local demo already holds the whole workspace, and
  // re-hydrating it there would throw away an injected test fixture.
  const refetchesOnSignIn = !injectedBackend && backendKind === "supabase";
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

  /** Set when the *first* hydrate rejects, so the screen below can offer a
   *  retry instead of spinning forever. `LocalBackend` never rejects; a real
   *  one does — a dropped connection, an expired session, a database that is
   *  briefly unreachable. Deliberately NOT falling back to `createSeed()`:
   *  that would put fictional colleagues, messages and tasks in front of a
   *  real user and let them type into a workspace that does not exist. */
  const [hydrateFailed, setHydrateFailed] = React.useState(false);
  /** Bumped by the retry button, and by the apply core below on a
   *  reconnect; re-runs the effect below. */
  const [hydrateAttempt, setHydrateAttempt] = React.useState(0);

  /** Whether the last `connection` event said the socket is up. Starts
   *  `true`, deliberately not `false`: `LocalBackend`'s `subscribe()` is
   *  inert and never emits one at all, and every other backend double in
   *  the 34 suites that mount `StoreProvider` only emits what a test tells
   *  it to. A `false` default would make every one of those suites render
   *  a "disconnected" workspace that never actually lost a socket — the
   *  exact false alarm the brief says a quiet indicator must not raise —
   *  and would do it silently, since nothing in most of those suites reads
   *  `connected` to notice. `true` is also the only default consistent with
   *  what a real session looks like: the channel is freshly opened by the
   *  time this state exists, well before it could have failed. */
  const [connected, setConnected] = React.useState(true);

  /**
   * The browser's own view of connectivity (QA-128).
   *
   * Nothing here listened to it. Close a laptop, walk into a tunnel, lose
   * wifi: the browser knows at once and fires `offline`, but the app only
   * discovered it when the socket's own heartbeat eventually timed out — and
   * until then the indicator showed nothing, the connection was reported
   * healthy, and messages simply stopped arriving with nothing to say so.
   * The length of that silent window was decided by the socket's timeout
   * rather than by anything the app controls.
   *
   * The whole point of the connection indicator is to make "connected" mean
   * "receiving". A browser that says it is offline is not receiving, so that
   * answer is taken directly and immediately.
   *
   * `navigator.onLine` is famously weak in the other direction — `true` only
   * means an interface is up, not that anything is reachable — which is
   * exactly why this is a one-way override: `false` forces the indicator
   * down, `true` defers to what the channel actually reports.
   */
  const [browserOffline, setBrowserOffline] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const goOffline = () => setBrowserOffline(true);
    const goOnline = () => setBrowserOffline(false);
    // Read once on mount too: the tab may have been restored offline, in
    // which case no event is coming.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setBrowserOffline(true);
    }
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);
  /** The same value the apply core can read SYNCHRONOUSLY, so a `connection`
   *  event can tell a transition from a repeat. Starts `true` for the reason
   *  above: nothing has dropped yet, so the first `online: true` is a
   *  confirmation and not a recovery. */
  const onlineRef = React.useRef(true);

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

  /** Monotonic count of state changes applied on top of a snapshot. A failing
   *  write compares the value it took against this to find out whether
   *  anything landed while it was in flight — see `commit` below.
   *
   *  "Optimistic patches" until Task 2; now ALSO every live update the apply
   *  core lands, because from here on this client is not the only writer of
   *  `AppState`. A pushed change that did not bump this would be invisible to
   *  the rollback rule, which would then restore a snapshot taken before it
   *  and erase it with no error and no toast. */
  const writeSeq = React.useRef(0);

  /** Pending coalesced reload for `stale` events: a burst costs one reload,
   *  not one each. Holds the timer id, or null when nothing is armed. */
  const staleTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** How many writes are in flight. A reload while one is running would drop
   *  its optimistic patch and then race its own rollback, so `stale` waits
   *  instead of interleaving. */
  const writeInFlight = React.useRef(0);

  /** The whole online set the channel last reported, or `null` while it has
   *  never reported one. A ref, not state: every reload path below reads it at
   *  the moment a hydrate resolves, which is not a render. See
   *  `withLivePresence` for why the SET is kept rather than the presence
   *  already written onto `state.users`. */
  const livePresence = React.useRef<ReadonlySet<string> | null>(null);

  /**
   * Every state change that is NOT a `commit` patch lands through one of
   * these two, so it cannot forget Rule 2.
   *
   * `writeSeq` was bumped by hand at five sites and skipped at five others
   * (QA-102/QA-114) — including, worst of all, inside `commit`'s own rollback,
   * the function that implements the rule. Bumping is not an optimisation: a
   * change that lands without it is INVISIBLE to a write already in flight,
   * whose rollback then restores a snapshot taken before it and erases it with
   * no error and no toast. Any landing an in-flight write's snapshot predates
   * has to be counted, whether it came from the server, from a live event, or
   * from this client adopting a server-assigned id.
   *
   * The only adopt that deliberately does NOT go through these is `commit`'s
   * `adopt(snapshot)` restore, which puts back a state that was already
   * counted when it was patched.
   */
  const adoptLanded = React.useCallback(
    (next: AppState) => {
      adopt(next);
      writeSeq.current += 1;
    },
    [adopt]
  );

  const updateLanded = React.useCallback(
    (fn: (s: AppState) => AppState) => {
      update(fn);
      writeSeq.current += 1;
    },
    [update]
  );

  /**
   * Resolvers waiting for the last write in flight to settle — see
   * `whenWritesSettle`. A list rather than a timer: the `stale` path polls on
   * a 250 ms timer because it is answering an event that may never come
   * again, but a rollback's reload is answering a promise this store is
   * already holding, so it can be told exactly when to go.
   */
  const idleWaiters = React.useRef<Array<() => void>>([]);

  /** Releases one write's hold on `writeInFlight`, waking anything that was
   *  waiting for the last of them. Called in BOTH of `commit`'s branches. */
  const releaseWrite = React.useCallback(() => {
    writeInFlight.current -= 1;
    if (writeInFlight.current > 0) return;
    const waiting = idleWaiters.current;
    idleWaiters.current = [];
    for (const wake of waiting) wake();
  }, []);

  const whenWritesSettle = React.useCallback((): Promise<void> => {
    if (writeInFlight.current === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      idleWaiters.current.push(resolve);
    });
  }, []);

  /** The whole-state reload a failed write asked for, while it is pending;
   *  null when none is. Shared by every write that fails while it is
   *  outstanding, so a burst of refusals costs one reload rather than one
   *  each — they would all be answering the same question. */
  const pendingReload = React.useRef<Promise<boolean> | null>(null);

  /**
   * `commit`'s rollback re-hydrate: the fourth whole-state adopt, and the one
   * that obeyed neither rule (QA-102).
   *
   * - **Never land over a write in flight**, exactly as the hydration effect
   *   and the `stale` reload do. `commit` decrements `writeInFlight` before it
   *   gets here, so this waits on the OTHER writes: reloading while one is
   *   unconfirmed replaces its optimistic patch with a server state that does
   *   not have it yet, and nothing puts it back when it succeeds. Waiting also
   *   makes the answer better, because a write that lands in the meantime is
   *   in the state this then fetches.
   * - **Bump `writeSeq` on adopt** — `adoptLanded` does it.
   *
   * Resolves `true` when a fresh state was adopted, `false` when the reload
   * itself failed and the screen is out of sync.
   */
  const reloadAfterFailedWrite = React.useCallback((): Promise<boolean> => {
    const already = pendingReload.current;
    if (already) return already;
    const run = whenWritesSettle()
      .then(() => backend.hydrate())
      .then(
        (fresh) => {
          // Rows from the server, presence from the channel — the same reason
          // as the other reload paths: a hydrate cannot know who has a tab
          // open, so adopting its answer verbatim would blank every dot as a
          // side effect of one write being refused.
          adoptLanded(withLivePresence(fresh, livePresence.current));
          return true;
        },
        () => false
      )
      .finally(() => {
        pendingReload.current = null;
      });
    pendingReload.current = run;
    return run;
  }, [backend, adoptLanded, whenWritesSettle]);

  /**
   * Hydration: the loading screen below shows until the FIRST of these
   * resolves. Re-runs whenever `hydrateAttempt` moves — the retry button, a
   * sign-in, and a reconnect all recover by bumping it.
   *
   * Declared HERE, below `writeSeq` and `writeInFlight`, because past the
   * first run this is a reload landing a whole fresh `AppState` on a store
   * that has a SECOND WRITER — so it owes the same two rules the `stale`
   * reload in the apply core below obeys, and for the same reasons:
   *
   * - **Never land over a write in flight.** A reload mid-write replaces the
   *   optimistic patch with a server state that does not have it yet, and
   *   that write's own rollback then reasons about a state it never patched.
   *   Wait instead, exactly as `stale` does.
   * - **Bump `writeSeq` on adopt.** This is the one that was missing, and it
   *   is the worst place to miss it: a write can still begin AFTER the
   *   hydrate is issued and be in flight when it lands. Without the bump,
   *   that write failing would find `writeSeq` unchanged, restore its
   *   pre-reload snapshot, and silently erase everything the reconnect just
   *   recovered — on the one path whose whole purpose is recovering data,
   *   and at precisely the moment (a network blip) when a write failing and
   *   a socket reconnecting are most likely to coincide.
   */
  React.useEffect(() => {
    let cancelled = false;
    let waiting: ReturnType<typeof setTimeout> | null = null;

    function load() {
      waiting = null;
      if (cancelled) return;
      // Rule 3, as the `stale` path states it. Inert on the first run: no
      // action can have been dispatched before the store has any state.
      if (writeInFlight.current > 0) {
        waiting = setTimeout(load, STALE_RELOAD_MS);
        return;
      }
      void backend.hydrate().then(
        (next) => {
          if (cancelled) return;
          setHydrateFailed(false);
          // Rule 2 — see the block comment above — is `adoptLanded`'s job.
          adoptLanded(withLivePresence(next, livePresence.current));
        },
        (error: unknown) => {
          if (cancelled) return;
          console.error("Lumina: could not load the workspace", error);
          setHydrateFailed(true);
        }
      );
    }

    load();
    return () => {
      cancelled = true;
      if (waiting !== null) clearTimeout(waiting);
    };
  }, [backend, adoptLanded, hydrateAttempt]);

  /**
   * The apply core: everything the server pushes enters `AppState` here, and
   * nowhere else.
   *
   * Three rules, and each exists because the store now has a second writer:
   *
   * 1. **Dedup by id.** Message ids are generated client-side, so the echo of
   *    a message this browser sent arrives carrying an id it already holds.
   *    Appending it would double every message the user sends. Ids the SERVER
   *    chooses are already adopted explicitly elsewhere (a DM's id in
   *    `adoptDmId`, a task's position in `createTask`); a live update must not
   *    re-fight either, which is one more reason `message-insert` is the only
   *    event applied directly.
   * 2. **Bump `writeSeq`.** See the ref's comment above: this is what makes a
   *    pushed change visible to a failing write's rollback.
   * 3. **Coalesce `stale`, and never reload over a write in flight.** One
   *    change upstream can produce several rows (a task plus its
   *    collaborators, a DM plus its members); one reload answers all of them.
   *
   * `default:` rather than an exhaustive switch on purpose — a later task may
   * still add a `connection` variant, and a store that has not learned about
   * a variant yet should ignore it, not throw.
   */
  const applyEvent = React.useCallback(
    (event: RealtimeEvent) => {
      switch (event.kind) {
        case "message-insert": {
          const current = stateRef.current;
          if (!current) return;
          const { message } = event;
          // Rule 1. Also covers a duplicate delivery of the same event.
          if (current.messages.some((m) => m.id === message.id)) return;
          // Only `messages` is touched, so the activity feed's 60-entry cap
          // (MAX_ACTIVITIES) cannot be breached from here; the `stale` path
          // below re-reads a capped feed from the backend.
          // `updateLanded`, and the whole reason this counter is not named
          // `optimisticSeq`. A write already in flight took its number before
          // this landed; the bump is what tells its rollback that the state it
          // snapshotted is no longer the state on screen, so it re-hydrates
          // instead of rewinding this message away.
          updateLanded((s) => ({ ...s, messages: [...s.messages, message] }));
          return;
        }
        case "stale": {
          // Rule 3. `arm` and `reload` are declarations, not consts, so
          // `reload` can re-arm the timer without either of them having to
          // reach outside this callback for the other.
          function arm() {
            if (staleTimer.current !== null) clearTimeout(staleTimer.current);
            staleTimer.current = setTimeout(reload, STALE_RELOAD_MS);
          }
          function reload() {
            staleTimer.current = null;
            // Waiting rather than reloading is not merely a delay: a reload
            // mid-write would replace the optimistic patch with a server state
            // that does not have it yet, and that write's own rollback would
            // then be reasoning about a state it never patched.
            if (writeInFlight.current > 0) {
              arm();
              return;
            }
            void backend.hydrate().then(
              (fresh) => {
                // Rows from the server, presence from the channel — see
                // `withLivePresence`. Without it this reload, which most
                // workspace changes end in, blanks every dot.
                // Rule 2, for a whole-state landing: `adoptLanded`.
                adoptLanded(withLivePresence(fresh, livePresence.current));
              },
              (error: unknown) => {
                // Nothing is undone and nothing is claimed: the screen keeps
                // showing what it had, which is what it would show if there
                // were no live updates at all. The next event tries again.
                console.error("Lumina: could not refresh the workspace", error);
              }
            );
          }
          arm();
          return;
        }
        case "presence": {
          // The decision this event encodes: online means a tab is open, full
          // stop. `onlineUserIds` is the WHOLE current set — not a delta — so
          // every user not named here is set `offline`, including one who was
          // online a moment ago. That second half is the one a lazy apply
          // would skip (mark the named users online, leave everyone else
          // alone), which is exactly how a dot survives someone closing their
          // tab: the failure mode the brief calls out as worse than no dot at
          // all, because people act on it.
          const online = new Set(event.onlineUserIds);
          // Kept for the reload paths, which run when this state is long
          // gone. It is also the ONLY record of a set that arrived before the
          // workspace did — at sign-in this event lands on the signed-out
          // shell, whose user list contains nobody it names.
          livePresence.current = online;
          // `updateLanded`, same reason as `message-insert`: a write in flight
          // when this lands must re-hydrate on failure rather than have its
          // rollback silently restore a snapshot with stale presence in it.
          updateLanded((s) => ({
            ...s,
            users: s.users.map((u) => ({
              ...u,
              presence: online.has(u.id) ? "online" : "offline",
            })),
          }));
          return;
        }
        case "connection": {
          // Say so either way — this is the whole reason the flag exists,
          // and it has to move in BOTH directions: stuck `false` after a
          // real reconnect would leave `ConnectionStatus` lying that the
          // workspace is still stale, and stuck `true` after a drop is the
          // silent-staleness failure this task exists to prevent.
          setConnected(event.online);
          // Only the transition BACK UP costs a reload. Going offline has
          // nothing yet to recover — there is no fresher state to fetch
          // while the socket is down, and hydrating now would just fail —
          // but coming back online is the only chance to recover whatever
          // happened while it was down, because the server does not replay
          // missed changes. Re-uses the retry/sign-in counter (see its
          // comment) rather than adding a third way to refetch; NOT gated
          // by `refetchesOnSignIn`, because a real reconnect happens on
          // every backend, injected test doubles included.
          //
          // On the TRANSITION, not on the state. `online: true` is emitted
          // every time the channel reports itself healthy — the first
          // `SUBSCRIBED` of a page load included, and again after every
          // re-join — so reloading whenever it is true costs a redundant
          // whole-workspace fetch each time (the review logged
          // `true,false,true,false,true,false,true` across one
          // sign-out/sign-in: four of them). There is only something to
          // recover when the socket was DOWN and has come back; a repeat of
          // "still up" has missed nothing. A ref and not `connected`,
          // because this callback needs the previous value synchronously
          // and a state variable read here is the one captured at render.
          const wasOnline = onlineRef.current;
          onlineRef.current = event.online;
          if (event.online && !wasOnline) setHydrateAttempt((n) => n + 1);
          return;
        }
        default:
          return;
      }
    },
    [backend, adoptLanded, updateLanded]
  );

  React.useEffect(() => {
    const unsubscribe = backend.subscribe((event) => {
      // Deferred: the Supabase client holds an internal lock across this
      // callback, and calling back into it from inside can deadlock — which
      // `backend.hydrate()` on the `stale` path would do. lib/auth.tsx defers
      // `onAuthStateChange` for exactly this reason, and records it there.
      setTimeout(() => applyEvent(event), 0);
    });
    return () => {
      unsubscribe();
      if (staleTimer.current !== null) {
        clearTimeout(staleTimer.current);
        staleTimer.current = null;
      }
    };
  }, [backend, applyEvent]);

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
     * Persists the feed lines a write produced, and reconciles the screen with
     * whatever the server actually kept.
     *
     * ATOMICITY, stated plainly: there is none between a write and its log
     * line, on purpose. An activity is an append-only record *about* a change,
     * not part of it, so a failed log line must never undo a change that
     * really happened — a rolled-back project because its feed row was
     * refused would be a far worse lie than a missing feed row. Hence this
     * runs after `op()` has resolved and NEVER rejects: the action still
     * reports success and `commit` still returns `outcome.ok(...)`.
     *
     * What it does instead is delete the optimistic entry from `AppState`. The
     * store put the line on screen before the server had it; if the server
     * then refuses it, leaving it there would show something that vanishes on
     * the next reload — the precise failure this whole seam exists to stop.
     * Removing it by id (rather than restoring a snapshot) is safe whatever
     * else has landed in the meantime, and per-entry, so one refused line out
     * of three does not take the other two with it.
     *
     * Deliberately no toast. The user's action succeeded and has already been
     * confirmed; a "couldn't save" on top of it would misreport what happened,
     * and it would fire on every successful delete — `deleted the X project`
     * is un-persistable by design (the scope foreign keys cascade), so its
     * insert is *expected* to be refused. The correction of the feed is the
     * honest signal; the console carries the reason.
     */
    const logActivities = (ids: string[]): Promise<void> => {
      const state = stateRef.current;
      if (ids.length === 0 || !state) return Promise.resolve();
      const byId = new Map(state.activities.map((a) => [a.id, a]));
      return Promise.all(
        ids.map((id) => {
          // Gone already (rolled back, or aged past MAX_ACTIVITIES) — nothing
          // on screen to justify, so nothing to write.
          const entry = byId.get(id);
          if (!entry) return Promise.resolve(null);
          return backend.putActivity(entry).then(
            () => null,
            (error: unknown) => {
              console.error("Lumina: could not log activity", entry.text, error);
              return id;
            }
          );
        })
      ).then((refused) => {
        const drop = new Set(refused.filter((id): id is string => id !== null));
        if (drop.size === 0) return;
        // `updateLanded`: the server refused these lines, so a rollback that
        // restored a snapshot taken before this correction would put them
        // back on screen — the one thing this function exists to prevent.
        updateLanded((s) => ({
          ...s,
          activities: s.activities.filter((a) => !drop.has(a.id)),
        }));
      });
    };

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
     * 5. on success only, persist whatever feed lines the patch appended (see
     *    `logActivities`). It runs after `outcome.ok`, because that is where
     *    server-assigned ids are adopted and an activity may be re-scoped;
     *    it cannot change the action's result, and it cannot fail the write.
     *
     * Rollback rule: if no later optimistic write landed while `op` was in
     * flight (`writeSeq` still holds this write's number) and no other failed
     * write has already asked for a reload, the snapshot is restored exactly.
     * Otherwise restoring would silently discard what landed — so the whole
     * `AppState` is re-hydrated from the backend (`reloadAfterFailedWrite`,
     * which obeys the same two rules every other whole-state landing does)
     * instead of guessing at an inverse patch.
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
        /**
         * What the failure toast says after that, replacing the default
         * "Your change has been undone."
         *
         * The default is true of every write whose only trace is rows: the
         * snapshot goes back and the screen is as it was. It is NOT true of a
         * write that follows something irreversible — a document save has
         * already replaced the file's bytes in Storage, and there is no
         * version history to restore them from. Telling that user their
         * change was undone is the opposite of what happened, which is the
         * failure class this whole seam exists to remove.
         */
        undone?: string;
      }
    ): Promise<T> {
      const snapshot = stateRef.current;
      if (!snapshot) return Promise.resolve(outcome.failed);
      update(patch);
      const logged = appendedActivityIds(snapshot, stateRef.current);
      const seq = (writeSeq.current += 1);
      // Held from here until the write settles, so the apply core's `stale`
      // reload waits rather than pulling the server's state in on top of a
      // patch that is still unconfirmed. Decremented in BOTH branches, and
      // before either does any work — a reload that ran while the rollback
      // below was mid-flight would be reading a state about to be replaced.
      writeInFlight.current += 1;
      return op().then(
        (result) => {
          releaseWrite();
          const value = outcome.ok(result);
          if (logged.length === 0) return value;
          return logActivities(logged).then(() => value);
        },
        () => {
          releaseWrite();
          toast.error("Couldn't save", {
            description: `We couldn't ${outcome.describe}. ${
              outcome.undone ?? "Your change has been undone."
            }`,
          });
          // Unchanged, and it stays exactly right BECAUSE the re-hydrate
          // below now bumps `writeSeq` (QA-102): a restore can no longer land
          // on top of a reload, since any write still in flight when one
          // lands finds its number moved and takes the branch below instead.
          // Restoring is also still the honest answer when this is the only
          // thing that happened — including when the reload itself fails.
          if (writeSeq.current === seq) {
            adopt(snapshot);
            return outcome.failed;
          }
          return reloadAfterFailedWrite().then((reloaded) => {
            if (!reloaded) {
              toast.error("Out of sync", {
                description: "Reload the page to see the current workspace.",
              });
            }
            return outcome.failed;
          });
        }
      );
    }

    const switchUser: StoreValue["switchUser"] = (userId) =>
      commit(
        (s) => ({ ...s, currentUserId: userId }),
        () => backend.switchUser(userId),
        { ok: () => undefined, failed: undefined, describe: "switch user" }
      ).then(() => {
        // Signing in is the moment the workspace becomes fetchable. The
        // hydrate effect ran once on mount, when there was no session, and
        // adopted the empty shell; without this the user lands in an app with
        // no channels, no projects and no name until they reload by hand.
        // Re-uses the retry counter rather than adding a second path.
        if (refetchesOnSignIn) setHydrateAttempt((n) => n + 1);
      });

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
      if (refusesRank(s, rankOf(role), "assign")) return Promise.resolve(false);
      const targetRole = findRole(s, target.roleId);
      if (targetRole?.locked) {
        // The last holder of a LOCKED role, not of `admin` specifically —
        // the same generalisation the SQL trigger needed, so an Owner is
        // protected exactly as an Admin is.
        const peers = s.users.filter((u) => u.roleId === target.roleId);
        if (peers.length <= 1) {
          deny(`A workspace needs at least one ${targetRole.name}.`);
          return Promise.resolve(false);
        }
      }
      return commit(
        (st) => ({
          ...st,
          users: st.users.map((u) => (u.id === userId ? { ...u, roleId } : u)),
          activities: activity(st, "member", `made ${target.name} a ${role.name}`, WORKSPACE_WIDE),
        }),
        () => backend.setUserRole(userId, roleId),
        {
          ok: () => true,
          failed: false,
          describe: `make ${target.name} a ${role.name}`,
        }
      );
    };

    /**
     * The four rank rules, mirrored from SQL for a decent message.
     *
     * The database is the authority — these run first only so a refusal
     * arrives as "you can't grant a permission you don't have" instead of a
     * Postgres exception. Admin holds `members.manage`, so without these an
     * admin could create a role carrying `workspace.statuses`, hand it to a
     * colleague, and have them edit the workspace's columns: "Admin plus one
     * permission" would not be above Admin at all.
     */
    const myRank = (st: AppState): number => rankOf(actorRole(st));

    /** Rule 1: you may not put a permission on a role that you do not hold. */
    const refusesEscalation = (st: AppState, permissions: Permission[]): boolean => {
      const mine = actorRole(st);
      const beyond = permissions.filter((p) => !roleHas(mine, p));
      if (beyond.length === 0) return false;
      deny(
        `You can't grant “${PERMISSION_META[beyond[0]].label}” — your own role doesn't include it.`
      );
      return true;
    };

    /** Rules 2 and 4: you may not touch, or create, a role at or above you. */
    const refusesRank = (st: AppState, rank: number, verb: string): boolean => {
      // STRICTLY above, not "at or above". A peer-ranked role — including
      // your own — grants nobody anything they could not already have, since
      // an admin can assign the admin role itself and Rule 1 still stops them
      // putting a permission on it that they do not hold. "At or above" also
      // forbade an admin REDUCING their own role, which is a real flow that
      // tests/rls/role-writes.test.ts documents.
      if (rank <= myRank(st)) return false;
      deny(`You can't ${verb} a role above your own.`);
      return true;
    };

    const createRole: StoreValue["createRole"] = (input) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return Promise.resolve(null);
      if (refusesEscalation(s, input.permissions)) return Promise.resolve(null);
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
        rank: DEFAULT_ROLE_RANK,
      };
      return commit(
        (st) => ({
          ...st,
          roles: [...st.roles, role],
          activities: activity(st, "member", `created the ${name} role`, WORKSPACE_WIDE),
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
        deny(`The ${role.name} role is locked.`);
        return Promise.resolve(false);
      }
      if (refusesRank(s, rankOf(role), "edit")) return Promise.resolve(false);
      if (patch.permissions && refusesEscalation(s, patch.permissions)) {
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
        deny(`The ${role.name} role is locked at full access.`);
        return Promise.resolve(false);
      }
      if (refusesRank(s, rankOf(role), "edit")) return Promise.resolve(false);
      // Only granting is an escalation; taking a permission away is not.
      if (enabled && refusesEscalation(s, [permission])) {
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
            `${enabled ? "granted" : "revoked"} “${PERMISSION_META[permission].label}” ${enabled ? "to" : "for"} ${role.name}s`,
            WORKSPACE_WIDE
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
      if (refusesRank(s, rankOf(role), "delete")) return Promise.resolve(false);
      if (s.users.some((u) => u.roleId === roleId)) {
        deny("Reassign its members to another role first.");
        return Promise.resolve(false);
      }
      return commit(
        (st) => ({
          ...st,
          roles: st.roles.filter((r) => r.id !== roleId),
          activities: activity(st, "member", `deleted the ${role.name} role`, WORKSPACE_WIDE),
        }),
        () => backend.deleteRole(roleId),
        {
          ok: () => true,
          failed: false,
          describe: `delete the ${role.name} role`,
        }
      );
    };

    const inviteUser: StoreValue["inviteUser"] = async (email, roleId) => {
      const s = stateRef.current;
      if (!s || !guard("members.manage")) return "Your role can't invite people.";

      // Mirrored from the Edge Function for a decent message; the function
      // re-derives both from the caller's token, because a UI check is a
      // suggestion and this one is trivially skippable.
      const role = findRole(s, roleId);
      if (!role) return "That role doesn't exist.";
      if (rankOf(role) > rankOf(actorRole(s))) {
        return `You can't invite someone as ${role.name}.`;
      }

      try {
        await backend.inviteUser(email, roleId);
        // No optimistic patch: they are not a member until they accept. The
        // activity line is the honest record of what happened.
        updateLanded((st) => ({
          ...st,
          activities: activity(st, "member", `invited ${email}`, WORKSPACE_WIDE),
        }));
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "The invitation didn't go through.";
      }
    };

    // ------------------------------------------------------------------
    // The board's columns. Owner only.
    // ------------------------------------------------------------------

    const createStatus: StoreValue["createStatus"] = (input) => {
      const s = stateRef.current;
      if (!s || !guard("workspace.statuses")) return Promise.resolve(null);
      const name = input.name.trim();
      if (!name) {
        deny("Give the column a name first.");
        return Promise.resolve(null);
      }
      if (s.statuses.some((st) => st.name.toLowerCase() === name.toLowerCase())) {
        deny(`A column called “${name}” already exists.`);
        return Promise.resolve(null);
      }
      const status: StatusDef = {
        id: uid("s"),
        name,
        color: input.color,
        // Appended: a new column goes at the end, where the person adding it
        // can then drag it. Guessing a position would move other columns
        // nobody asked to move.
        position: Math.max(-1, ...s.statuses.map((st) => st.position)) + 1,
        isDone: false,
      };
      return commit(
        (st) => ({
          ...st,
          statuses: [...st.statuses, status],
          activities: activity(st, "member", `added the ${name} column`, WORKSPACE_WIDE),
        }),
        () => backend.createStatus(status),
        { ok: (created) => created, failed: null, describe: `add the ${name} column` }
      );
    };

    const updateStatus: StoreValue["updateStatus"] = (statusId, patch) => {
      const s = stateRef.current;
      if (!s || !guard("workspace.statuses")) return Promise.resolve(false);
      const status = s.statuses.find((st) => st.id === statusId);
      if (!status) return Promise.resolve(false);
      const nextName = patch.name?.trim();
      if (patch.name !== undefined && !nextName) {
        deny("A column needs a name.");
        return Promise.resolve(false);
      }
      if (
        nextName &&
        s.statuses.some(
          (st) => st.id !== statusId && st.name.toLowerCase() === nextName.toLowerCase()
        )
      ) {
        deny(`A column called “${nextName}” already exists.`);
        return Promise.resolve(false);
      }
      // Moving "done" is a swap, not an addition: the partial unique index
      // permits exactly one, so the old holder has to give it up in the same
      // patch. Refused here rather than letting the index reject it, because
      // the index cannot explain itself.
      if (patch.isDone === false && status.isDone) {
        deny("Mark another column as done instead — a board needs one.");
        return Promise.resolve(false);
      }
      return commit(
        (st) => ({
          ...st,
          statuses: st.statuses.map((other) =>
            other.id === statusId
              ? { ...other, ...(nextName ? { ...patch, name: nextName } : patch) }
              : // Only one column can be the done column.
                patch.isDone === true
                ? { ...other, isDone: false }
                : other
          ),
        }),
        () => backend.updateStatus(statusId, nextName ? { ...patch, name: nextName } : patch),
        { ok: () => true, failed: false, describe: `save the ${status.name} column` }
      );
    };

    const deleteStatus: StoreValue["deleteStatus"] = (statusId) => {
      const s = stateRef.current;
      if (!s || !guard("workspace.statuses")) return Promise.resolve(false);
      const status = s.statuses.find((st) => st.id === statusId);
      if (!status) return Promise.resolve(false);

      // Three refusals, all of which the database also enforces. They are
      // here so the person gets a sentence instead of a constraint error.
      const holding = s.tasks.filter((t) => t.status === statusId).length;
      if (holding > 0) {
        deny(
          `${holding} ${holding === 1 ? "task is" : "tasks are"} still in ${status.name}. Move them first.`
        );
        return Promise.resolve(false);
      }
      if (status.isDone) {
        deny("Mark another column as done before removing this one.");
        return Promise.resolve(false);
      }
      if (s.statuses.length <= 1) {
        deny("A board needs at least one column.");
        return Promise.resolve(false);
      }
      return commit(
        (st) => ({
          ...st,
          statuses: st.statuses.filter((other) => other.id !== statusId),
          activities: activity(
            st, "member", `removed the ${status.name} column`, WORKSPACE_WIDE
          ),
        }),
        () => backend.deleteStatus(statusId),
        { ok: () => true, failed: false, describe: `remove the ${status.name} column` }
      );
    };

    const reorderStatuses: StoreValue["reorderStatuses"] = (orderedIds) => {
      const s = stateRef.current;
      if (!s || !guard("workspace.statuses")) return Promise.resolve(false);
      const order = orderedIds.map((id, position) => ({ id, position }));
      return commit(
        (st) => ({
          ...st,
          statuses: st.statuses.map((status) => {
            const at = orderedIds.indexOf(status.id);
            return at === -1 ? status : { ...status, position: at };
          }),
        }),
        () => backend.reorderStatuses(order),
        { ok: () => true, failed: false, describe: "reorder the columns" }
      );
    };

    const resetDemo: StoreValue["resetDemo"] = () =>
      backend.reset().then(
        (fresh) => {
          // A whole-state landing like any other (QA-114): a write in flight
          // when the demo is reset must, on failure, re-hydrate rather than
          // restore its pre-reset snapshot over the fresh workspace.
          adoptLanded(fresh);
        },
        () => {
          // This branch did not exist, so a failing reset became an unhandled
          // rejection caught only by the generic net in providers.tsx — which
          // says "That last action didn't go through" and names nothing. It
          // was unreachable from a test too, because `reset` was the one
          // `Backend` method with no `FailingOp` entry; both are fixed
          // together, since a handler nobody can drive is how the first one
          // went missing.
          toast.error("Couldn't reset", {
            description: "The demo workspace is unchanged. Try again.",
          });
        }
      );

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
      activities: note ? activity(st, "message", note, { conversationId: message.channelId }) : st.activities,
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

    /**
     * A DM's id belongs to the server.
     *
     * `sendToUser` and `openDm` both create the thread optimistically with a
     * client-side `uid("d")` so the conversation is on screen at once, but the
     * row that actually exists is the one `find_or_create_dm` returns — the
     * same RPC that makes two tabs racing on the same pair impossible. When
     * the two ids differ (always, for a genuinely new thread) the optimistic
     * one has to be renamed everywhere it was written, or the caller navigates
     * to `row.id` and finds a conversation the store does not have.
     *
     * A no-op on `LocalBackend`, which hands back the id it was given.
     */
    const adoptDmId = (optimisticId: string, row: DM) => {
      if (row.id === optimisticId) return;
      // `updateLanded`: this renames a conversation everywhere it was
      // written, so a concurrent write's rollback restoring a snapshot taken
      // before it would resurrect the optimistic id the server never had.
      updateLanded((st) => {
        const oldKey = `${st.currentUserId}:${optimisticId}`;
        const { [oldKey]: readAt, ...lastRead } = st.lastRead;
        return {
          ...st,
          dms: st.dms.map((d) => (d.id === optimisticId ? row : d)),
          messages: st.messages.map((m) =>
            m.channelId === optimisticId ? { ...m, channelId: row.id } : m
          ),
          activities: st.activities.map((a) =>
            a.conversationId === optimisticId ? { ...a, conversationId: row.id } : a
          ),
          lastRead:
            readAt === undefined
              ? lastRead
              : { ...lastRead, [`${st.currentUserId}:${row.id}`]: readAt },
        };
      });
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
        {
          ok: (row) => {
            adoptDmId(dm.id, row);
            return row;
          },
          failed: null,
          describe: "send your message",
        }
      );
    };

    const editMessage: StoreValue["editMessage"] = (messageId, content) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve(false);
      const message = s.messages.find((m) => m.id === messageId);
      if (!message || message.authorId !== s.currentUserId) {
        deny("You can only edit your own messages.");
        return Promise.resolve(false);
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
        { ok: () => true, failed: false, describe: "edit that message" }
      );
    };

    const deleteMessage: StoreValue["deleteMessage"] = (messageId) => {
      const s = stateRef.current;
      if (!s) return Promise.resolve(false);
      const message = s.messages.find((m) => m.id === messageId);
      if (!message) return Promise.resolve(false);
      if (message.authorId !== s.currentUserId && !guard("message.deleteAny")) {
        return Promise.resolve(false);
      }
      return commit(
        (st) => ({
          ...st,
          messages: st.messages.filter((m) => m.id !== messageId),
        }),
        () => backend.deleteMessage(messageId),
        { ok: () => true, failed: false, describe: "delete that message" }
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
          activities: activity(st, "channel", `created #${input.name}`, { conversationId: channel.id }),
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
          activities: activity(st, "channel", `updated access for #${channel.name}`, {
            conversationId: channelId,
          }),
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
      if (!s) return Promise.resolve(false);
      const channel = s.channels.find((c) => c.id === channelId);
      if (!channel) return Promise.resolve(false);
      if (channel.isTeam) {
        deny("The team channel can't be deleted.");
        return Promise.resolve(false);
      }
      if (channel.createdBy !== s.currentUserId && !guard("channel.delete")) {
        return Promise.resolve(false);
      }
      return commit(
        (st) => ({
          ...st,
          channels: st.channels.filter((c) => c.id !== channelId),
          messages: st.messages.filter((m) => m.channelId !== channelId),
          activities: activity(st, "channel", `deleted #${channel.name}`, { conversationId: channelId }),
        }),
        () => backend.deleteChannel(channelId),
        { ok: () => true, failed: false, describe: `delete #${channel.name}` }
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
        {
          ok: (row) => {
            adoptDmId(dm.id, row);
            return row;
          },
          failed: null,
          describe: "open that conversation",
        }
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
          activities: activity(st, "project", `created the ${input.name} project`, {
            projectId: project.id,
          }),
        }),
        () => backend.createProject(project),
        {
          ok: (created) => created,
          failed: null,
          describe: `create the ${input.name} project`,
        }
      );
    };

    const updateProject: StoreValue["updateProject"] = (projectId, patch, opts) => {
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
            // `withoutRemovals`: the removal list is an instruction to the
            // backend, not a column, and must not be spread into state.
            p.id === projectId ? { ...p, ...withoutRemovals(patch) } : p
          ),
          activities: renamed
            ? activity(
                s,
                "project",
                `renamed “${prev.name}” to “${patch.name}”`,
                { projectId }
              )
            : attachmentNote
              ? activity(s, "project", attachmentNote, { projectId })
              : s.activities,
        };
        },
        () => backend.updateProject(projectId, patch),
        {
          ok: () => true,
          failed: false,
          describe: `save ${target ? `“${target.name}”` : "this project"}`,
          undone: opts?.undone,
        }
      );
    };

    const deleteProject: StoreValue["deleteProject"] = (projectId) => {
      if (!guard("project.delete")) return Promise.resolve(false);
      const s = stateRef.current;
      const project = s?.projects.find((p) => p.id === projectId);
      if (!s || !project) return Promise.resolve(false);
      return commit(
        (st) => ({
          ...st,
          projects: st.projects.filter((p) => p.id !== projectId),
          tasks: st.tasks.filter((t) => t.projectId !== projectId),
          activities: activity(st, "project", `deleted the ${project.name} project`, {
            projectId,
          }),
        }),
        () => backend.deleteProject(projectId),
        {
          ok: () => true,
          failed: false,
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
          activities: activity(st, "project", `updated access for ${project.name}`, { projectId }),
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
      // The card has to render somewhere before the server answers, and the
      // end of its column is where it will land — so this is the optimistic
      // placeholder, NOT the value that gets written. The backend sends no
      // position at all: a `before insert` trigger appends the row
      // (20260908000800_store_swap.sql), because two people adding a card to
      // the same column both counted the same length here and both claimed it.
      // Whatever the server chose is adopted in `ok` below.
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
          activities: activity(s, "task", `created “${input.title}”`, { projectId: task.projectId }),
        }),
        () => backend.createTask(task),
        {
          ok: (created) => {
            // `ok` is the seam a real backend hands server-assigned values back
            // through. `LocalBackend` returns the task unchanged, so this is a
            // no-op there; against Postgres it replaces the guess above with
            // the position the trigger picked, which is what a reload will
            // show. Matched by id, so a task deleted while the write was in
            // flight is simply not found.
            if (created.order !== task.order) {
              // `updateLanded`: the server's position, not a guess — a
              // concurrent write's rollback must not put the guess back.
              updateLanded((s) => ({
                ...s,
                tasks: s.tasks.map((t) =>
                  t.id === created.id ? { ...t, order: created.order } : t
                ),
              }));
            }
            return created;
          },
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
          // The done column, whatever it is called — this used to test the
          // literal "done", so a renamed column silently stopped producing
          // the feed's "completed" line.
          const completed =
            patch.status !== undefined &&
            isDoneStatus(s.statuses, patch.status) &&
            !isDoneStatus(s.statuses, prev.status);
          // Same as `updateProject`: the removal list is an instruction to
          // the backend, not a field of the Task.
          const next: Task = { ...prev, ...withoutRemovals(resolved) };
          const assignmentTexts = assignmentActivityTexts(s, prev, next);
          let activities = completed
            ? activity(s, "task", `completed “${prev.title}”`, { projectId: next.projectId })
            : s.activities;
          for (const text of assignmentTexts) {
            activities = activity({ ...s, activities }, "task", text, { projectId: next.projectId });
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
      if (!guard("task.move")) return Promise.resolve(false);
      const s0 = stateRef.current;
      const task0 = s0?.tasks.find((t) => t.id === taskId);
      const project0 = task0 && s0?.projects.find((p) => p.id === task0.projectId);
      if (s0 && project0 && projectIsViewerOnly(s0, project0)) {
        deny("You have view-only access to this project.");
        return Promise.resolve(false);
      }
      if (!s0 || !task0) return Promise.resolve(false);
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
        const completed =
          isDoneStatus(s0.statuses, toStatus) && !isDoneStatus(s0.statuses, task0.status);
        return {
          ...s,
          tasks: s.tasks.map((t) => reordered.get(t.id) ?? t),
          activities: completed
            ? activity(s, "task", `completed “${task.title}”`, { projectId: task.projectId })
            : s.activities,
        };
        },
        () => backend.moveTask(taskId, toStatus, toIndex),
        { ok: () => true, failed: false, describe: `move “${task0.title}”` }
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
            activities: activity(s, "task", `deleted “${task.title}”`, { projectId: task.projectId }),
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
      inviteUser,
      createStatus,
      updateStatus,
      deleteStatus,
      reorderStatuses,
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
  }, [update, adopt, updateLanded, adoptLanded, releaseWrite, reloadAfterFailedWrite, backend]);

  if (!state) {
    // Failure, not a slow load: say so, and give the user something to press.
    // A blank page or an endless spinner would leave them guessing, and a
    // silent seed would be a lie about whose workspace they are looking at.
    if (hydrateFailed) {
      return (
        <div className="flex h-svh items-center justify-center bg-background p-6">
          <div
            role="alert"
            className="flex max-w-sm flex-col items-center gap-3 text-center"
          >
            <div className="flex size-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
                <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z" />
              </svg>
            </div>
            <h1 className="text-sm font-medium">We couldn&rsquo;t load your workspace</h1>
            <p className="text-xs text-muted-foreground">
              Lumina reached the server but didn&rsquo;t get your data back. This is
              usually a connection problem. Nothing has been lost.
            </p>
            <button
              type="button"
              onClick={() => {
                setHydrateFailed(false);
                setHydrateAttempt((n) => n + 1);
              }}
              className="mt-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
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
        // The browser's `offline` is authoritative in one direction only —
        // see `browserOffline`. A socket cannot be "receiving" through an
        // interface the browser says is down.
        connected: connected && !browserOffline,
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
