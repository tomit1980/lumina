import { uid } from "./store";
import type { AppState, Attachment, MessageAttachment } from "./types";

/** There's no backend — every file is base64-encoded straight into
 *  localStorage, so we cap individual uploads to keep the whole workspace
 *  well under typical browser storage quotas (~5–10 MB). */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type ReadFileResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; error: string };

/** Reads a File into an Attachment, enforcing the size cap. */
export function readFileAsAttachment(
  file: File,
  uploaderId: string
): Promise<ReadFileResult> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.resolve({
      ok: false,
      error: `${file.name} is ${formatBytes(file.size)} — max is ${formatBytes(MAX_ATTACHMENT_BYTES)} per file.`,
    });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        ok: true,
        attachment: {
          id: uid("att"),
          name: file.name,
          size: file.size,
          type: file.type,
          dataUrl: String(reader.result),
          uploadedBy: uploaderId,
          uploadedAt: Date.now(),
        },
      });
    };
    reader.onerror = () => resolve({ ok: false, error: `Couldn't read ${file.name}.` });
    reader.readAsDataURL(file);
  });
}

/** A message attachment shared from a project carries no bytes of its own —
 *  look them up on the source project. Returns null if the file has since been
 *  removed from that project. Composer uploads resolve to themselves. */
export function resolveMessageAttachment(
  state: Pick<AppState, "projects">,
  att: MessageAttachment
): Attachment | null {
  if (!att.sourceProjectId) return att;
  const project = state.projects.find((p) => p.id === att.sourceProjectId);
  return project?.attachments.find((a) => a.id === att.id) ?? null;
}
