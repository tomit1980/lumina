/**
 * Attachment bytes — the Storage half of `SupabaseBackend`.
 *
 * The rules this file has to respect all live in
 * supabase/migrations/20260910001000_storage.sql; the ones that decide the
 * shape of the code here are:
 *
 *   * **The attachments row comes first, the bytes second.** The Storage
 *     INSERT policy is `is_attachment_uploader(<object name>)`, which is
 *     answered from `public.attachments`. There is no window in which anyone
 *     can put bytes behind a row that does not exist.
 *   * **On the way out, the bytes go first and the row second.** Both delete
 *     predicates are answered from the same row, so deleting it first would
 *     strand the object in the bucket permanently. The order is safe because
 *     the two predicates are *identical*: an allowed object delete implies an
 *     allowed row delete against the same unchanged state.
 *   * **The object key is the attachment id, nothing else.** A signed URL
 *     shows its own path to anyone the link reaches, so a path carrying a
 *     project id or a file name would leak both. The download name travels as
 *     the signed URL's `download` parameter instead.
 *
 * `Attachment.dataUrl` carries `"<bucket>/<attachment-id>"` on this backend —
 * self-describing, so a delete never has to guess which bucket a file went
 * into. `lib/attachments.ts` owns the local/Supabase discrimination
 * (`data:` prefix or not) and never parses this string itself.
 */
import type { LuminaClient } from "./client";
import { fail } from "./result";
import type { AttachmentOwner } from "../types";
import type { Attachment } from "../../types";

/** One bucket per owning kind, as the plan specifies. They share one set of
 *  policies (scoped by `bucket_id in (...)`) precisely so the three cannot
 *  drift apart: reachability is `can_see_attachment` in all three. */
export const ATTACHMENT_BUCKETS: Record<AttachmentOwner, string> = {
  project: "project-files",
  task: "task-files",
  message: "message-files",
};

const BUCKET_IDS = new Set(Object.values(ATTACHMENT_BUCKETS));

/** How long a signed URL stays good. Long enough that a document a user
 *  opens and edits for an hour still downloads, short enough that a link
 *  pasted somewhere it should not be goes stale the same day. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

export interface StorageRef {
  bucket: string;
  path: string;
}

/** Splits `"<bucket>/<attachment-id>"`. Returns null for anything that is not
 *  one of our three buckets, so a malformed or hand-edited reference fails
 *  closed instead of addressing an unrelated bucket. */
export function parseRef(ref: string): StorageRef | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const bucket = ref.slice(0, slash);
  const path = ref.slice(slash + 1);
  if (!BUCKET_IDS.has(bucket) || path.length === 0) return null;
  return { bucket, path };
}

export function makeRef(owner: AttachmentOwner, attachmentId: string): string {
  return `${ATTACHMENT_BUCKETS[owner]}/${attachmentId}`;
}

/**
 * Row, then bytes. Resolves with the reference to store in
 * `Attachment.dataUrl`.
 *
 * If the upload fails the row is removed again, because a row with no object
 * behind it is a file that lists in the UI and 404s when opened — the silent
 * half-write this plan has spent a week removing. The uploader can always
 * delete their own row (`attachments_delete`), so that cleanup cannot itself
 * be refused for a permission reason.
 */
export async function uploadAttachment(
  client: LuminaClient,
  owner: AttachmentOwner,
  attachment: Attachment,
  file: Blob
): Promise<string> {
  const ref = makeRef(owner, attachment.id);
  const parsed = parseRef(ref)!;

  const row = await client.from("attachments").insert({
    id: attachment.id,
    storage_path: ref,
    name: attachment.name,
    size: attachment.size,
    mime: attachment.type,
    uploaded_by: attachment.uploadedBy,
    uploaded_at: new Date(attachment.uploadedAt).toISOString(),
  });
  if (row.error) fail(`uploading ${attachment.name}`, row.error);

  const put = await client.storage.from(parsed.bucket).upload(parsed.path, file, {
    contentType: attachment.type || "application/octet-stream",
    upsert: false,
  });
  if (put.error) {
    await client.from("attachments").delete().eq("id", attachment.id);
    throw new Error(`uploading ${attachment.name} failed: ${put.error.message}`);
  }
  return ref;
}

/**
 * Replaces the bytes behind an existing attachment and re-stamps the row.
 * This is the in-app editors' save path, and the one operation that names a
 * permission of its own: `attachments_update` and the Storage UPDATE policy
 * both require `project.create`, which is what `updateProject` guards on.
 *
 * **`update`, not `upload({ upsert: true })`.** They put the same bytes at the
 * same path, and Postgres treats them completely differently: an upsert is an
 * INSERT with a conflict clause, so storage.objects evaluates
 * `attachment_objects_insert` — `is_attachment_uploader` — and never reaches
 * `attachment_objects_update`. The result was that only the person who
 * uploaded a file could ever save it, and a file whose uploader had left the
 * workspace (`uploaded_by` nulled) became permanently unsaveable by anybody.
 * A PUT takes the UPDATE policy, which is the rule that was written for this
 * operation: visible to you, and you hold `project.create`.
 *
 * **The row first, the bytes second — the reverse of what this used to do.**
 * The row UPDATE is the permission-bearing statement (`attachments_update`
 * names the same `project.create` the object policy does), so doing it first
 * means a refusal is discovered while the previous contents are still there.
 * The old order destroyed the file and *then* found out the save was not
 * allowed, with no version history to recover from — the one irreversible
 * step ran before anything was known to have succeeded. Neither column being
 * written is an input to `can_see_attachment`, so this order cannot make the
 * caller lose sight of the row mid-write.
 *
 * If the bytes are refused after the row landed, the stamp is put back. That
 * leaves the file exactly as it was, which is the honest answer to a save
 * that did not happen; the alternative — a fresh size and editor over the old
 * contents — is a lie about what the file contains.
 */
export async function overwriteAttachment(
  client: LuminaClient,
  attachment: Attachment,
  ref: string,
  file: Blob,
  editedBy: string,
  editedAt: number
): Promise<void> {
  const parsed = parseRef(ref);
  if (!parsed) throw new Error(`saving ${attachment.name} failed: unknown storage location`);

  // The stamp this save replaces, so it can be put back if the bytes are
  // refused. A row the caller cannot see reads as absent, which is a refusal
  // rather than an empty result.
  const before = await client
    .from("attachments")
    .select("size,edited_by,edited_at")
    .eq("id", attachment.id)
    .maybeSingle();
  if (before.error) fail(`saving ${attachment.name}`, before.error);
  if (!before.data) {
    throw new Error(`saving ${attachment.name} failed: that file is no longer available`);
  }

  const row = await client
    .from("attachments")
    .update({
      size: file.size,
      edited_by: editedBy,
      edited_at: new Date(editedAt).toISOString(),
    })
    .eq("id", attachment.id)
    .select("id");
  if (row.error) fail(`saving ${attachment.name}`, row.error);
  if (!row.data || row.data.length === 0) {
    throw new Error(`saving ${attachment.name} failed: you don't have permission to edit this file`);
  }

  const put = await client.storage.from(parsed.bucket).update(parsed.path, file, {
    contentType: attachment.type || "application/octet-stream",
  });
  if (put.error) {
    // Best-effort: the save failed, so the row must not claim otherwise.
    await client
      .from("attachments")
      .update({
        size: before.data.size,
        edited_by: before.data.edited_by,
        edited_at: before.data.edited_at,
      })
      .eq("id", attachment.id);
    throw new Error(`saving ${attachment.name} failed: ${put.error.message}`);
  }
}

/**
 * Bytes, then row — see the file header and the migration for why that order
 * is the only safe one.
 *
 * `remove()` reports a filtered-away delete the way every other PostgREST
 * statement in this directory does: `error: null` and an EMPTY array. Reading
 * that as success is the false-success class `requireRows` exists for, so it
 * is checked here by hand. Verified live against lumina-dev: a member without
 * `project.delete` who is not the uploader gets exactly `data: []`, no error.
 *
 * An object that is already gone (a row whose upload never completed) is not
 * an error — the goal is that it is absent, and it is.
 */
export async function deleteAttachments(
  client: LuminaClient,
  attachments: Array<Pick<Attachment, "id" | "name" | "dataUrl">>
): Promise<void> {
  for (const attachment of attachments) {
    const parsed = parseRef(attachment.dataUrl);
    if (parsed) {
      const gone = await client.storage.from(parsed.bucket).remove([parsed.path]);
      if (gone.error) {
        throw new Error(`removing ${attachment.name} failed: ${gone.error.message}`);
      }
      if ((gone.data ?? []).length === 0) {
        const exists = await client
          .from("attachments")
          .select("id")
          .eq("id", attachment.id);
        // The object is unreachable AND the row is still there: a refusal,
        // not an already-deleted file.
        if (!exists.error && (exists.data ?? []).length > 0) {
          throw new Error(
            `removing ${attachment.name} failed: only the person who uploaded it, or someone who can delete projects, can remove it`
          );
        }
      }
    }
  }

  const ids = attachments.map((a) => a.id);
  if (ids.length === 0) return;
  const rows = await client.from("attachments").delete().in("id", ids).select("id");
  if (rows.error) fail("removing that file", rows.error);
}

/**
 * A URL the browser can put in `src`/`href`. Signed, because the buckets are
 * private and storage-api evaluates the SELECT policy as the requesting user
 * before it issues one — so a person who cannot see the parent project cannot
 * obtain a link at all, never mind follow one.
 */
export async function signedUrl(
  client: LuminaClient,
  ref: string,
  downloadName?: string
): Promise<string> {
  const parsed = parseRef(ref);
  if (!parsed) throw new Error("That file has no storage location.");
  const { data, error } = await client.storage
    .from(parsed.bucket)
    .createSignedUrl(
      parsed.path,
      SIGNED_URL_TTL_SECONDS,
      downloadName ? { download: downloadName } : undefined
    );
  if (error || !data) {
    throw new Error(error?.message ?? "That file is no longer available.");
  }
  return data.signedUrl;
}

/**
 * The bytes themselves as a `data:` URL, for the document editors — they
 * parse a file rather than display it, and every one of them already speaks
 * `data:` URLs. That is the whole reason their internals need no change: the
 * load end hands them exactly what `readFileAsAttachment` used to.
 */
export async function downloadAttachment(
  client: LuminaClient,
  ref: string,
  mime: string
): Promise<string> {
  const parsed = parseRef(ref);
  if (!parsed) throw new Error("That file has no storage location.");
  const { data, error } = await client.storage.from(parsed.bucket).download(parsed.path);
  if (error || !data) {
    throw new Error(error?.message ?? "That file is no longer available.");
  }
  return blobToDataUrl(data, mime);
}

function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const out = String(reader.result);
      // Storage answers with the content type it was given at upload, and
      // `application/octet-stream` for anything it was not told. The editors
      // dispatch on the data URL's own header, so restore the type the
      // attachments row records rather than letting a generic one through.
      const generic = "data:application/octet-stream";
      resolve(mime && out.startsWith(generic) ? `data:${mime}${out.slice(generic.length)}` : out);
    };
    reader.onerror = () => reject(new Error("Couldn't read the downloaded file."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Links already-uploaded bytes to the row that owns them, and deletes the ones
 * the caller explicitly dropped. Shared by projects and tasks, whose join
 * tables differ only in their two column names.
 *
 * A removed file is deleted outright (bytes and row), not merely unlinked: an
 * unlinked row falls back to `can_see_attachment`'s uploader branch, so
 * "removed from the project" would quietly mean "still readable by whoever
 * put it there". The link row goes with it via `on delete cascade`.
 *
 * **`removedIds` is the ONLY thing that can delete a file, and that is the
 * whole point of this signature.** Until QA-101 this function took `next` as
 * the complete, current attachment set and destroyed anything linked on the
 * server but missing from it. No caller has a current set: a task dialog holds
 * the snapshot it took when it opened, and the projects page holds the one its
 * render closed over. So a colleague attaching a file to a task while somebody
 * had that task's dialog open lost it — bytes and row, irrecoverably — the
 * moment the dialog was saved, even to change only the title. Two people on
 * one project is the normal case, not a corner.
 *
 * `next` is therefore read as "these are linked", never as "only these are
 * linked": it can add links and can say nothing at all about removal. A file
 * missing from a stale array is simply a file this caller did not know about,
 * which is the truth, and the next hydrate brings it back onto their screen.
 * Deleting bytes because they were absent from an array is not a thing this
 * function can do any more.
 */
export async function syncAttachmentLinks(
  client: LuminaClient,
  kind: "project" | "task",
  ownerId: string,
  next: Attachment[],
  what: string,
  /** The files this caller deliberately removed, named by the UI that removed
   *  them. Defaults to none: a caller that says nothing removes nothing. */
  removedIds: string[] = []
): Promise<void> {
  // Written out per table rather than parameterised: PostgREST's generated
  // Insert types are per-table, and a computed column name erases exactly the
  // check that catches a typo in one.
  const current =
    kind === "project"
      ? await client.from("project_attachments").select("attachment_id").eq("project_id", ownerId)
      : await client.from("task_attachments").select("attachment_id").eq("task_id", ownerId);
  if (current.error) fail(what, current.error);

  const before = new Set((current.data ?? []).map((r) => r.attachment_id));

  const added = next.filter((a) => !before.has(a.id));
  // Intersected with what is actually linked, so a removal that already landed
  // (the same file dropped from two tabs) is not a second delete of bytes that
  // have already gone.
  const removedIdsToDelete = removedIds.filter((id) => before.has(id));

  if (added.length > 0) {
    const links =
      kind === "project"
        ? await client
            .from("project_attachments")
            .insert(added.map((a) => ({ project_id: ownerId, attachment_id: a.id })))
        : await client
            .from("task_attachments")
            .insert(added.map((a) => ({ task_id: ownerId, attachment_id: a.id })));
    if (links.error) fail(what, links.error);
  }

  if (removedIdsToDelete.length > 0) {
    // The rows carry the storage reference; the patch no longer does, since
    // the whole point is that these are the files it dropped.
    const rows = await client
      .from("attachments")
      .select("id,name,storage_path")
      .in("id", removedIdsToDelete);
    if (rows.error) fail(what, rows.error);
    await deleteAttachments(
      client,
      (rows.data ?? []).map((r) => ({ id: r.id, name: r.name, dataUrl: r.storage_path }))
    );
  }
}
