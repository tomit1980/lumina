import { DEFAULT_ROLES } from "@/lib/permissions";
import { serviceClient } from "./supabase";

export const TEST_ROLE_IDS = { admin: "admin", member: "member", guest: "guest" } as const;

/** Idempotent: rows derived from DEFAULT_ROLES to prevent drift between fixtures and app model. */
export async function seedRoles(): Promise<void> {
  const { error } = await serviceClient.from("roles").upsert(
    DEFAULT_ROLES.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      color: role.color,
      permissions: [...role.permissions],
      is_system: role.isSystem ?? false,
      locked: role.locked ?? false,
    }))
  );
  if (error) throw new Error(`seedRoles failed: ${error.message}`);
}
