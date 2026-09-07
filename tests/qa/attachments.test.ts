// @vitest-environment jsdom
//
// Suite A7 — lib/attachments.ts and lib/documents.ts: the 3 MB per-file cap,
// batch-upload skip behavior, resolving a message's shared-from-project
// attachment reference, exact decoded byte-length accounting, and the
// data-URL round-trip surviving multi-byte text and the 0x8000 chunk
// boundary in lib/documents.ts.
import { describe, expect, it } from "vitest";

import {
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  readFileAsAttachment,
  resolveMessageAttachment,
} from "@/lib/attachments";
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

describe("readFileAsAttachment — the 3 MB cap", () => {
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
