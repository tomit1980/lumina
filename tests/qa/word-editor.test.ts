// @vitest-environment jsdom
//
// QA-103 (code pass) — a .docx that fails to parse opened as an empty,
// editable document that could be saved over the original.
//
// The load effect marked the editor `loaded` in a `finally`, so a file
// mammoth could not read still rendered — with its initial `content: ""` — as
// a blank page that looks like an empty document. The only signal was an
// amber toolbar link reading "Some content couldn't be imported (1)", which
// describes a TOTAL failure as a PARTIAL one and has to be clicked to reveal
// the real message. The natural response to a blank page is to type in it;
// that fires `onDirty`, which enables Save, and the save then serialises an
// essentially empty ProseMirror document over the real file in Storage, in
// place, with no version history.
//
// `DocumentPage` already distinguishes "still loading" from "failed" so that
// "an error can never be mistaken for an empty document and saved over the
// file". That guard covered the DOWNLOAD and stopped at the PARSE, which is
// where the Word editor's failure lives.
//
// ONE PIECE OF INFRASTRUCTURE, and it makes this file stronger rather than
// weaker. `mammoth`'s package maps `lib/unzip.js` to a browser
// implementation through its `browser` field, and that is the build Next
// bundles — the one that reads an `arrayBuffer`. Vitest externalises mammoth
// as a CJS node dependency, so the *node* unzip is what loads here, and it
// rejects EVERY arrayBuffer with "Could not find file in options" — which
// would make the two failure tests below pass for a reason that has nothing
// to do with the bytes. Pointing the module at the shipped browser build
// restores the real parser: a real .docx really parses, and a corrupt one
// really does not. No behaviour is stubbed.
import * as React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("mammoth", async () => {
  // No types are shipped for the browser bundle's path; its runtime shape is
  // the same module `mammoth` itself declares.
  const browser = (await import(
    /* @vite-ignore */ "mammoth/mammoth.browser.js" as string
  )) as { default?: unknown };
  return { default: browser.default ?? browser };
});

import { Document, Packer, Paragraph, TextRun } from "docx";

import { TooltipProvider } from "@/components/ui/tooltip";
import { WordEditor } from "@/components/documents/word-editor";
import { arrayBufferToDataUrl, MIME } from "@/lib/documents";
import type { DocumentEditorHandle } from "@/components/documents/types";
import type { Attachment } from "@/lib/types";

afterEach(() => {
  cleanup();
});

function attachmentFrom(dataUrl: string): Attachment {
  return {
    id: "a_word",
    name: "contract.docx",
    size: 32,
    type: MIME.docx,
    dataUrl,
    uploadedBy: "u_vlad",
    uploadedAt: Date.now(),
  };
}

/** Bytes that are not a .docx at all — a truncated or mislabelled upload. */
function unreadableDocx(): Attachment {
  const bytes = new TextEncoder().encode("PK this is not really a docx");
  return attachmentFrom(arrayBufferToDataUrl(bytes.buffer as ArrayBuffer, MIME.docx));
}

/** A real, minimal .docx, built with the same library the editor saves with.
 *  (`tiptapJsonToDocx` goes through `Packer.toBlob`, and jsdom's Blob has no
 *  `arrayBuffer()`; `toBuffer` is the same packer without that hop.) */
async function readableDocx(): Promise<Attachment> {
  const document = new Document({
    sections: [
      { children: [new Paragraph({ children: [new TextRun("REALCONTENT")] })] },
    ],
  });
  const buf = await Packer.toBuffer(document);
  return attachmentFrom(arrayBufferToDataUrl(new Uint8Array(buf), MIME.docx));
}

function renderEditor(attachment: Attachment, onDirty = vi.fn()) {
  const ref = React.createRef<DocumentEditorHandle>();
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(WordEditor, {
        ref,
        attachment,
        kind: "word" as const,
        readOnly: false,
        onDirty,
      })
    )
  );
  return { ref, onDirty };
}

describe("WordEditor — a document that could not be read is not editable (QA-103)", () => {
  it("says so plainly instead of opening a blank page, and never offers an editor to type in", async () => {
    const { onDirty } = renderEditor(unreadableDocx());

    expect(await screen.findByText("Couldn't read this document")).toBeInTheDocument();
    // Not dressed up as a partial import — that copy is the finding's own
    // "describes a total failure as a partial one".
    expect(screen.queryByText(/Some content couldn't be imported/i)).not.toBeInTheDocument();
    // No editable surface at all: nothing to type into, so nothing can make
    // the document dirty and enable Save.
    expect(document.querySelector(".ProseMirror")).toBeNull();
    expect(onDirty).not.toHaveBeenCalled();
    // And every formatting control is dead, so the toolbar cannot dirty it
    // either.
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("refuses to hand back bytes, so a save can never write emptiness over the original", async () => {
    const { ref } = renderEditor(unreadableDocx());
    await screen.findByText("Couldn't read this document");

    await expect(ref.current!.getDataUrl()).rejects.toThrow(/couldn't be read/i);
  });

  it("opens a .docx it CAN read, and hands its content back — the control", async () => {
    // Without this, the two tests above would pass against an editor that had
    // simply stopped working.
    const { onDirty } = renderEditor(await readableDocx());

    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect(screen.queryByText("Couldn't read this document")).not.toBeInTheDocument();
    expect(document.querySelector(".ProseMirror")!.textContent).toContain("REALCONTENT");
    // Editable, and NOT dirty just from opening — the second half matters
    // because `setEditable` emits an update event unless told not to, and an
    // untouched document that arrives dirty is a save waiting to happen.
    expect(document.querySelector(".ProseMirror")).toHaveAttribute("contenteditable", "true");
    expect(onDirty).not.toHaveBeenCalled();
    // (`getDataUrl` is exercised by tests/qa/document-save.test.ts; it goes
    // through `Packer.toBlob`, and jsdom's Blob has no `arrayBuffer()`.)
  });
});
