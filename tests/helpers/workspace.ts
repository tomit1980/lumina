import { serviceClient } from "./supabase";

export const TEST_ROLE_IDS = { admin: "admin", member: "member", guest: "guest" } as const;

/** Idempotent: mirrors DEFAULT_ROLES from lib/permissions.ts. */
export async function seedRoles(): Promise<void> {
  const { error } = await serviceClient.from("roles").upsert([
    {
      id: "admin",
      name: "Admin",
      description: "Full access to everything",
      color: "#7c3aed",
      permissions: [
        "channel.create", "channel.delete", "project.create", "project.delete",
        "task.create", "task.edit", "task.move", "task.delete",
        "message.send", "message.deleteAny", "members.manage",
      ],
      is_system: true,
      locked: true,
    },
    {
      id: "member",
      name: "Member",
      description: "Can create and edit work",
      color: "#0ea5e9",
      permissions: [
        "channel.create", "project.create", "task.create", "task.edit",
        "task.move", "message.send",
      ],
      is_system: true,
      locked: false,
    },
    {
      id: "guest",
      name: "Guest",
      description: "Read-mostly access",
      color: "#64748b",
      permissions: ["message.send"],
      is_system: true,
      locked: false,
    },
  ]);
  if (error) throw new Error(`seedRoles failed: ${error.message}`);
}
