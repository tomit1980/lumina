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

/** Creates the conversations row and its channel row together. */
export async function createChannel(opts: {
  id: string;
  name: string;
  isPrivate: boolean;
  createdBy: string;
}): Promise<void> {
  const conv = await serviceClient
    .from("conversations").insert({ id: opts.id, kind: "channel" });
  if (conv.error) throw new Error(`createChannel conversation failed: ${conv.error.message}`);

  const channel = await serviceClient.from("channels").insert({
    id: opts.id,
    name: opts.name,
    description: "",
    is_private: opts.isPrivate,
    is_team: false,
    created_by: opts.createdBy,
  });
  if (channel.error) throw new Error(`createChannel failed: ${channel.error.message}`);
}

export async function addChannelMember(
  channelId: string,
  userId: string,
  level: "viewer" | "editor"
): Promise<void> {
  const { error } = await serviceClient
    .from("channel_members").insert({ channel_id: channelId, user_id: userId, level });
  if (error) throw new Error(`addChannelMember failed: ${error.message}`);
}

export async function createProject(opts: {
  id: string;
  name: string;
  restricted: boolean;
  createdBy: string;
}): Promise<void> {
  const { error } = await serviceClient.from("projects").insert({
    id: opts.id,
    name: opts.name,
    description: "",
    emoji: "🎨",
    color: "#7c3aed",
    priority: "medium",
    restricted: opts.restricted,
    created_by: opts.createdBy,
  });
  if (error) throw new Error(`createProject failed: ${error.message}`);
}

export async function addProjectMember(
  projectId: string,
  userId: string,
  level: "viewer" | "editor"
): Promise<void> {
  const { error } = await serviceClient
    .from("project_members").insert({ project_id: projectId, user_id: userId, level });
  if (error) throw new Error(`addProjectMember failed: ${error.message}`);
}

/**
 * Seeds a collaborator row. Bypasses RLS like every helper here, but NOT the
 * task_collaborators_check_insert trigger (triggers fire for the service role
 * too), so a fixture that violates the owner/visibility invariants throws
 * rather than silently creating an impossible row.
 */
export async function addTaskCollaborator(
  taskId: string,
  userId: string
): Promise<void> {
  const { error } = await serviceClient
    .from("task_collaborators").insert({ task_id: taskId, user_id: userId });
  if (error) throw new Error(`addTaskCollaborator failed: ${error.message}`);
}
