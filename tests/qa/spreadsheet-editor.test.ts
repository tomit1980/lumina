// @vitest-environment jsdom
//
// QA-003 (Critical) — pressing Enter in a spreadsheet cell used to discard
// the edit: the Enter handler only called `blur()` and relied on `onBlur` to
// commit, which empirically never fired in a real browser. The fix commits
// directly on Enter. This renders the real SpreadsheetEditor component (no
// StoreProvider/document-page needed — it's self-contained) and drives the
// actual DOM input + keydown event, so it exercises the same code path a
// user does.
import * as React from "react";
import * as XLSX from "xlsx";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpreadsheetEditor } from "@/components/documents/spreadsheet-editor";
import { dataUrlToArrayBuffer, emptySpreadsheetDataUrl, MIME } from "@/lib/documents";
import type { DocumentEditorHandle } from "@/components/documents/types";
import type { Attachment } from "@/lib/types";

afterEach(() => {
  cleanup();
});

async function emptyAttachment(): Promise<Attachment> {
  return {
    id: "a_sheet",
    name: "QA-Sheet.xlsx",
    size: 0,
    type: MIME.xlsx,
    dataUrl: await emptySpreadsheetDataUrl(),
    uploadedBy: "u_vlad",
    uploadedAt: Date.now(),
  };
}

describe("SpreadsheetEditor — Enter commits the cell (QA-003)", () => {
  it("fires onDirty and persists the typed value when Enter is pressed", async () => {
    const attachment = await emptyAttachment();
    const onDirty = vi.fn();
    const ref = React.createRef<DocumentEditorHandle>();

    render(
      React.createElement(SpreadsheetEditor, {
        ref,
        attachment,
        kind: "spreadsheet",
        readOnly: false,
        onDirty,
      })
    );

    const input = screen.getByRole("textbox", { name: "A1" }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "ONLYEDIT" } });
    expect(onDirty).not.toHaveBeenCalled(); // typing alone doesn't commit — only blur/Enter do

    fireEvent.keyDown(input, { key: "Enter" });

    // The bug: dirty never fired for Enter. The fix: it fires synchronously,
    // not via the (unreliable) subsequent blur.
    expect(onDirty).toHaveBeenCalledTimes(1);

    const outUrl = await ref.current!.getDataUrl();
    const outWb = XLSX.read(dataUrlToArrayBuffer(outUrl), { type: "array" });
    const cell = outWb.Sheets[outWb.SheetNames[0]]?.["A1"];
    expect(String(cell?.v ?? "")).toBe("ONLYEDIT");
  });

  it("the harmless follow-up blur does not double-fire onDirty or corrupt the value", async () => {
    const attachment = await emptyAttachment();
    const onDirty = vi.fn();
    const ref = React.createRef<DocumentEditorHandle>();

    render(
      React.createElement(SpreadsheetEditor, {
        ref,
        attachment,
        kind: "spreadsheet",
        readOnly: false,
        onDirty,
      })
    );

    const input = screen.getByRole("textbox", { name: "A1" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" }); // commits, then calls .blur()
    act(() => {
      fireEvent.blur(input); // jsdom doesn't auto-fire blur from .blur() in all cases — simulate it explicitly
    });

    // commit()'s existing `raw === current` guard makes the blur's re-commit
    // a no-op: onDirty must not have been called a second time.
    expect(onDirty).toHaveBeenCalledTimes(1);

    const outUrl = await ref.current!.getDataUrl();
    const outWb = XLSX.read(dataUrlToArrayBuffer(outUrl), { type: "array" });
    const cell = outWb.Sheets[outWb.SheetNames[0]]?.["A1"];
    expect(cell?.v).toBe(42);
  });
});
