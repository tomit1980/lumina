/**
 * `LocalBackend` — the browser-only backend the public demo runs on, and the
 * default until the Phase 3 cutover.
 *
 * It holds the whole workspace as one JSON blob in localStorage, so its
 * per-action methods have nothing of their own to do: the write happens in
 * `persist()`, which the store calls after every state change. That is why
 * every operation here resolves immediately — it is a fast path, not a stub.
 *
 * The hydrate effect, the persist effect and `migrate()` moved here from
 * `lib/store.tsx` unchanged in behaviour, including the edge-triggered quota
 * toast (see `persist`).
 */
import { toast } from "sonner";

import { DEFAULT_ROLES } from "../permissions";
import { DEFAULT_STATUSES } from "../statuses";
import { createSeed, SEED_VERSION } from "../seed";
import type {
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
  User,
} from "../types";
import type {
  AttachmentOwner,
  Backend,
  RealtimeEvent,
  Unsubscribe,
} from "./types";

export const STORAGE_KEY = "lumina:v1";

/** Legacy (pre-v4) persisted shapes we migrate from. */
interface LegacyState
  extends Omit<
    AppState,
    "roles" | "statuses" | "users" | "projects" | "tasks" | "channels" | "messages"
  > {
  messages: Array<Omit<Message, "attachments"> & { attachments?: MessageAttachment[] }>;
  users: Array<Omit<User, "roleId"> & { roleId?: string; role?: string }>;
  roles?: RoleDef[];
  rolePermissions?: Record<string, Permission[]>;
  /** Absent in every workspace stored before SEED_VERSION 14, when the board's
   *  columns were a hardcoded union rather than rows. */
  statuses?: StatusDef[];
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

export function migrate(parsed: LegacyState, parsedVersion: number): AppState {
  // A workspace stored before statuses were editable has none, and its tasks
  // carry the five seeded ids — which is exactly what `DEFAULT_STATUSES`
  // still defines, ids included. So the backfill is the seed, and every
  // existing task keeps resolving without being rewritten.
  const statuses: StatusDef[] =
    parsed.statuses ?? DEFAULT_STATUSES.map((s) => ({ ...s }));
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
      const migrated = { ...rest, roleId: u.roleId ?? role ?? "member" };
      // The seeded admin was renamed (Vlad Plaskov -> Moshe Cohen, handle
      // `vlad` -> `moshe`). Renaming the seed alone only reaches a *fresh*
      // workspace: anyone who had already used the demo kept the old name,
      // and saw it in the sidebar and greeting while the login screen offered
      // the new one. Matched on the seeded id *and* the old name so a
      // workspace that has already been migrated is untouched, and nothing
      // else is ever renamed.
      if (migrated.id === "u_vlad" && migrated.name === "Vlad Plaskov") {
        return { ...migrated, name: "Moshe Cohen", handle: "moshe" };
      }
      return migrated;
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
    // Activity scope is new — rows written before it exist named their project
    // or channel only inside free text, and there is no way to recover which
    // one after the fact. They become workspace-wide (both columns null),
    // which is the honest answer: an unscoped row is exactly a row whose
    // subject is unknown. Same shape as collaboratorIds above, except that
    // null rather than [] is the empty value here, so `?? null` normalises a
    // missing key instead of leaving it undefined.
    activities: (parsed.activities ?? []).map((a) => ({
      ...a,
      projectId: a.projectId ?? null,
      conversationId: a.conversationId ?? null,
    })),
    roles,
    statuses,
    lastRead: parsed.lastRead ?? {},
  };
}

/** Reads and migrates the persisted workspace, falling back to a fresh seed.
 *
 *  `fromFuture` says the stored workspace was written by a **newer** build
 *  than this one, which is the one case where falling back to a seed is not
 *  the end of the story — see `LocalBackend.persist`. */
function readPersisted(): { state: AppState; fromFuture: boolean } {
  let next: AppState | null = null;
  let fromFuture = false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LegacyState;
      if (typeof parsed?.version === "number" && parsed.version >= 1) {
        if (parsed.version <= SEED_VERSION) {
          next = migrate(parsed, parsed.version);
        } else {
          // Written by a build newer than this one: a stale cached bundle, a
          // tab open across a deploy, or a rollback. `migrate` only knows how
          // to move forward, so this state cannot be read safely — but it is
          // still the user's only copy of their work.
          fromFuture = true;
        }
      }
    }
  } catch {
    // Corrupt storage → fall through to a fresh seed.
  }
  return { state: next ?? createSeed(), fromFuture };
}

export class LocalBackend implements Backend {
  /** Edge-triggered: only warn on the transition into failure, so a large
   *  attachment doesn't re-toast on every unrelated state change afterward.
   *  Was a `React.useRef` in the provider; one instance per provider keeps
   *  that per-mount lifetime exactly. */
  private lastPersistOk = true;

  /**
   * The stored workspace was written by a newer build than this one, so this
   * build must not write over it.
   *
   * Until this existed, a stored `version` above `SEED_VERSION` silently
   * produced a fresh seed — and the very next change persisted that seed on
   * top of the newer workspace, destroying it for good. Confirmed in a
   * browser against the static build, with a control: a plain reload kept a
   * marker message (29 messages), and a reload with the stored version one
   * ahead lost it (28 messages, marker gone, stored version rewritten to
   * this build's) with nothing shown to the user.
   *
   * Refusing to write is what turns that from permanent loss into a wait: the
   * bytes stay on disk, and the build that understands them gets them back.
   */
  private storedIsNewer = false;

  hydrate(): Promise<AppState> {
    const read = readPersisted();
    this.storedIsNewer = read.fromFuture;
    // Deliberately NOT toasting here. `hydrate()` resolves before anything has
    // rendered, and a toast raised at that point is dropped on the floor — I
    // shipped that version first and watched it appear nowhere. The message
    // belongs where the refusal actually bites, in `persist` below, which is
    // also the moment it matters to the user.
    return Promise.resolve(read.state);
  }

  reset(): Promise<AppState> {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
    // The user asked for this one, so there is nothing left to protect and
    // saving is safe again.
    this.storedIsNewer = false;
    return Promise.resolve(createSeed());
  }

  /**
   * The demo workspace is the only writer of itself. Nothing to hear, so the
   * listener is never called and the teardown has nothing to tear down.
   *
   * The parameter is declared even though it is ignored: subclasses override
   * this to become real emitters (`EventBackend` in tests/qa/_support.ts, and
   * `FailingBackend` through it), and a base signature taking no argument
   * would make every one of those overrides a type error.
   */
  subscribe(_onEvent: (event: RealtimeEvent) => void): Unsubscribe {
    return () => {};
  }

  persist(state: AppState): void {
    // Never over a workspace this build cannot read: see `storedIsNewer`.
    // Edge-triggered like the quota message below, so the user is told the
    // first time a change of theirs is not being kept and not on every
    // keystroke afterwards.
    if (this.storedIsNewer) {
      if (this.lastPersistOk) {
        toast.error("Your changes aren't being saved", {
          description:
            "This browser holds a workspace made by a newer version of Lumina, and this version can't read it. It has been left untouched — reload once you have the latest version to get it back.",
          duration: 12_000,
        });
      }
      this.lastPersistOk = false;
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      this.lastPersistOk = true;
    } catch {
      if (this.lastPersistOk) {
        toast.error("Couldn't save — local storage is full", {
          description: "Your last change only exists for this tab. Try removing a large attachment.",
        });
      }
      this.lastPersistOk = false;
    }
  }

  // Everything below is a no-op that resolves immediately: the workspace is
  // written whole by `persist` above. A method that ignores its arguments
  // declares none — TypeScript still matches it against the `Backend`
  // signature, and `lib/backend/types.ts` remains the single place the
  // contract's parameters are named and documented. `SupabaseBackend` is
  // where they start doing work.

  /** Like every other operation here, nothing of its own to do: the entry is
   *  already in the `AppState` that `persist` writes as one blob. Local
   *  behaviour is therefore exactly what it was before the seam grew this
   *  method — the demo's feed still survives a reload. */
  putActivity(): Promise<void> {
    return Promise.resolve();
  }

  switchUser(): Promise<void> {
    return Promise.resolve();
  }

  setUserRole(): Promise<void> {
    return Promise.resolve();
  }

  createRole(role: RoleDef): Promise<RoleDef> {
    return Promise.resolve(role);
  }

  updateRole(): Promise<void> {
    return Promise.resolve();
  }

  setRolePermission(): Promise<void> {
    return Promise.resolve();
  }

  deleteRole(): Promise<void> {
    return Promise.resolve();
  }

  sendMessage(message: Message): Promise<Message> {
    return Promise.resolve(message);
  }

  sendToUser(dm: DM): Promise<DM> {
    return Promise.resolve(dm);
  }

  editMessage(): Promise<void> {
    return Promise.resolve();
  }

  deleteMessage(): Promise<void> {
    return Promise.resolve();
  }

  toggleReaction(): Promise<void> {
    return Promise.resolve();
  }

  markChannelRead(): Promise<void> {
    return Promise.resolve();
  }

  createChannel(channel: Channel): Promise<Channel> {
    return Promise.resolve(channel);
  }

  deleteChannel(): Promise<void> {
    return Promise.resolve();
  }

  setChannelAccess(): Promise<void> {
    return Promise.resolve();
  }

  openDm(dm: DM): Promise<DM> {
    return Promise.resolve(dm);
  }

  createProject(project: Project): Promise<Project> {
    return Promise.resolve(project);
  }

  updateProject(): Promise<void> {
    return Promise.resolve();
  }

  deleteProject(): Promise<void> {
    return Promise.resolve();
  }

  setProjectAccess(): Promise<void> {
    return Promise.resolve();
  }

  createTask(task: Task): Promise<Task> {
    return Promise.resolve(task);
  }

  updateTask(): Promise<void> {
    return Promise.resolve();
  }

  moveTask(): Promise<void> {
    return Promise.resolve();
  }

  deleteTask(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * The demo's file store: a base64 `data:` URL, read straight off the File
   * and handed back to be kept inline in the one JSON blob `persist` writes.
   * This is the whole of the local path's storage, by design — the public
   * site has no server to put bytes on.
   *
   * Moved here from `readFileAsAttachment` unchanged, `reader.onerror`
   * included, when Task 10 gave that helper a second backend to serve. The
   * bytes still never leave the browser and the workspace is still one
   * localStorage key, so the demo behaves exactly as it did.
   */
  putAttachment(_owner: AttachmentOwner, _attachment: Attachment, file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("couldn't be read"));
      reader.readAsDataURL(file);
    });
  }

  /** Saving is the same operation as uploading here — the new bytes replace
   *  the old `data:` URL in the blob `persist` writes. */
  saveAttachment(
    attachment: Attachment,
    file: Blob,
    editedBy: string,
    editedAt: number
  ): Promise<string> {
    // `editedBy`/`editedAt` are stamped onto the `Attachment` the store
    // patches, and `persist` writes that. There is no separate row here to
    // carry them, unlike `SupabaseBackend`, which updates `attachments`.
    // Named rather than dropped because the seam's parameters are declared in
    // lib/backend/types.ts and a subclass has to be able to override this.
    void editedBy;
    void editedAt;
    return this.putAttachment("project", attachment, file);
  }

  /** Nothing to undo: the bytes were never written anywhere of their own.
   *  Dropping the `Attachment` from `AppState` is the whole deletion, and
   *  `persist` has already been asked to write the result. */
  deleteAttachment(attachment: Attachment): Promise<void> {
    void attachment;
    return Promise.resolve();
  }

  /** The `data:` URL is already a URL, and already the bytes. Both of these
   *  are the identity function on this backend, which is why the demo does no
   *  work it did not do before Storage existed. */
  attachmentUrl(ref: string): Promise<string> {
    return Promise.resolve(ref);
  }

  readAttachment(ref: string): Promise<string> {
    return Promise.resolve(ref);
  }
}
