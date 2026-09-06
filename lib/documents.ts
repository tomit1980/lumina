import type { Attachment } from "./types";

/** What Lumina can do with a file, decided by extension first, MIME second.
 *  Keep this module dependency-free: it's imported by list rows everywhere.
 *  The heavy libraries (SheetJS, mammoth, docx, TipTap) live in the editors,
 *  which are loaded on demand. */
export type DocumentKind =
  | "markdown"
  | "text"
  | "spreadsheet"
  | "word"
  | "pdf"
  | "image"
  | "other";

const EXT_KIND: Record<string, DocumentKind> = {
  md: "markdown",
  markdown: "markdown",
  txt: "markdown",
  json: "text",
  yml: "text",
  yaml: "text",
  xml: "text",
  html: "text",
  css: "text",
  js: "text",
  ts: "text",
  tsx: "text",
  py: "text",
  sql: "text",
  log: "text",
  csv: "spreadsheet",
  xlsx: "spreadsheet",
  xlsm: "spreadsheet",
  xls: "spreadsheet",
  docx: "word",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
};

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function documentKind(a: Pick<Attachment, "name" | "type">): DocumentKind {
  const byExt = EXT_KIND[extensionOf(a.name)];
  if (byExt) return byExt;
  if (a.type.startsWith("image/")) return "image";
  if (a.type === "application/pdf") return "pdf";
  if (a.type.startsWith("text/")) return "text";
  return "other";
}

export const EDITABLE_KINDS: readonly DocumentKind[] = ["markdown", "text", "spreadsheet", "word"];

export function isEditable(kind: DocumentKind): boolean {
  return EDITABLE_KINDS.includes(kind);
}

/** Editable kinds plus the read-only viewers. */
export function canOpen(kind: DocumentKind): boolean {
  return isEditable(kind) || kind === "pdf" || kind === "image";
}

export const KIND_META: Record<DocumentKind, { label: string }> = {
  markdown: { label: "Document" },
  text: { label: "Text" },
  spreadsheet: { label: "Spreadsheet" },
  word: { label: "Word" },
  pdf: { label: "PDF" },
  image: { label: "Image" },
  other: { label: "File" },
};

export const MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function mimeFor(name: string): string {
  return MIME[extensionOf(name)] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// data: URL helpers (everything is stored as base64 data URLs in localStorage)

function splitDataUrl(dataUrl: string): { mime: string; base64: string } {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const mime = header.slice(5, header.indexOf(";") > 0 ? header.indexOf(";") : undefined);
  return { mime, base64: dataUrl.slice(comma + 1) };
}

export function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const { base64 } = splitDataUrl(dataUrl);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function dataUrlToText(dataUrl: string): string {
  return new TextDecoder("utf-8").decode(dataUrlToArrayBuffer(dataUrl));
}

export function arrayBufferToDataUrl(buf: ArrayBuffer | Uint8Array, mime: string): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

export function textToDataUrl(text: string, mime: string): string {
  return arrayBufferToDataUrl(new TextEncoder().encode(text), mime);
}

/** Decoded byte length of a data URL, without decoding it. */
export function dataUrlByteLength(dataUrl: string): number {
  const { base64 } = splitDataUrl(dataUrl);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** A one-sheet empty workbook. Loads SheetJS on demand. */
export async function emptySpreadsheetDataUrl(): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[""]]), "Sheet1");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return arrayBufferToDataUrl(out, MIME.xlsx);
}

/** Ensure a user-typed file name carries the expected extension. */
export function withExtension(name: string, ext: string): string {
  const trimmed = name.trim().replace(/[\\/:*?"<>|]/g, "-") || "Untitled";
  return extensionOf(trimmed) === ext ? trimmed : `${trimmed}.${ext}`;
}
