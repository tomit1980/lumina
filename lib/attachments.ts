import { backendKind, createBackend, type Backend } from "./backend";
import type { AttachmentOwner } from "./backend/types";
import { uid } from "./store";
import type { AppState, Attachment, MessageAttachment } from "./types";

export type { AttachmentOwner } from "./backend/types";

/**
 * Per-file upload cap.
 *
 * 10 MB on the real backend, where the bytes go to Supabase Storage and the
 * bucket enforces the same number server-side
 * (supabase/migrations/20260910001000_storage.sql) — the client checks first
 * only so the user gets a sentence instead of a 413.
 *
 * The local demo path keeps the original 3 MB, and that is not an oversight.
 * It base64s every file into one localStorage key whose entire budget is
 * ~5–10 MB; raising the cap there would not let a browser hold more, it would
 * only move the failure from a clear "that file is too big" before the read
 * to a quota error after it, with the workspace already half-written. The
 * quota toast in `LocalBackend.persist` is the backstop for that path and
 * stays exactly where Task 1 put it — it is local-only already, so there is
 * nothing to delete: on the Supabase path `persist()` is a no-op and the
 * toast is unreachable.
 */
export const MAX_ATTACHMENT_BYTES =
  backendKind === "supabase" ? 10 * 1024 * 1024 : 3 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type ReadFileResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; error: string };

/** Where the bytes are, on this backend. `data:` means they are the reference
 *  (local demo); anything else is a Storage location to resolve. Callers ask
 *  this rather than checking `backendKind`, because a single `AppState` can
 *  hold both during a migration and the reference itself is the truth. */
export function isStorageRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("data:");
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function backendFor(opts: AttachmentOptions): Backend {
  return opts.backend ?? createBackend();
}

export interface AttachmentOptions {
  /** Which bucket the bytes go in on the real backend. Ignored locally. */
  owner?: AttachmentOwner;
  /** Test seam, mirroring `StoreProvider`'s `backend` prop. Production passes
   *  nothing and gets the backend this build was compiled against. */
  backend?: Backend;
}

/**
 * Turns a picked File into an `Attachment`, enforcing the size cap and
 * storing the bytes.
 *
 * The discriminated result is unchanged and load-bearing: every caller shows
 * `error` to the user, so a failed upload reads as "Couldn't upload
 * budget.xlsx: …" rather than as a file that silently never appears. The two
 * ways this can fail — too big, and the store refused it — deliberately
 * produce the same shape.
 */
export async function readFileAsAttachment(
  file: File,
  uploaderId: string,
  opts: AttachmentOptions = {}
): Promise<ReadFileResult> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `${file.name} is ${formatBytes(file.size)} — max is ${formatBytes(MAX_ATTACHMENT_BYTES)} per file.`,
    };
  }
  const attachment: Attachment = {
    id: uid("att"),
    name: file.name,
    size: file.size,
    type: file.type,
    dataUrl: "",
    uploadedBy: uploaderId,
    uploadedAt: Date.now(),
  };
  try {
    const dataUrl = await backendFor(opts).putAttachment(
      opts.owner ?? "project",
      attachment,
      file
    );
    return { ok: true, attachment: { ...attachment, dataUrl } };
  } catch (err) {
    return { ok: false, error: `Couldn't upload ${file.name}: ${reason(err)}` };
  }
}

/**
 * The same thing for a file Lumina generates rather than the user picking it
 * — the "New document" / "New spreadsheet" buttons on a project. Same result
 * shape, same cap, same storage path.
 */
export async function createAttachmentFromDataUrl(
  dataUrl: string,
  name: string,
  mime: string,
  uploaderId: string,
  opts: AttachmentOptions = {}
): Promise<ReadFileResult> {
  const blob = dataUrlToBlob(dataUrl, mime);
  return readFileAsAttachment(
    new File([blob], name, { type: mime }),
    uploaderId,
    opts
  );
}

/**
 * Saves new bytes over an existing attachment — the in-app editors' Save.
 * Resolves with the reference to store in `dataUrl`, which on the Supabase
 * path is the SAME path it already had (the object is overwritten in place,
 * so every link and every copy of the reference stays valid) and locally is
 * the new `data:` URL.
 */
export async function saveAttachmentBytes(
  attachment: Attachment,
  dataUrl: string,
  editedBy: string,
  editedAt: number,
  opts: AttachmentOptions = {}
): Promise<{ ok: true; dataUrl: string; size: number } | { ok: false; error: string }> {
  const blob = dataUrlToBlob(dataUrl, attachment.type);
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `This file is ${formatBytes(blob.size)} — max is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
    };
  }
  try {
    const stored = await backendFor(opts).saveAttachment(
      attachment,
      blob,
      editedBy,
      editedAt
    );
    return { ok: true, dataUrl: stored, size: blob.size };
  } catch (err) {
    return { ok: false, error: reason(err) };
  }
}

/**
 * Throws away bytes that never became part of anything — a file taken back
 * out of the chat composer before the message was sent. Best-effort by
 * design: the user has already seen the chip disappear, and there is nothing
 * to tell them if the cleanup of a file they abandoned does not land.
 */
export async function discardAttachment(
  attachment: Attachment,
  opts: AttachmentOptions = {}
): Promise<void> {
  try {
    await backendFor(opts).deleteAttachment(attachment);
  } catch {
    // Deliberately swallowed — see above.
  }
}

/**
 * A URL the browser can put in `src`/`href`, and the bytes for the editors.
 *
 * On the local path both are the `data:` URL itself, so these are pure
 * functions of their argument and the demo does no work it did not do before.
 * On the Supabase path a signed URL is minted per reference; the buckets are
 * private, and storage-api evaluates the SELECT policy as the requesting user
 * before issuing one, so someone who cannot see the parent project cannot
 * obtain a link at all.
 */
export type UrlResult = { ok: true; url: string } | { ok: false; error: string };

export async function attachmentUrl(
  ref: string,
  downloadName?: string,
  opts: AttachmentOptions = {}
): Promise<UrlResult> {
  if (!ref) return { ok: false, error: "That file is no longer available." };
  try {
    return { ok: true, url: await backendFor(opts).attachmentUrl(ref, downloadName) };
  } catch (err) {
    return { ok: false, error: reason(err) };
  }
}

/** The file's bytes as a `data:` URL — what the three document editors parse.
 *  Their load end asks for this instead of reading `attachment.dataUrl`
 *  directly; nothing else about them changes. */
export async function attachmentBytes(
  ref: string,
  mime: string,
  opts: AttachmentOptions = {}
): Promise<UrlResult> {
  if (!ref) return { ok: false, error: "That file is no longer available." };
  try {
    return { ok: true, url: await backendFor(opts).readAttachment(ref, mime) };
  } catch (err) {
    return { ok: false, error: reason(err) };
  }
}

/** A message attachment carries no bytes of its own when it was shared out of
 *  a project's Files tab on the local path: `dataUrl` is empty and the bytes
 *  are looked up live on the source project, so nothing is stored twice.
 *
 *  On the Supabase path there is nothing to look up — the reference is a
 *  Storage path the server already decided this reader may follow
 *  (`can_see_attachment` reaches a shared file through the *message*, which
 *  is the point of sharing it) — so the reference resolves to itself. That
 *  branch is why a file shared out of a restricted project stays readable to
 *  the people it was shared with, which is what "Share to chat" means.
 *
 *  The local branch below is untouched: locally a share still has an empty
 *  `dataUrl` and still resolves through the project, returning null once the
 *  file is removed from it. */
export function resolveMessageAttachment(
  state: Pick<AppState, "projects">,
  att: MessageAttachment
): Attachment | null {
  if (att.dataUrl) return att;
  if (!att.sourceProjectId) return att;
  const project = state.projects.find((p) => p.id === att.sourceProjectId);
  return project?.attachments.find((a) => a.id === att.id) ?? null;
}

// ---------------------------------------------------------------------------
// data: URL <-> Blob. Kept here rather than in lib/documents.ts because that
// module is imported by list rows everywhere and is deliberately dependency-
// free; these are only needed where bytes actually move.

function dataUrlToBlob(dataUrl: string, fallbackMime: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const semi = header.indexOf(";");
  const mime = comma > 0 ? header.slice(5, semi > 0 ? semi : undefined) : "";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || fallbackMime || "application/octet-stream" });
}

