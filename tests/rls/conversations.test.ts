import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addChannelMember, createChannel, seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const publicChannel = `c_pub_${stamp}`;
const privateChannel = `c_priv_${stamp}`;
const forgeChannel = `c_forge_${stamp}`;
const dmId = `d_pair_${stamp}`;
const emails = {
  admin: `cadmin-${stamp}@lumina.test`,
  insider: `cin-${stamp}@lumina.test`,
  outsider: `cout-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada", handle: `cada${stamp}`, roleId: "admin",
  });
  ids.insider = await createTestUser({
    email: emails.insider, password: TEST_PASSWORD,
    name: "Ivy", handle: `civy${stamp}`, roleId: "member",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Otto", handle: `cotto${stamp}`, roleId: "member",
  });
  await createChannel({ id: publicChannel, name: "general", isPrivate: false, createdBy: ids.admin });
  await createChannel({ id: privateChannel, name: "leadership", isPrivate: true, createdBy: ids.admin });
  await addChannelMember(privateChannel, ids.insider, "editor");
  // Positive control for the membership-enumeration regression test: a real,
  // legitimately-visible channel_members row (public channel, so anyone may
  // read it) proves the query mechanism itself works, so the private
  // channel's absence from the same unfiltered scan is a real denial and
  // not just a broken query returning nothing.
  await addChannelMember(publicChannel, ids.admin, "editor");
  await serviceClient.from("messages").insert({
    id: `m_secret_${stamp}`, conversation_id: privateChannel,
    author_id: ids.insider, content: "salary review notes",
  });

  // A two-person DM between admin and insider, already full, for the
  // gate-crashing regression test.
  const dmConv = await serviceClient.from("conversations").insert({ id: dmId, kind: "dm" });
  if (dmConv.error) throw new Error(`seed dm conversation failed: ${dmConv.error.message}`);
  const dm = await serviceClient.from("dms").insert({ id: dmId });
  if (dm.error) throw new Error(`seed dm failed: ${dm.error.message}`);
  const dmMembers = await serviceClient
    .from("dm_members").insert([
      { dm_id: dmId, user_id: ids.admin },
      { dm_id: dmId, user_id: ids.insider },
    ]);
  if (dmMembers.error) throw new Error(`seed dm_members failed: ${dmMembers.error.message}`);
});

afterAll(async () => {
  await serviceClient.from("conversations")
    .delete().in("id", [publicChannel, privateChannel, forgeChannel, dmId]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("conversation RLS", () => {
  it("shows a public channel to any member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("channels").select("id").eq("id", publicChannel);
    expect(data).toHaveLength(1);
  });

  it("hides a private channel from a non-member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("channels").select("id").eq("id", privateChannel);
    expect(data).toHaveLength(0);
  });

  it("shows a private channel to its member", async () => {
    const client = await signInAs(emails.insider, TEST_PASSWORD);
    const { data } = await client.from("channels").select("id").eq("id", privateChannel);
    expect(data).toHaveLength(1);
  });

  it("shows a private channel to an admin via members.manage", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const { data } = await client.from("channels").select("id").eq("id", privateChannel);
    expect(data).toHaveLength(1);
  });

  it("withholds private-channel messages from a non-member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client
      .from("messages").select("id,content").eq("conversation_id", privateChannel);
    expect(data).toHaveLength(0);
  });

  it("denies a non-member posting into a private channel", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("messages").insert({
      id: `m_intrude_${stamp}`, conversation_id: privateChannel,
      author_id: ids.outsider, content: "hello?",
    });
    expect(error).not.toBeNull();
  });

  it("denies posting under someone else's name", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("messages").insert({
      id: `m_forge_${stamp}`, conversation_id: publicChannel,
      author_id: ids.admin, content: "forged",
    });
    expect(error).not.toBeNull();
  });

  it("denies editing another person's message", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    await client.from("messages").update({ content: "tampered" }).eq("id", `m_secret_${stamp}`);
    const { data } = await serviceClient
      .from("messages").select("content").eq("id", `m_secret_${stamp}`).single();
    expect(data?.content).toBe("salary review notes");
  });

  it("lets an admin delete anyone's message via message.deleteAny", async () => {
    const id = `m_del_${stamp}`;
    await serviceClient.from("messages").insert({
      id, conversation_id: publicChannel, author_id: ids.outsider, content: "spam",
    });
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    await client.from("messages").delete().eq("id", id);
    const { data } = await serviceClient.from("messages").select("id").eq("id", id);
    expect(data).toHaveLength(0);
  });

  // --- Regression tests for the seven RLS holes fixed in
  // 20260906000250_fix_conversation_policies.sql. Each asserts the denial
  // explicitly (an error, or a paired positive control) rather than
  // trusting an empty result set alone — a broken query returns that too.

  it("hole 1: does not let a member enumerate a private channel's membership", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data, error } = await client.from("channel_members").select("channel_id,user_id");
    expect(error).toBeNull();
    const rows = data ?? [];
    // Positive control: the public channel's membership row IS visible,
    // proving this unfiltered scan actually returns rows and isn't just
    // silently broken.
    expect(rows.some((r) => r.channel_id === publicChannel && r.user_id === ids.admin)).toBe(true);
    // The private channel's membership must not appear anywhere in the scan.
    expect(rows.some((r) => r.channel_id === privateChannel)).toBe(false);
  });

  it("hole 2: does not let a member insert themselves into a private channel", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("channel_members").insert({
      channel_id: privateChannel, user_id: ids.outsider, level: "editor",
    });
    expect(error).not.toBeNull();
    const { data } = await serviceClient
      .from("channel_members").select("user_id")
      .eq("channel_id", privateChannel).eq("user_id", ids.outsider);
    expect(data).toHaveLength(0);
  });

  it("hole 3: does not expose the conversation row for a channel the user cannot see", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data, error } = await client.from("conversations").select("id,kind");
    expect(error).toBeNull();
    const rows = data ?? [];
    // Positive control: the public channel's conversation row IS visible.
    expect(rows.some((r) => r.id === publicChannel)).toBe(true);
    // The private channel's parent conversation row must not leak through.
    expect(rows.some((r) => r.id === privateChannel)).toBe(false);
  });

  it("hole 4: does not let a non-manager update a channel they can merely see", async () => {
    const client = await signInAs(emails.insider, TEST_PASSWORD);
    await client.from("channels").update({ name: "hijacked", is_private: false })
      .eq("id", privateChannel);
    const { data } = await serviceClient
      .from("channels").select("name,is_private").eq("id", privateChannel).single();
    expect(data?.name).toBe("leadership");
    expect(data?.is_private).toBe(true);
  });

  it("hole 5: does not let a third party gate-crash a two-person DM", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("dm_members").insert({
      dm_id: dmId, user_id: ids.outsider,
    });
    expect(error).not.toBeNull();
    const { data } = await serviceClient.from("dm_members").select("user_id").eq("dm_id", dmId);
    expect(data).toHaveLength(2);
    expect((data ?? []).some((r) => r.user_id === ids.outsider)).toBe(false);
  });

  it("hole 6: does not let a user react to a message in a channel they cannot see", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("reactions").insert({
      message_id: `m_secret_${stamp}`, emoji: "👀", user_id: ids.outsider,
    });
    expect(error).not.toBeNull();
    const { data } = await serviceClient
      .from("reactions").select("user_id")
      .eq("message_id", `m_secret_${stamp}`).eq("user_id", ids.outsider);
    expect(data).toHaveLength(0);
  });

  it("hole 7: does not let a user create a channel under someone else's id", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    await client.from("conversations").insert({ id: forgeChannel, kind: "channel" });
    const { error } = await client.from("channels").insert({
      id: forgeChannel, name: "forged", description: "", is_private: false,
      is_team: false, created_by: ids.admin,
    });
    expect(error).not.toBeNull();
    const { data } = await serviceClient.from("channels").select("id").eq("id", forgeChannel);
    expect(data).toHaveLength(0);
  });
});
