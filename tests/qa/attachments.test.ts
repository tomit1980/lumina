// @vitest-environment jsdom
//
// Suite A7 — lib/attachments.ts and lib/documents.ts: the per-file cap,
// batch-upload skip behavior, resolving a message's shared-from-project
// attachment reference, exact decoded byte-length accounting, and the
// data-URL round-trip surviving multi-byte text and the 0x8000 chunk
// boundary in lib/documents.ts.
import { describe, expect, it, vi } from "vitest";

import {
  attachmentBytes,
  attachmentUrl,
  createAttachmentFromDataUrl,
  discardAttachment,
  formatBytes,
  isStorageRef,
  MAX_ATTACHMENT_BYTES,
  readFileAsAttachment,
  resolveMessageAttachment,
  saveAttachmentBytes,
} from "@/lib/attachments";
import { backendKind } from "@/lib/backend";
import { LocalBackend } from "@/lib/backend/local";
import { FailingBackend } from "./_support";
import {
  arrayBufferToDataUrl,
  dataUrlByteLength,
  dataUrlToText,
  textToDataUrl,
} from "@/lib/documents";
import type { AppState, MessageAttachment, Project } from "@/lib/types";

function makeFile(name: string, bytes: number, type = "text/plain"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("readFileAsAttachment — the per-file cap", () => {
  it("a file at or under the cap is read into a structured Attachment", async () => {
    const file = makeFile("small.txt", 1024);
    const result = await readFileAsAttachment(file, "u_vlad");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachment.name).toBe("small.txt");
      expect(result.attachment.size).toBe(1024);
      expect(result.attachment.uploadedBy).toBe("u_vlad");
      expect(result.attachment.dataUrl.startsWith("data:text/plain")).toBe(true);
    }
  });

  it("a file exactly at MAX_ATTACHMENT_BYTES is accepted (the cap is inclusive)", async () => {
    const file = makeFile("exact.txt", MAX_ATTACHMENT_BYTES);
    const result = await readFileAsAttachment(file, "u_vlad");
    expect(result.ok).toBe(true);
  });

  it("a file one byte over the cap returns a structured error rather than throwing", async () => {
    const file = makeFile("toobig.txt", MAX_ATTACHMENT_BYTES + 1);
    const result = await readFileAsAttachment(file, "u_vlad");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("toobig.txt");
      expect(result.error).toContain("max is");
    }
  });
});

describe("batch upload — keeps every file that fits, skips only the oversized ones", () => {
  it("mixed batch: small files are kept in order, oversized ones are skipped", async () => {
    const files = [
      makeFile("a.txt", 100),
      makeFile("too-big.bin", MAX_ATTACHMENT_BYTES + 500),
      makeFile("b.txt", 200),
    ];
    const kept: string[] = [];
    const errors: string[] = [];
    for (const file of files) {
      const result = await readFileAsAttachment(file, "u_vlad");
      if (result.ok) kept.push(result.attachment.name);
      else errors.push(result.error);
    }
    expect(kept).toEqual(["a.txt", "b.txt"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("too-big.bin");
  });

  it("a batch of entirely oversized files keeps none", async () => {
    const files = [makeFile("x.bin", MAX_ATTACHMENT_BYTES + 1), makeFile("y.bin", MAX_ATTACHMENT_BYTES * 2)];
    const kept: string[] = [];
    for (const file of files) {
      const result = await readFileAsAttachment(file, "u_vlad");
      if (result.ok) kept.push(result.attachment.name);
    }
    expect(kept).toHaveLength(0);
  });
});

describe("formatBytes boundaries", () => {
  it("formats under 1024 bytes as whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats 1024 bytes and above as KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("formats 1 MB as MB, not KB", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});

function attachment(id: string, overrides: Partial<Project["attachments"][number]> = {}) {
  return {
    id,
    name: "file.txt",
    size: 10,
    type: "text/plain",
    dataUrl: "data:text/plain;base64,aGVsbG8=",
    uploadedBy: "u_vlad",
    uploadedAt: Date.now(),
    ...overrides,
  };
}

function stateWithProject(project: Partial<Project> & { id: string }): Pick<AppState, "projects"> {
  return {
    projects: [
      {
        name: "P",
        description: "",
        emoji: "📁",
        color: "#000000",
        createdFromTaskSetId: null,
        priority: "medium",
        restricted: false,
        members: [],
        attachments: [],
        createdBy: "u_vlad",
        createdAt: Date.now(),
        ...project,
      },
    ],
  };
}

describe("resolveMessageAttachment — shared-from-project references", () => {
  it("resolves to the project's live file for a message attachment referencing it", () => {
    const live = attachment("att1", { name: "current-name.txt" });
    const state = stateWithProject({ id: "p1", attachments: [live] });
    const ref: MessageAttachment = { ...live, dataUrl: "", sourceProjectId: "p1" };
    const resolved = resolveMessageAttachment(state, ref);
    expect(resolved).toEqual(live);
  });

  it("returns null once the referenced file has been deleted from the project", () => {
    const state = stateWithProject({ id: "p1", attachments: [] }); // file removed
    const ref: MessageAttachment = {
      ...attachment("att1"),
      dataUrl: "",
      sourceProjectId: "p1",
    };
    expect(resolveMessageAttachment(state, ref)).toBeNull();
  });

  it("returns the attachment itself (composer upload) when there's no sourceProjectId", () => {
    const state = stateWithProject({ id: "p1", attachments: [] });
    const own = attachment("att2");
    expect(resolveMessageAttachment(state, own)).toEqual(own);
  });

  it("Task 10: a share that carries its own Storage path resolves to itself, project or no project", () => {
    // On the real backend the message row already carries the file's location
    // and the SERVER has decided this reader may follow it —
    // `can_see_attachment` reaches a shared file through the MESSAGE, which is
    // what "Share to chat" means. Resolving through the project instead would
    // hide a file from everyone who cannot see the project it came from, which
    // is precisely the set of people it was shared with.
    const shared: MessageAttachment = {
      ...attachment("att3", { dataUrl: "project-files/att3" }),
      sourceProjectId: "p_restricted",
    };
    const state = stateWithProject({ id: "p1", attachments: [] }); // no p_restricted
    expect(resolveMessageAttachment(state, shared)).toEqual(shared);
  });
});

describe("dataUrlByteLength — matches the real decoded byte length, including padding", () => {
  const cases = [
    { bytes: 1, label: "1 byte (== padding)" },
    { bytes: 2, label: "2 bytes (= padding)" },
    { bytes: 3, label: "3 bytes (no padding)" },
    { bytes: 4, label: "4 bytes (== padding, second group)" },
    { bytes: 100, label: "100 bytes" },
  ];
  for (const { bytes, label } of cases) {
    it(`${label}`, () => {
      const url = arrayBufferToDataUrl(new Uint8Array(bytes).fill(65), "text/plain");
      expect(dataUrlByteLength(url)).toBe(bytes);
    });
  }
});

describe("data-URL round-trip in lib/documents.ts", () => {
  it("survives multi-byte UTF-8: emoji, Hebrew, and CJK", () => {
    const text = "Hello 👋🚀 שלום עולם 你好世界 🎉";
    const url = textToDataUrl(text, "text/plain");
    expect(dataUrlToText(url)).toBe(text);
    expect(dataUrlByteLength(url)).toBe(new TextEncoder().encode(text).length);
  });

  it("survives content larger than the 0x8000 (32768) chunk boundary in arrayBufferToDataUrl", () => {
    const text = "x".repeat(0x8000 * 2 + 137); // spans multiple chunks with an odd remainder
    const url = textToDataUrl(text, "text/plain");
    expect(dataUrlToText(url)).toBe(text);
    expect(dataUrlByteLength(url)).toBe(text.length);
  });

  it("survives multi-byte content that itself straddles the chunk boundary", () => {
    const text = "€".repeat(0x8000); // 3-byte UTF-8 sequences, well past 32768 bytes total
    const url = textToDataUrl(text, "text/plain");
    expect(dataUrlToText(url)).toBe(text);
  });
});


// ---------------------------------------------------------------------------
// Task 10 — the bytes moved to Storage. Everything below drives the seam
// rather than a live backend: `LocalBackend` is what the public demo really
// runs, and `FailingBackend` is how an upload is made to fail without a
// network. The unit suite holds no Supabase credentials and never will.

describe("Task 10 — the local demo path is byte-for-byte what it was", () => {
  // The plan's hardest constraint: the public site still builds on this path
  // and stores bytes inline by design. If any of these three change, the demo
  // has changed.
  it("still produces a data: URL, and the reference IS the bytes", async () => {
    const result = await readFileAsAttachment(
      new File([new TextEncoder().encode("hello")], "note.txt", { type: "text/plain" }),
      "u_vlad",
      { backend: new LocalBackend() }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.dataUrl.startsWith("data:text/plain")).toBe(true);
    expect(isStorageRef(result.attachment.dataUrl)).toBe(false);
  });

  it("resolves a data: URL to itself for both display and editing — no round trip", async () => {
    const local = new LocalBackend();
    const url = await attachmentUrl("data:text/plain;base64,aGk=", "note.txt", { backend: local });
    const bytes = await attachmentBytes("data:text/plain;base64,aGk=", "text/plain", {
      backend: local,
    });
    expect(url).toEqual({ ok: true, url: "data:text/plain;base64,aGk=" });
    expect(bytes).toEqual({ ok: true, url: "data:text/plain;base64,aGk=" });
  });

  it("keeps the cap at 3 MB locally and raises it to 10 MB on the real backend", async () => {
    // Deliberately backend-dependent, and the reason is in lib/attachments.ts:
    // the local path base64s every file into ONE localStorage key whose whole
    // budget is ~5–10 MB, so a 10 MB cap there would not let a browser hold
    // more — it would only move the failure from a clear message before the
    // read to a quota error after it, with the workspace half-written.
    //
    // ASSERTED AS LITERALS, not read back through the flag the source
    // branches on. This used to be
    //
    //     expect(MAX_ATTACHMENT_BYTES).toBe(
    //       backendKind === "supabase" ? 10 * 1024 * 1024 : 3 * 1024 * 1024)
    //
    // which is lib/attachments.ts's own ternary, on the same flag. The unit
    // environment is always `local`, so the comparison actually evaluated was
    // 3 MB === 3 MB, and the half of the claim in this test's title that is
    // most worth pinning — the 10 MB Supabase cap, a deliberate deviation —
    // could not fail. Changing the source's supabase branch to 50 MB left it
    // green.
    expect(backendKind).toBe("local");
    expect(MAX_ATTACHMENT_BYTES).toBe(3 * 1024 * 1024);
    // The Supabase branch, reached by re-importing the module under the flag
    // rather than by restating it. `vi.resetModules` is what makes the
    // module-level constant re-evaluate.
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabase");
    vi.resetModules();
    const supabaseSide = await import("@/lib/attachments");
    expect(supabaseSide.MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("discarding a local attachment is a no-op that cannot throw", async () => {
    await expect(
      discardAttachment(attachment("a1"), { backend: new LocalBackend() })
    ).resolves.toBeUndefined();
  });
});

describe("Task 10 — the upload path goes through the backend seam", () => {
  it("hands the file to putAttachment with the owner it was given, and adopts the reference", async () => {
    const backend = new FailingBackend("putActivity"); // failing something ELSE
    const result = await readFileAsAttachment(
      new File([new Uint8Array(64)], "brief.md", { type: "text/markdown" }),
      "u_maya",
      { owner: "task", backend }
    );
    expect(result.ok).toBe(true);
    expect(backend.attachmentWrites).toEqual([{ owner: "task", id: expect.any(String), bytes: 64 }]);
    if (result.ok) {
      expect(backend.attachmentWrites[0].id).toBe(result.attachment.id);
    }
  });

  it("defaults the owner to `project`, which is where the Files tab uploads", async () => {
    const backend = new FailingBackend("putActivity");
    await readFileAsAttachment(new File([new Uint8Array(4)], "x.txt"), "u_vlad", { backend });
    expect(backend.attachmentWrites[0].owner).toBe("project");
  });

  it("a generated document (New document / New spreadsheet) is stored the same way", async () => {
    const backend = new FailingBackend("putActivity");
    const result = await createAttachmentFromDataUrl(
      "data:text/markdown;base64,IyBIaQ==",
      "Notes.md",
      "text/markdown",
      "u_vlad",
      { owner: "project", backend }
    );
    expect(result.ok).toBe(true);
    // "New document" must not become the one path that writes bytes nowhere.
    expect(backend.attachmentWrites).toHaveLength(1);
    if (result.ok) expect(result.attachment.name).toBe("Notes.md");
  });

  it("REFUSES the file when the upload fails, with the same {ok:false,error} a too-big file gives", async () => {
    // The shape is the point: every caller shows `error` to the user, so an
    // upload that failed reads as a sentence rather than as a file that
    // silently never appears. Both failure modes take the same branch.
    const backend = new FailingBackend("putAttachment");
    const result = await readFileAsAttachment(
      new File([new Uint8Array(8)], "budget.xlsx"),
      "u_vlad",
      { backend }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("budget.xlsx");
      expect(result.error).toContain("putAttachment failed");
    }
    const tooBig = await readFileAsAttachment(
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.bin"),
      "u_vlad",
      { backend: new LocalBackend() }
    );
    expect(tooBig.ok).toBe(false);
  });

  it("checks the cap BEFORE uploading — an oversized file never reaches the seam", async () => {
    const backend = new FailingBackend("putActivity");
    await readFileAsAttachment(
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.bin"),
      "u_vlad",
      { backend }
    );
    expect(backend.attachmentWrites).toEqual([]);
  });

  it("removing a pending composer file asks the backend to throw the bytes away", async () => {
    const backend = new FailingBackend("putActivity");
    await discardAttachment(attachment("a_pending"), { backend });
    expect(backend.attachmentDeletes).toEqual(["a_pending"]);
  });

  it("a failed discard is swallowed — the chip is already gone and there is nothing to say", async () => {
    const backend = new FailingBackend("deleteAttachment");
    // Proving the double really rejects BEFORE asserting the swallow. Without
    // this line the test passes just as happily against a FailingBackend with
    // no override at all, which is the vacuous-double trap this plan has now
    // walked into four times.
    await expect(backend.deleteAttachment(attachment("a_probe"))).rejects.toThrow(
      /deleteAttachment failed/
    );
    await expect(discardAttachment(attachment("a_pending"), { backend })).resolves.toBeUndefined();
    expect(backend.attachmentDeletes).toEqual(["a_probe", "a_pending"]);
  });
});

describe("Task 10 — saveAttachmentBytes, the document editors' save end", () => {
  it("passes the editor's data: URL through on the local path, with its real byte count", async () => {
    const result = await saveAttachmentBytes(
      attachment("a1"),
      "data:text/plain;base64,aGVsbG8=",
      "u_vlad",
      1000,
      { backend: new LocalBackend() }
    );
    expect(result).toEqual({ ok: true, dataUrl: "data:text/plain;base64,aGVsbG8=", size: 5 });
  });

  it("refuses a save over the cap without touching the backend", async () => {
    const backend = new FailingBackend("putActivity");
    // Four base64 characters per three bytes: exactly the cap, plus one more
    // group. The cap is inclusive, so "exactly" would pass.
    const big = "data:text/plain;base64," + "A".repeat(4 * (MAX_ATTACHMENT_BYTES / 3) + 4);
    const result = await saveAttachmentBytes(attachment("a1"), big, "u_vlad", 0, { backend });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("max is");
  });

  it("REFUSES the save when the backend rejects it, so `dirty` is never cleared on a lost edit", async () => {
    const result = await saveAttachmentBytes(
      attachment("a1"),
      "data:text/plain;base64,aGk=",
      "u_vlad",
      0,
      { backend: new FailingBackend("saveAttachment") }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("saveAttachment failed");
  });
});

describe("Task 10 — attachmentUrl / attachmentBytes report failure rather than a blank", () => {
  it("an empty reference is an error, not an empty URL", async () => {
    expect(await attachmentUrl("", undefined, { backend: new LocalBackend() })).toEqual({
      ok: false,
      error: "That file is no longer available.",
    });
    expect(await attachmentBytes("", "text/plain", { backend: new LocalBackend() })).toEqual({
      ok: false,
      error: "That file is no longer available.",
    });
  });

  it("a rejected signature is reported with the backend's own words", async () => {
    const result = await attachmentUrl("project-files/a1", undefined, {
      backend: new FailingBackend("attachmentUrl"),
    });
    expect(result).toEqual({ ok: false, error: "attachmentUrl failed" });
  });

  it("a rejected download is reported too — an editor must never open an empty document", async () => {
    const result = await attachmentBytes("project-files/a1", "text/plain", {
      backend: new FailingBackend("readAttachment"),
    });
    expect(result).toEqual({ ok: false, error: "readAttachment failed" });
  });
});

describe("Task 10 — isStorageRef discriminates on the reference, not on the build flag", () => {
  it("a data: URL is bytes; anything else is a location", () => {
    expect(isStorageRef("data:text/plain;base64,aGk=")).toBe(false);
    expect(isStorageRef("")).toBe(false);
    expect(isStorageRef("project-files/att_1")).toBe(true);
  });
});
