import type {
  AccessLevel,
  Message,
  Permission,
  ResourceMember,
  RoleDef,
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
];

/** Seeded system roles. Admin is locked (always full access, not editable);
 *  member and guest are editable starting points. Admins can add custom roles. */
export const DEFAULT_ROLES: RoleDef[] = [
  {
    id: "admin",
    name: "Admin",
    description: "Full access — manage members, roles, and permissions.",
    color: "#8b5cf6",
    permissions: [...ALL_PERMISSIONS],
    isSystem: true,
    locked: true,
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
  },
  {
    id: "guest",
    name: "Guest",
    description: "Chat in public channels. Boards are view-only.",
    color: "#71717a",
    permissions: ["message.send"],
    isSystem: true,
  },
];

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
};

export const PERMISSION_GROUPS: PermissionGroup[] = [
  "Chat",
  "Tasks & projects",
  "Administration",
];

/** Pure check against a role definition. Locked roles always pass. */
export function roleHas(role: RoleDef | undefined, permission: Permission): boolean {
  if (!role) return false;
  return !!role.locked || role.permissions.includes(permission);
}

/** You can always edit your own messages. */
export function canEditMessage(user: User, message: Message): boolean {
  return message.authorId === user.id;
}

/** This person's explicit access level on a resource's member list, if any. */
export function resourceMemberLevel(
  members: ResourceMember[],
  userId: string
): AccessLevel | null {
  return members.find((m) => m.userId === userId)?.level ?? null;
}
