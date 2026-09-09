import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import {
  addProjectMember, createChannel, createProject, removeProjectMember, seedRoles,
} from "../helpers/workspace";

// LINK LAUNDERING — final-review.md findings 1, 2 and 3, closed by
// supabase/migrations/20260909001000_attachment_link_visibility.sql.
//
// Every other attachment suite in this directory asks "given these links, who
// can read?". None of them asked **who may create a link**, and that is the
// question this file exists for. The three `*_attachments_insert` policies
// used to check only the DESTINATION — do you own this message, can you manage
// this project, may you edit this task — and said nothing about the attachment
// being linked. So a caller who knew an attachment id could link it to
// something of their own, and `can_see_attachment` would then answer "yes, it
// is on a message you can see", handing them the row and a signed URL to bytes
// in a private bucket. Demonstrated live against lumina-dev before the fix:
// 8 of storage_probe's 40 checks failed and the secret bytes were served.
//
// EVERY NEGATIVE HERE IS PAIRED WITH A POSITIVE CONTROL that runs the same
// insert, on the same table, from the same client, for a file the caller CAN
// see. Without them a policy that had simply started refusing every link would
// pass this whole file while breaking file sharing outright.
//
// Three identities, all of whom are genuinely ALLOWED to write to the
// destinations they attack — so a refusal can only be the attachment half of
// the policy talking:
//   `own`  — admin, uploader, creator of both restricted projects;
//   `spy`  — a GUEST, whose only permission is `message.send`. That is the
//            whole exploit's prerequisite, and Guest is the smallest role that
//            shipped;
//   `mate` — a plain Member who IS in the `secret` project (so the revocation
//            test has something to lose), holds `task.edit`, and created a
//            project of their own — which makes it `project_is_manageable`
//            regardless of permission.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const emails = {
  own: `alown-${stamp}@lumina.test`,
  spy: `alspy-${stamp}@lumina.test`,
  mate: `almate-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

const projects = {
  open: `p_al_open_${stamp}`, // restricted = false: everyone sees it
  secret: `p_al_secret_${stamp}`, // own + mate, until the revocation test
  vault: `p_al_vault_${stamp}`, // own ONLY — nothing mate or spy can reach
  mine: `p_al_mine_${stamp}`, // created by mate, so mate can manage it
};
const files = {
  open: `att_al_open_${stamp}`, // on `open`   — everyone can see it
  secret: `att_al_secret_${stamp}`, // on `secret` — own + mate. The revocation target.
  vault: `att_al_vault_${stamp}`, // on `vault`  — own only. The laundering target.
};
const channelId = `c_al_ch_${stamp}`;
const taskId = `t_al_mine_${stamp}`;
const messages = {
  spy: `m_al_spy_${stamp}`,
  spyDm: `m_al_spydm_${stamp}`,
  mate: `m_al_mate_${stamp}`,
};
let spyDmId = "";

/** An attachments row, its project link, and real bytes uploaded through
 *  `own`'s own client — the Storage INSERT policy is `is_attachment_uploader`,
 *  so the row has to exist first and the upload has to come from its uploader. */
async function seedFile(id: string, projectId: string): Promise<void> {
  const row = await serviceClient.from("attachments").insert({
    id, storage_path: `project-files/${id}`, name: `${id}.txt`,
    size: 5, mime: "text/plain", uploaded_by: ids.own,
  });
  if (row.error) throw new Error(`seedFile ${id}: ${row.error.message}`);
  const link = await serviceClient
    .from("project_attachments").insert({ project_id: projectId, attachment_id: id });
  if (link.error) throw new Error(`seedFile link ${id}: ${link.error.message}`);
  const own = await clientFor(emails.own);
  const put = await own.storage
    .from("project-files").upload(id, new Blob(["hello"], { type: "text/plain" }));
  if (put.error) throw new Error(`seedFile upload ${id}: ${put.error.message}`);
}

beforeAll(async () => {
  await seedRoles();
  ids.own = await createTestUser({
    email: emails.own, password: TEST_PASSWORD,
    name: "Ola", handle: `alola${stamp}`, roleId: "admin",
  });
  ids.spy = await createTestUser({
    email: emails.spy, password: TEST_PASSWORD,
    name: "Spy", handle: `alspy${stamp}`, roleId: "guest",
  });
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Mio", handle: `almio${stamp}`, roleId: "member",
  });

  await createProject({ id: projects.open, name: "Open", restricted: false, createdBy: ids.own });
  await createProject({ id: projects.secret, name: "Payroll", restricted: true, createdBy: ids.own });
  await createProject({ id: projects.vault, name: "Vault", restricted: true, createdBy: ids.own });
  await createProject({ id: projects.mine, name: "Mine", restricted: false, createdBy: ids.mate });
  await addProjectMember(projects.secret, ids.own, "editor");
  await addProjectMember(projects.secret, ids.mate, "editor");
  await addProjectMember(projects.vault, ids.own, "editor");

  await createChannel({
    id: channelId, name: `al-general-${stamp}`, isPrivate: false, createdBy: ids.own,
  });
  const task = await serviceClient.from("tasks").insert({
    id: taskId, project_id: projects.mine, title: "Mine", created_by: ids.mate,
  });
  if (task.error) throw new Error(`task fixture: ${task.error.message}`);

  await seedFile(files.open, projects.open);
  await seedFile(files.secret, projects.secret);
  await seedFile(files.vault, projects.vault);

  // The attackers' own destinations, written through their OWN clients — so
  // the fixtures themselves prove these writes really are permitted, and every
  // refusal below is about the attachment rather than the destination.
  const spy = await clientFor(emails.spy);
  const post = await spy.from("messages").insert({
    id: messages.spy, conversation_id: channelId, author_id: ids.spy, content: "hi",
  }).select("id");
  if (post.error) throw new Error(`spy message: ${post.error.message}`);

  const dm = await spy.rpc("find_or_create_dm", { other_user_id: ids.own });
  if (dm.error || !dm.data) throw new Error(`spy dm: ${dm.error?.message}`);
  spyDmId = dm.data;
  const dmPost = await spy.from("messages").insert({
    id: messages.spyDm, conversation_id: spyDmId, author_id: ids.spy, content: "x",
  }).select("id");
  if (dmPost.error) throw new Error(`spy dm message: ${dmPost.error.message}`);

  const mate = await clientFor(emails.mate);
  const matePost = await mate.from("messages").insert({
    id: messages.mate, conversation_id: channelId, author_id: ids.mate, content: "yo",
  }).select("id");
  if (matePost.error) throw new Error(`mate message: ${matePost.error.message}`);
}, 90_000);

afterAll(async () => {
  await serviceClient.storage.from("project-files").remove(Object.values(files));
  await serviceClient.from("conversations").delete()
    .in("id", spyDmId ? [channelId, spyDmId] : [channelId]);
  await serviceClient.from("projects").delete().in("id", Object.values(projects));
  await serviceClient.from("attachments").delete().in("id", Object.values(files));
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

// ---------------------------------------------------------------------------
// The attack, on all four surfaces.
// ---------------------------------------------------------------------------
describe("linking a file requires being allowed to SEE it, not only to write to the destination", () => {
  it("a GUEST cannot link an unseen file to their own message in a public channel", async () => {
    // `message.send` is the only permission Guest holds, and it is the entire
    // prerequisite for the original exploit.
    const spy = await clientFor(emails.spy);
    const link = await spy.from("message_attachments")
      .insert({ message_id: messages.spy, attachment_id: files.vault });
    expect(link.error?.code).toBe("42501");
  });

  it("POSITIVE CONTROL: the same guest, the same message, a file they CAN see", async () => {
    // Without this the test above would pass against a policy that refused
    // every link — i.e. against file sharing being switched off entirely.
    const spy = await clientFor(emails.spy);
    const link = await spy.from("message_attachments")
      .insert({ message_id: messages.spy, attachment_id: files.open });
    expect(link.error).toBeNull();
  });

  it("a GUEST cannot link an unseen file to a DM with themselves as author", async () => {
    // The nastiest variant: a thread no third party ever reads, so the
    // laundering link is invisible to every administrator too.
    const spy = await clientFor(emails.spy);
    const link = await spy.from("message_attachments")
      .insert({ message_id: messages.spyDm, attachment_id: files.vault });
    expect(link.error?.code).toBe("42501");
  });

  it("POSITIVE CONTROL: the same DM message accepts a file the guest can see", async () => {
    const spy = await clientFor(emails.spy);
    const link = await spy.from("message_attachments")
      .insert({ message_id: messages.spyDm, attachment_id: files.open });
    expect(link.error).toBeNull();
  });

  it("a Member cannot link an unseen file into a project they created", async () => {
    // `project_is_manageable` is satisfied by `created_by = auth.uid()` alone,
    // so this member passes the destination half of the policy outright.
    const mate = await clientFor(emails.mate);
    const link = await mate.from("project_attachments")
      .insert({ project_id: projects.mine, attachment_id: files.vault });
    expect(link.error?.code).toBe("42501");
  });

  it("POSITIVE CONTROL: the same project accepts a file that member CAN see", async () => {
    const mate = await clientFor(emails.mate);
    const link = await mate.from("project_attachments")
      .insert({ project_id: projects.mine, attachment_id: files.open });
    expect(link.error).toBeNull();
  });

  it("a Member cannot link an unseen file onto a task they may edit", async () => {
    const mate = await clientFor(emails.mate);
    const link = await mate.from("task_attachments")
      .insert({ task_id: taskId, attachment_id: files.vault });
    expect(link.error?.code).toBe("42501");
  });

  it("POSITIVE CONTROL: the same task accepts a file that member CAN see", async () => {
    const mate = await clientFor(emails.mate);
    const link = await mate.from("task_attachments")
      .insert({ task_id: taskId, attachment_id: files.open });
    expect(link.error).toBeNull();
  });

  it("after every attempt the vault file's row and BYTES are still unreachable", async () => {
    // The payoff, and the assertions that failed before the fix: the row, a
    // signed URL, and a direct download, for both attackers.
    const spy = await clientFor(emails.spy);
    const mate = await clientFor(emails.mate);

    for (const client of [spy, mate]) {
      const row = await client.from("attachments").select("id,name").eq("id", files.vault);
      expect(row.data).toEqual([]);

      const signed = await client.storage.from("project-files").createSignedUrl(files.vault, 60);
      expect(signed.data).toBeNull();

      const direct = await client.storage.from("project-files").download(files.vault);
      expect(direct.data).toBeNull();
    }
  });

  it("POSITIVE CONTROL: the owner can still read the vault file's row and bytes", async () => {
    // Proves the previous test is a policy denying two specific callers, not a
    // Storage layer or a table that had stopped answering for everyone.
    const own = await clientFor(emails.own);
    const row = await own.from("attachments").select("id").eq("id", files.vault);
    expect(row.data).toHaveLength(1);

    const signed = await own.storage.from("project-files").createSignedUrl(files.vault, 60);
    expect(signed.error).toBeNull();
    const res = await fetch(signed.data!.signedUrl);
    expect(await res.text()).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Finding 3: revocation has to mean revocation.
// ---------------------------------------------------------------------------
describe("revocation revokes: a former member cannot re-link their way back in", () => {
  // These run LAST because the first one permanently removes `mate` from the
  // project the controls above depend on.
  it("a member who loses project access cannot regain the file by re-linking it", async () => {
    // The reviewer's point about tests/rls/storage.test.ts:157 — "access lost
    // is bytes lost" was true only of the DIRECT path. Attachment ids are not
    // secret to anyone who ever had access (hydrate hands every project member
    // the whole row), so a revoked member kept the id and could re-grant
    // themselves the bytes at will.
    const mate = await clientFor(emails.mate);

    // 1. Before: they really can see it, row and bytes. Not assumed — the
    //    whole test is worthless if the file was never visible to them.
    const before = await mate.from("attachments").select("id").eq("id", files.secret);
    expect(before.data).toHaveLength(1);
    const signedBefore = await mate.storage
      .from("project-files").createSignedUrl(files.secret, 60);
    expect(signedBefore.error).toBeNull();

    // 2. Access is revoked, and the direct path closes.
    await removeProjectMember(projects.secret, ids.mate);
    const afterRow = await mate.from("attachments").select("id").eq("id", files.secret);
    expect(afterRow.data).toEqual([]);

    // 3. The re-link, on all three surfaces. Every destination is one they may
    //    still write to: a project they created, a task on it, and a message
    //    they authored in a public channel.
    const viaProject = await mate.from("project_attachments")
      .insert({ project_id: projects.mine, attachment_id: files.secret });
    expect(viaProject.error?.code).toBe("42501");

    const viaTask = await mate.from("task_attachments")
      .insert({ task_id: taskId, attachment_id: files.secret });
    expect(viaTask.error?.code).toBe("42501");

    const viaMessage = await mate.from("message_attachments")
      .insert({ message_id: messages.mate, attachment_id: files.secret });
    expect(viaMessage.error?.code).toBe("42501");

    // 4. And the bytes are still gone afterwards — the refusals were real, not
    //    a link that landed and was merely reported as refused.
    const finalRow = await mate.from("attachments").select("id").eq("id", files.secret);
    expect(finalRow.data).toEqual([]);
    const signedAfter = await mate.storage
      .from("project-files").createSignedUrl(files.secret, 60);
    expect(signedAfter.data).toBeNull();
  });

  it("POSITIVE CONTROL: that same revoked member can still link a file they CAN see", async () => {
    // Same client, same table, same message — so the three refusals above are
    // about this one attachment, not about the member having lost the ability
    // to attach anything at all.
    const mate = await clientFor(emails.mate);
    const link = await mate.from("message_attachments")
      .insert({ message_id: messages.mate, attachment_id: files.open });
    expect(link.error).toBeNull();
  });
});
