import type { DocumentKind } from "@/lib/documents";
import type { Attachment } from "@/lib/types";

/** Every editor takes the file, reports edits via onDirty, and can produce the
 *  saved bytes on demand. The page shell owns Save/Download/Share. */
export interface DocumentEditorProps {
  attachment: Attachment;
  kind: DocumentKind;
  readOnly: boolean;
  onDirty: () => void;
}

export interface DocumentEditorHandle {
  /** Serialise the current content as a data: URL (same MIME family as the source). */
  getDataUrl: () => Promise<string>;
}
