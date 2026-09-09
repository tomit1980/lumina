import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import type { Attachment } from "@/lib/types";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addProjectMember, createProject, seedRoles } from "../helpers/workspace";

// Task 10 — attachment BYTES against lumina-dev, under the real Storage
// policies (supabase/migrations/20260910001000_storage.sql).
//
// The claim this file exists to test is one sentence: **a file is reachable
// exactly when the project, task or message it hangs off is.** Nothing about
// that can be checked by reading the migration, because Storage is a separate
// service with its own request path — `storage.objects` is a table, but the
// signed-URL endpoint in front of it is not PostgREST, and "the policy looks
// right" has never been the same claim as "the bytes cannot be fetched".
//
// Every negative below is paired with a positive control on the SAME method
// and, wherever possible, the SAME client — a Storage layer that had simply
// stopped serving anything at all would otherwise pass every one of them.
//
// Frugal, like every file here: exactly THREE identities ever sign in.
//   `own`      — an admin, uploader and project creator;
//   `mate`     — a plain Member with NO project.create and NO project.delete,
//                who is a member of the restricted project. Every refusal
//                aimed at this identity is a policy talking, not an absence of
//                access;
//   `outsider` — a plain Member who is a member of nothing.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const emails = {
  own: `stown-${stamp}@lumina.test`,
  mate: `stmate-${stamp}@lumina.test`,
  outsider: `stout-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};
const projects = { open: `p_st_open_${stamp}`, secret: `p_st_secret_${stamp}` };
const createdAttachments = new Set<string>();

async function backendFor(email: string): Promise<SupabaseBackend> {
  return new SupabaseBackend(await clientFor(email));
}

function file(id: string, name = "payroll.txt"): Attachment {
  createdAttachments.add(id);
  return {
    id, name, size: 5, type: "text/plain",
    dataUrl: "", uploadedBy: ids.own, uploadedAt: Date.now(),
  };
}

/** Uploads bytes as `own` and links them to a project, the way the app does:
 *  row, then bytes, then link. Returns the storage reference. */
async function upload(projectId: string, attachment: Attachment): Promise<string> {
  const backend = await backendFor(emails.own);
  const ref = await backend.putAttachment(
    "project",
    attachment,
    new Blob(["hello"], { type: "text/plain" })
  );
  const link = await serviceClient
    .from("project_attachments")
    .insert({ project_id: projectId, attachment_id: attachment.id });
  if (link.error) throw new Error(`link failed: ${link.error.message}`);
  return ref;
}

/** Fetches a signed URL's contents, so "can sign" and "can actually read the
 *  bytes" are two separate claims rather than one assumed from the other. */
async function fetchThrough(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
  await seedRoles();
  ids.own = await createTestUser({
    email: emails.own, password: TEST_PASSWORD,
    name: "Ola", handle: `stola${stamp}`, roleId: "admin",
  });
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Mio", handle: `stmio${stamp}`, roleId: "member",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Ova", handle: `stova${stamp}`, roleId: "member",
  });

  await createProject({ id: projects.open, name: "Open", restricted: false, createdBy: ids.own });
  await createProject({ id: projects.secret, name: "Payroll", restricted: true, createdBy: ids.own });
  await addProjectMember(projects.secret, ids.own, "editor");
  await addProjectMember(projects.secret, ids.mate, "editor");

  await clientFor(emails.own);
  await clientFor(emails.mate);
  await clientFor(emails.outsider);
}, 60_000);

afterAll(async () => {
  for (const id of createdAttachments) {
    await serviceClient.storage.from("project-files").remove([id]);
  }
  await serviceClient.from("attachments").delete().in("id", [...createdAttachments]);
  await serviceClient.from("projects").delete().in("id", Object.values(projects));
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

// ---------------------------------------------------------------------------
// The whole point of the task.
// ---------------------------------------------------------------------------
describe("a file is reachable exactly when its project is", () => {
  it("someone WITHOUT access to the parent project cannot fetch the file by its path", async () => {
    const secret = file(`att_st_secret_${stamp}`);
    await upload(projects.secret, secret);

    const outsider = await clientFor(emails.outsider);
    // Three separate doors, because closing one proves nothing about the
    // others: signing a URL, downloading directly, and listing the bucket.
    const signed = await outsider.storage
      .from("project-files")
      .createSignedUrl(secret.id, 60);
    expect(signed.data).toBeNull();
    expect(signed.error).not.toBeNull();

    const direct = await outsider.storage.from("project-files").download(secret.id);
    expect(direct.data).toBeNull();
    expect(direct.error).not.toBeNull();

    const listed = await outsider.storage.from("project-files").list();
    expect((listed.data ?? []).map((o) => o.name)).not.toContain(secret.id);
  });

  it("POSITIVE CONTROL: a member of that same project can, through the same three doors", async () => {
    // Without this the test above would pass against a Storage layer that had
    // stopped serving anything at all — the exact vacuous negative this repo
    // has already been caught by once.
    const mate = await clientFor(emails.mate);
    const id = `att_st_secret_${stamp}`;

    const signed = await mate.storage.from("project-files").createSignedUrl(id, 60);
    expect(signed.error).toBeNull();
    expect(signed.data?.signedUrl).toBeTruthy();
    expect(await fetchThrough(signed.data!.signedUrl)).toEqual({ status: 200, body: "hello" });

    const direct = await mate.storage.from("project-files").download(id);
    expect(direct.error).toBeNull();
    expect(await direct.data!.text()).toBe("hello");

    const listed = await mate.storage.from("project-files").list();
    expect((listed.data ?? []).map((o) => o.name)).toContain(id);
  });

  it("access lost is bytes lost (DIRECT path): a signed URL cannot be minted once membership is revoked", async () => {
    // The row-level equivalent of this is tests/rls/attachments.test.ts's
    // revocation case; the file's BYTES have to follow the same rule or the
    // link a former member already holds outlives their access.
    //
    // SCOPED IN ITS NAME on purpose (final-review.md finding 3). This tests
    // the DIRECT path only, and until 20260909001000_attachment_link_visibility
    // landed it overstated what it proved: the revoked member here never tries
    // to re-link the file, and re-linking was exactly how they could have
    // regained the bytes. That attack is now covered, with its own positive
    // controls, in tests/rls/attachment-linking.test.ts.
    const id = `att_st_secret_${stamp}`;
    const mate = await clientFor(emails.mate);
    const before = await mate.storage.from("project-files").createSignedUrl(id, 60);
    expect(before.error).toBeNull();

    const removed = await serviceClient
      .from("project_members").delete()
      .eq("project_id", projects.secret).eq("user_id", ids.mate);
    expect(removed.error).toBeNull();

    // Same cached session — has_permission and can_see_project are read live
    // from the tables on every request, nothing is baked into the JWT.
    const after = await mate.storage.from("project-files").createSignedUrl(id, 60);
    expect(after.data).toBeNull();
    expect(after.error).not.toBeNull();

    await addProjectMember(projects.secret, ids.mate, "editor");
  });

  it("a file on an OPEN project is readable by any signed-in user — the rule is visibility, not ownership", async () => {
    const open = file(`att_st_open_${stamp}`, "public.txt");
    await upload(projects.open, open);

    const outsider = await clientFor(emails.outsider);
    const signed = await outsider.storage.from("project-files").createSignedUrl(open.id, 60);
    expect(signed.error).toBeNull();
    expect(await fetchThrough(signed.data!.signedUrl)).toEqual({ status: 200, body: "hello" });
  });
});

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------
describe("nobody can put bytes behind a row they do not own", () => {
  it("REFUSES an upload to a path whose attachments row belongs to someone else", async () => {
    // Mirrors `attachments_insert`'s `uploaded_by = auth.uid()`. Without this
    // an ordinary member could overwrite the contents of any file whose id
    // they could guess, in a project they cannot even see.
    const outsider = await clientFor(emails.outsider);
    const put = await outsider.storage
      .from("project-files")
      .upload(`att_st_secret_${stamp}`, new Blob(["forged"]), { upsert: true });
    expect(put.error).not.toBeNull();
  });

  it("POSITIVE CONTROL: the same client CAN upload behind a row it does own", async () => {
    const mine = `att_st_theirs_${stamp}`;
    createdAttachments.add(mine);
    const row = await serviceClient.from("attachments").insert({
      id: mine, storage_path: `project-files/${mine}`, name: "mine.txt",
      size: 3, mime: "text/plain", uploaded_by: ids.outsider,
    });
    expect(row.error).toBeNull();

    const outsider = await clientFor(emails.outsider);
    const put = await outsider.storage.from("project-files").upload(mine, new Blob(["own"]));
    expect(put.error).toBeNull();
  });

  it("REFUSES an overwrite by someone who can SEE the file but has no project.create", async () => {
    // The Storage UPDATE policy mirrors `attachments_update`, which names
    // `project.create` — the same permission `updateProject` guards on, and
    // the in-app editors' Save is an `updateProject`. A plain Member can read
    // this file and still cannot rewrite it.
    const mate = await clientFor(emails.mate);
    const put = await mate.storage
      .from("project-files")
      .upload(`att_st_secret_${stamp}`, new Blob(["rewritten"]), { upsert: true });
    expect(put.error).not.toBeNull();

    // ...and the bytes really are untouched, not merely reported as refused.
    const still = await mate.storage.from("project-files").download(`att_st_secret_${stamp}`);
    expect(await still.data!.text()).toBe("hello");
  });

  it("POSITIVE CONTROL: an admin (project.create) can overwrite the same object", async () => {
    const admin = await backendFor(emails.own);
    const target = file(`att_st_secret_${stamp}`);
    await expect(
      admin.saveAttachment(
        { ...target, dataUrl: `project-files/${target.id}` },
        new Blob(["rewritten"], { type: "text/plain" }),
        ids.own,
        Date.now()
      )
    ).resolves.toBe(`project-files/${target.id}`);

    const mate = await clientFor(emails.mate);
    const now = await mate.storage.from("project-files").download(target.id);
    expect(await now.data!.text()).toBe("rewritten");
  });
});

describe("deleting bytes", () => {
  it("REFUSES a delete by someone who is neither the uploader nor a project.delete holder", async () => {
    // storage-api reports this as `error: null` with an EMPTY array, which is
    // the false-success shape `requireRows` exists for. The backend has to
    // notice, and this asserts it does — through `deleteAttachment`, not
    // through a raw call, so the check being tested is the one that ships.
    const mate = await backendFor(emails.mate);
    const id = `att_st_secret_${stamp}`;
    await expect(
      mate.deleteAttachment({ ...file(id), dataUrl: `project-files/${id}` })
    ).rejects.toThrow(/uploaded it/i);

    const admin = await clientFor(emails.own);
    const survived = await admin.storage.from("project-files").download(id);
    expect(survived.error).toBeNull();
  });

  it("POSITIVE CONTROL: the uploader can, and the bytes AND the row both go", async () => {
    const admin = await backendFor(emails.own);
    const id = `att_st_secret_${stamp}`;
    await expect(
      admin.deleteAttachment({ ...file(id), dataUrl: `project-files/${id}` })
    ).resolves.toBeUndefined();

    const client = await clientFor(emails.own);
    const gone = await client.storage.from("project-files").download(id);
    expect(gone.data).toBeNull();
    const row = await serviceClient.from("attachments").select("id").eq("id", id);
    expect(row.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task 8's open item (a), folded into this task's migration.
// ---------------------------------------------------------------------------
describe("roles.locked / roles.is_system are protected by the database, not only by the app", () => {
  it("REFUSES a raw edit of the locked Admin role by a members.manage holder", async () => {
    // Not an escalation — an admin can already mint an all-permissions role —
    // but a one-way LOCKOUT: revoke members.manage from Admin and nobody can
    // ever grant it back, because the only role that could is the one that
    // just lost it. Driven through a raw PostgREST call on the admin's own
    // signed-in client, because the store and lib/backend/supabase/roles.ts
    // both already refuse it; this is the half that demonstrates a trigger
    // rather than a client-side check.
    const admin = await clientFor(emails.own);
    const raw = await admin
      .from("roles").update({ description: "edited" }).eq("id", "admin").select("id");
    expect(raw.error?.message).toMatch(/locked/i);
  });

  it("POSITIVE CONTROL: the same client CAN edit an unlocked role", async () => {
    // Without this, a trigger that refused every roles UPDATE would pass the
    // test above and silently break role editing for the whole app.
    const admin = await clientFor(emails.own);
    const ok = await admin
      .from("roles").update({ description: "Day-to-day access." }).eq("id", "member").select("id");
    expect(ok.error).toBeNull();
    expect(ok.data).toHaveLength(1);
  });

  it("REFUSES promoting an ordinary role to is_system or locked", async () => {
    // The other half, and it is what keeps the first rule from being one
    // UPDATE away from switched off — and an is_system role permanently
    // undeletable (`block_role_delete_with_members` refuses built-ins).
    const admin = await clientFor(emails.own);
    const locked = await admin
      .from("roles").update({ locked: true }).eq("id", "member").select("id");
    expect(locked.error?.message).toMatch(/locked/i);

    const system = await admin
      .from("roles").update({ is_system: false }).eq("id", "member").select("id");
    expect(system.error?.message).toMatch(/locked/i);
  });

  it("the service-role bypass is real, and is what keeps seedRoles() working", async () => {
    // Deliberate, and load-bearing: `seedRoles()` upserts all three built-ins
    // from DEFAULT_ROLES at the start of every RLS file, and an upsert of an
    // existing row is an UPDATE. Every real caller reaches this table as
    // `authenticated`.
    const bypass = await serviceClient
      .from("roles").update({ description: "Full access — manage members, roles, and permissions." })
      .eq("id", "admin").select("id");
    expect(bypass.error).toBeNull();
    expect(bypass.data).toHaveLength(1);
  });
});
