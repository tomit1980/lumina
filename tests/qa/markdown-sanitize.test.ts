// @vitest-environment jsdom
//
// QA-002 (Medium) — a shared Markdown document could beacon on open: DOMPurify
// correctly stripped script/onerror/etc, but left remote <img src> intact, so
// opening a teammate's document fetched attacker-controlled URLs (leaking the
// reader's IP/UA and the fact + time they opened it). The fix registers a
// DOMPurify afterSanitizeAttributes hook (once, at module load) that strips
// `src`/`srcset` from any <img> unless it's a data: URL.
//
// This exercises DOMPurify directly with the exact sanitize call and options
// markdown-editor.tsx uses, by importing the module (which registers the
// hook as a side effect of being loaded) and calling DOMPurify.sanitize the
// same way the component's useMemo does.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { describe, expect, it } from "vitest";

// Importing the component registers the afterSanitizeAttributes hook exactly
// once (module-level side effect — see the guarded `remoteImageHookRegistered`
// flag in the source). We don't need to render the component to exercise it.
import "@/components/documents/markdown-editor";

/** Mirrors markdown-editor.tsx's preview pipeline exactly: marked → DOMPurify
 *  with the same options, so this test exercises the real code path (raw
 *  HTML passed to `sanitize` directly is equivalent for HTML-only vectors,
 *  but markdown-syntax vectors need the marked pass first). */
function sanitize(markdownOrHtml: string): string {
  const html = marked.parse(markdownOrHtml, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

describe("markdown-editor — remote image beacon blocked (QA-002)", () => {
  it("strips src from a remote <img> and does not leave the attacker host anywhere in the output", () => {
    const out = sanitize('<img src="https://attacker.example/pixel.png">');
    expect(out).not.toContain("attacker.example");
    expect(out).not.toMatch(/src=/);
  });

  it("also strips srcset (a src-equivalent bypass) on a remote image", () => {
    const out = sanitize(
      '<img srcset="https://attacker.example/a.png 1x, https://attacker.example/b.png 2x">'
    );
    expect(out).not.toContain("attacker.example");
    expect(out).not.toMatch(/srcset=/);
  });

  it("marks the blocked image so a placeholder can render (non-empty alt / marker attribute)", () => {
    const out = sanitize('<img src="https://attacker.example/pixel.png">');
    expect(out).toMatch(/alt="[^"]+"/);
    expect(out).toContain("data-remote-image-blocked");
  });

  it("leaves a data: image untouched", () => {
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const out = sanitize(`<img src="${dataUri}">`);
    expect(out).toContain(`src="${dataUri}"`);
    expect(out).not.toContain("data-remote-image-blocked");
  });

  it("still neutralises the five previously-passing XSS vectors (no regression)", () => {
    const vectors = [
      '<img src=x onerror="alert(1)">',
      "<script>alert(1)</script>",
      '<a href="javascript:alert(1)">click</a>',
      '[link](javascript:alert(1))',
      '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
      "<svg onload=\"alert(1)\"></svg>",
    ];
    for (const v of vectors) {
      const out = sanitize(v);
      expect(out.toLowerCase()).not.toContain("<script");
      expect(out.toLowerCase()).not.toContain("onerror=");
      expect(out.toLowerCase()).not.toContain("onload=");
      expect(out.toLowerCase()).not.toContain("javascript:");
      expect(out.toLowerCase()).not.toContain("<iframe");
    }
  });

  it("legitimate formatting still survives sanitisation", () => {
    const out = sanitize("<p><strong>bold</strong> and <em>italic</em></p><ul><li>item</li></ul>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<li>item</li>");
  });
});
