import type {
  AccessLevel,
  Message,
  Permission,
  ResourceMember,
  RoleDef,
  Task,
  User,
} from "./types";

export type { Permission } from "./types";

export const ALL_PERMISSIONS: Permission[] = [
  "message.send",
  "channel.create",
  "channel.delete",
  "message.deleteAny",
  "task.create",
  "task.edit",
  "task.move",
  "task.delete",
  "project.create",
  "project.delete",
  "members.manage",
  // The Owner's one extra power: editing the board's columns for the whole
  // workspace. Deliberately its own permission rather than folded into
  // members.manage, because the boundary between Admin and Owner is exactly
  // this line.
  "workspace.statuses",
];

/**
 * Seeded system roles, highest rank first.
 *
 * `rank` is what "above" means, and it is load-bearing rather than
 * decorative. Admin holds `members.manage`, which lets it create a role
 * carrying any permission and assign it to a colleague — so two admins could
 * promote each other to anything, and a role defined merely as "Admin plus
 * one more permission" would not be above Admin at all. The rules keyed on
 * rank (in SQL, mirrored here) are what make Owner a boundary: you cannot
 * grant a permission you do not hold, edit or delete a role at or above your
 * own rank, assign one, or create one.
 *
 * Owner and Admin are both `locked` — always full access for their own
 * permission set, never editable — which is also what makes the last-holder
 * protection cover them both without naming either.
 */
export const DEFAULT_ROLES: RoleDef[] = [
  {
    id: "owner",
    name: "Owner",
    description:
      "Everything an admin can do, plus the workspace's board columns.",
    color: "#f43f5e",
    permissions: [...ALL_PERMISSIONS],
    isSystem: true,
    locked: true,
    rank: 100,
  },
  {
    id: "admin",
    name: "Admin",
    description: "Full access — manage members, roles, and permissions.",
    color: "#8b5cf6",
    // Everything EXCEPT workspace.statuses. `has_permission()` in SQL reads
    // this array and does not honour `locked`, so an Admin holding the
    // status permission here would be able to edit statuses server-side no
    // matter what the client says.
    permissions: ALL_PERMISSIONS.filter((p) => p !== "workspace.statuses"),
    isSystem: true,
    locked: true,
    rank: 80,
  },
  {
    id: "member",
    name: "Member",
    description: "Day-to-day access: chat, create channels, and work with tasks.",
    color: "#0ea5e9",
    permissions: [
      "message.send",
      "channel.create",
      "task.create",
      "task.edit",
      "task.move",
    ],
    isSystem: true,
    rank: 40,
  },
  {
    id: "guest",
    name: "Guest",
    description: "Chat in public channels. Boards are view-only.",
    color: "#71717a",
    permissions: ["message.send"],
    isSystem: true,
    rank: 20,
  },
];

/** Where a role someone creates sits by default: below Admin, above Member,
 *  so an admin can build a useful role without being able to mint a peer.
 *  Rule 4 refuses anything at or above the creator's own rank anyway. */
export const DEFAULT_ROLE_RANK = 50;

export const ROLE_COLORS = [
  "#8b5cf6",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#6366f1",
  "#71717a",
];

export type PermissionGroup = "Chat" | "Tasks & projects" | "Administration";

export const PERMISSION_META: Record<
  Permission,
  { label: string; group: PermissionGroup }
> = {
  "message.send": { label: "Post in channels", group: "Chat" },
  "channel.create": { label: "Create channels", group: "Chat" },
  "channel.delete": { label: "Delete channels", group: "Chat" },
  "message.deleteAny": { label: "Delete anyone's messages", group: "Chat" },
  "task.create": { label: "Create tasks", group: "Tasks & projects" },
  "task.edit": { label: "Edit tasks", group: "Tasks & projects" },
  "task.move": { label: "Move tasks on the board", group: "Tasks & projects" },
  "task.delete": { label: "Delete tasks", group: "Tasks & projects" },
  "project.create": { label: "Create projects", group: "Tasks & projects" },
  "project.delete": { label: "Delete projects", group: "Tasks & projects" },
  "members.manage": {
    label: "Manage members & permissions",
    group: "Administration",
  },
  "workspace.statuses": {
    label: "Edit the board's columns",
    group: "Administration",
  },
};

export const PERMISSION_GROUPS: PermissionGroup[] = [
  "Chat",
  "Tasks & projects",
  "Administration",
];

/**
 * Pure check against a role definition.
 *
 * A locked role passes anything IN ITS OWN permission array — not anything at
 * all, which is what this used to do. That distinction is the whole Owner
 * boundary: Admin is locked and does not hold `workspace.statuses`, so a
 * blanket `locked -> true` would have handed every admin the one power the
 * rank rules exist to withhold, and the client would have disagreed with
 * `has_permission()` in SQL, which reads the array and has never honoured
 * `locked`.
 *
 * Locked still means "cannot be edited"; it no longer means "may do
 * everything".
 */
export function roleHas(role: RoleDef | undefined, permission: Permission): boolean {
  if (!role) return false;
  return role.permissions.includes(permission);
}

/** Higher outranks lower. Unranked roles sit at the default, so a workspace
 *  stored before ranks existed behaves sensibly rather than as rank 0. */
export function rankOf(role: RoleDef | undefined): number {
  return role?.rank ?? DEFAULT_ROLE_RANK;
}

/** You can always edit your own messages. */
export function canEditMessage(user: User, message: Message): boolean {
  return message.authorId === user.id;
}

/** The subset of Task fields "mine"-style checks need — lets callers pass a
 *  partial/seed task without pulling in the full Task shape. */
type TaskAssignment = Pick<Task, "assigneeId" | "collaboratorIds" | "createdBy">;

/** True when this user owns the task (is its assignee) or is one of its
 *  collaborators. Does not treat an unassigned task as anyone's — see
 *  `isMineOrUnclaimed` for the "unassigned task I created" fallback used by
 *  the schedule/calendar export and the reminder gate. */
export function isMine(task: TaskAssignment, userId: string): boolean {
  return task.assigneeId === userId || task.collaboratorIds.includes(userId);
}

/** `isMine`, plus an unassigned task this user created — the fallback the
 *  home schedule export and reminder toasts use so a task nobody has
 *  claimed yet still surfaces for its creator. */
export function isMineOrUnclaimed(task: TaskAssignment, userId: string): boolean {
  return (
    isMine(task, userId) || (task.assigneeId == null && task.createdBy === userId)
  );
}

/** This person's explicit access level on a resource's member list, if any. */
export function resourceMemberLevel(
  members: ResourceMember[],
  userId: string
): AccessLevel | null {
  return members.find((m) => m.userId === userId)?.level ?? null;
}
