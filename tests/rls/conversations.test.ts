import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addChannelMember, createChannel, seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const publicChannel = `c_pub_${stamp}`;
const privateChannel = `c_priv_${stamp}`;
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
  await serviceClient.from("messages").insert({
    id: `m_secret_${stamp}`, conversation_id: privateChannel,
    author_id: ids.insider, content: "salary review notes",
  });
});

afterAll(async () => {
  await serviceClient.from("conversations").delete().in("id", [publicChannel, privateChannel]);
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
});
