import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addChannelMember, createChannel, createProject, seedRoles } from "../helpers/workspace";

// Supabase rate-limits sign-ins per project; this file needs three
// identities across many assertions. Memoize one signed-in client per
// email and reuse it everywhere instead of calling signInAs per test — the
// RLS behaviour under test depends on server-side data, not client-side
// session state, so a cached session is exactly as valid a probe as a
// fresh one.
const clientCache = new Map<string, Awaited<ReturnType<typeof signInAs>>>();
async function clientFor(email: string): Promise<Awaited<ReturnType<typeof signInAs>>> {
  const cached = clientCache.get(email);
  if (cached) return cached;
  const client = await signInAs(email, TEST_PASSWORD);
  clientCache.set(email, client);
  return client;
}

const stamp = Date.now();
const secretProject = `p_att_${stamp}`;
const attachmentId = `att_${stamp}`;
const taskId = `t_att_${stamp}`;
const taskAttachmentId = `att_task_${stamp}`;
const conv = `c_att_${stamp}`;
const msgId = `m_att_${stamp}`;
const msgAttachmentId = `att_msg_${stamp}`;
const orphanAttachmentId = `att_orphan_${stamp}`;
const linkedAttachmentId = `att_link_${stamp}`;

const emails = {
  owner: `aown-${stamp}@lumina.test`,
  outsider: `aout-${stamp}@lumina.test`,
  author: `aauth-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ada", handle: `aada${stamp}`, roleId: "admin",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Otto", handle: `aotto${stamp}`, roleId: "member",
  });
  ids.author = await createTestUser({
    email: emails.author, password: TEST_PASSWORD,
    name: "Amy", handle: `aamy${stamp}`, roleId: "member",
  });

  // A restricted project only its creator (owner) can see, plus one
  // attachment linked to it and one task inside it (also linked).
  await createProject({ id: secretProject, name: "Board deck", restricted: true, createdBy: ids.owner });
  await serviceClient.from("attachments").insert({
    id: attachmentId, storage_path: `projects/${secretProject}/${attachmentId}`,
    name: "board-deck.xlsx", size: 4096,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    uploaded_by: ids.owner,
  });
  await serviceClient.from("project_attachments")
    .insert({ project_id: secretProject, attachment_id: attachmentId });

  await serviceClient.from("tasks").insert({
    id: taskId, project_id: secretProject, title: "Finalize deck", created_by: ids.owner,
  });
  await serviceClient.from("attachments").insert({
    id: taskAttachmentId, storage_path: `tasks/${taskId}/${taskAttachmentId}`,
    name: "notes.md", size: 128, mime: "text/markdown", uploaded_by: ids.owner,
  });
  await serviceClient.from("task_attachments")
    .insert({ task_id: taskId, attachment_id: taskAttachmentId });

  // A private channel where `author` posts a message with an attachment,
  // then loses membership — used by the Defect 2 regression below.
  await createChannel({ id: conv, name: "att-private", isPrivate: true, createdBy: ids.owner });
  await addChannelMember(conv, ids.author, "editor");
});

afterAll(async () => {
  // Delete attachments first: project_attachments/task_attachments/
  // message_attachments all reference attachment_id `on delete cascade`.
  await serviceClient.from("attachments").delete().in("id", [
    attachmentId, taskAttachmentId, msgAttachmentId,
    orphanAttachmentId, linkedAttachmentId,
  ]);
  await serviceClient.from("tasks").delete().eq("id", taskId);
  await serviceClient.from("projects").delete().eq("id", secretProject);
  await serviceClient.from("conversations").delete().eq("id", conv);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("attachment visibility", () => {
  it("hides an attachment on a restricted project from a non-member", async () => {
    const client = await clientFor(emails.outsider);
    const { data } = await client.from("attachments").select("id,name").eq("id", attachmentId);
    expect(data).toHaveLength(0);
  });

  it("shows it to someone who can see the project", async () => {
    const client = await clientFor(emails.owner);
    const { data } = await client.from("attachments").select("id,name").eq("id", attachmentId);
    expect(data).toHaveLength(1);
    expect(data?.[0]?.name).toBe("board-deck.xlsx");
  });
});

describe("read_state privacy", () => {
  it("keeps one user's read state invisible to another", async () => {
    const readConv = `c_read_${stamp}`;
    await serviceClient.from("conversations").insert({ id: readConv, kind: "channel" });
    await serviceClient.from("channels")
      .insert({ id: readConv, name: "readtest", is_private: false, created_by: ids.owner });
    await serviceClient.from("read_state")
      .insert({ user_id: ids.owner, conversation_id: readConv });

    const client = await clientFor(emails.outsider);
    const { data } = await client.from("read_state").select("user_id").eq("conversation_id", readConv);
    expect(data).toHaveLength(0);

    await serviceClient.from("conversations").delete().eq("id", readConv);
  });

  it("denies writing read state on someone else's behalf", async () => {
    const readConv = `c_read2_${stamp}`;
    await serviceClient.from("conversations").insert({ id: readConv, kind: "channel" });
    await serviceClient.from("channels")
      .insert({ id: readConv, name: "readtest2", is_private: false, created_by: ids.owner });

    const client = await clientFor(emails.outsider);
    const { error } = await client.from("read_state")
      .insert({ user_id: ids.owner, conversation_id: readConv });
    expect(error).not.toBeNull();

    await serviceClient.from("conversations").delete().eq("id", readConv);
  });
});

describe("activities", () => {
  it("denies logging activity under another user's name", async () => {
    const client = await clientFor(emails.outsider);
    const { error } = await client.from("activities").insert({
      id: `a_forge_${stamp}`, actor_id: ids.owner, text: "did something", kind: "project",
    });
    expect(error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------
// Defect 1: the brief's task_attachments_write was `for all using
// (has_permission('task.edit'))`. task.edit is held by the plain Member
// role, and `for all` ORs its using clause into select, so any member —
// regardless of which project the task belongs to — could enumerate a
// restricted project's task_attachments, defeating task_attachments_read
// beside it. Fixed by scoping insert/update/delete to the specific
// task's project (visible and not viewer-only), mirroring tasks_insert.
// ---------------------------------------------------------------------
describe("Defect 1 — task_attachments scoped to the task's project", () => {
  it("denies a member with task.edit from seeing task_attachments on a task in a project they cannot see", async () => {
    const client = await clientFor(emails.outsider);
    const { data } = await client.from("task_attachments")
      .select("task_id,attachment_id").eq("task_id", taskId);
    expect(data).toHaveLength(0);
  });

  it("positive control: the project's creator can see the same task_attachments row", async () => {
    const client = await clientFor(emails.owner);
    const { data } = await client.from("task_attachments")
      .select("task_id,attachment_id").eq("task_id", taskId);
    expect(data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// Defect 2: message_attachments_write (like project_attachments_write)
// was `for all` and gated select purely on `author_id = auth.uid()`, with
// no check that the author can still see the conversation *now*. Once a
// user loses channel membership, they remain the historical author of
// their old messages, so the unfixed policy would still leak select on
// that message's attachment links via the write policy's `using` clause
// riding along with select. Fixed by splitting into insert/update/delete
// so select is governed solely by message_attachments_read, which checks
// can_see_conversation live.
// ---------------------------------------------------------------------
describe("Defect 2 — message_attachments select governed solely by its read policy", () => {
  it("denies a message's own author once they lose access to its (private) conversation", async () => {
    const authorClient = await clientFor(emails.author);

    const { error: msgError } = await authorClient.from("messages").insert({
      id: msgId, conversation_id: conv, author_id: ids.author, content: "here's the file",
    });
    expect(msgError).toBeNull();

    await serviceClient.from("attachments").insert({
      id: msgAttachmentId, storage_path: `messages/${msgId}/${msgAttachmentId}`,
      name: "notes.txt", size: 64, mime: "text/plain", uploaded_by: ids.author,
    });
    await serviceClient.from("message_attachments")
      .insert({ message_id: msgId, attachment_id: msgAttachmentId });

    // Revoke the author's membership in the private channel.
    await serviceClient.from("channel_members")
      .delete().eq("channel_id", conv).eq("user_id", ids.author);

    const { data } = await authorClient.from("message_attachments")
      .select("message_id,attachment_id").eq("message_id", msgId);
    expect(data).toHaveLength(0);
  });

  it("positive control: someone who can still see the conversation sees the row", async () => {
    // owner holds members.manage, which can_see_conversation always bypasses on.
    const client = await clientFor(emails.owner);
    const { data } = await client.from("message_attachments")
      .select("message_id,attachment_id").eq("message_id", msgId);
    expect(data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// Defect 3: attachments_insert only checks `uploaded_by = auth.uid()` —
// nothing on the attachments table itself references a target, since
// linking happens through a join table. can_see_attachment's own
// uploader-fallback clause keeps a freshly uploaded, unlinked row visible
// only to its uploader, so the real gate belongs on the join tables'
// INSERT policies: project_attachments_insert/task_attachments_insert
// (project_is_manageable / visible+editable project) and
// message_attachments_insert (must be the message's own author). Together
// these stop a user from inserting an attachment and then linking it
// somewhere they cannot see or manage.
// ---------------------------------------------------------------------
describe("Defect 3 — an inserted attachment cannot be linked to a target the caller cannot manage", () => {
  it("lets a user insert their own unlinked attachment row", async () => {
    const client = await clientFor(emails.outsider);
    const { error } = await client.from("attachments").insert({
      id: orphanAttachmentId, storage_path: `orphan/${orphanAttachmentId}`,
      name: "orphan.txt", size: 1, mime: "text/plain", uploaded_by: ids.outsider,
    });
    expect(error).toBeNull();
  });

  it("denies linking that attachment into a restricted project the caller cannot manage", async () => {
    const client = await clientFor(emails.outsider);
    const { error } = await client.from("project_attachments")
      .insert({ project_id: secretProject, attachment_id: orphanAttachmentId });
    expect(error).not.toBeNull();
  });

  it("positive control: the project's creator can link their own attachment into it", async () => {
    const client = await clientFor(emails.owner);
    const { error: attError } = await client.from("attachments").insert({
      id: linkedAttachmentId, storage_path: `projects/${secretProject}/${linkedAttachmentId}`,
      name: "linked.txt", size: 1, mime: "text/plain", uploaded_by: ids.owner,
    });
    expect(attError).toBeNull();

    const { error: linkError } = await client.from("project_attachments")
      .insert({ project_id: secretProject, attachment_id: linkedAttachmentId });
    expect(linkError).toBeNull();
  });
});
