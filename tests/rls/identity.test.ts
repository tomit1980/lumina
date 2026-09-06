import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient, createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  admin: `admin-${stamp}@lumina.test`,
  member: `member-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `ada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo Member", handle: `mo${stamp}`, roleId: "member",
  });
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("identity RLS", () => {
  it("denies a signed-out client any profile", async () => {
    const { data, error } = await anonClient().from("profiles").select("id");
    expect(error ?? data).toBeTruthy();
    expect(data ?? []).toHaveLength(0);
  });

  it("lets a signed-in member read the directory", async () => {
    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { data, error } = await client.from("profiles").select("id,name");
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("denies a member editing another member's profile", async () => {
    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { error } = await client
      .from("profiles").update({ title: "Hacked" }).eq("id", ids.admin).select();
    const { data: after } = await serviceClient
      .from("profiles").select("title").eq("id", ids.admin).single();
    expect(after?.title).not.toBe("Hacked");
    expect(error === null && after?.title === "Hacked").toBe(false);
  });

  it("lets a member edit their own title", async () => {
    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { error } = await client
      .from("profiles").update({ title: "Designer" }).eq("id", ids.member);
    expect(error).toBeNull();
    const { data } = await serviceClient
      .from("profiles").select("title").eq("id", ids.member).single();
    expect(data?.title).toBe("Designer");
  });

  it("denies a member creating a role", async () => {
    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { error } = await client.from("roles").insert({
      id: `r_${stamp}`, name: "Sneaky", description: "", color: "#000", permissions: [],
    });
    expect(error).not.toBeNull();
  });

  it("lets an admin create a role", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const roleId = `r_ok_${stamp}`;
    const { error } = await client.from("roles").insert({
      id: roleId, name: "Reviewer", description: "", color: "#000", permissions: ["task.edit"],
    });
    expect(error).toBeNull();
    await serviceClient.from("roles").delete().eq("id", roleId);
  });

  it("blocks anyone from changing their own role, admin included", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await client
      .from("profiles").update({ role_id: "guest" }).eq("id", ids.admin);
    expect(error).not.toBeNull();
    const { data } = await serviceClient
      .from("profiles").select("role_id").eq("id", ids.admin).single();
    expect(data?.role_id).toBe("admin");
  });
});
