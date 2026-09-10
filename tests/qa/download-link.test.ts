// @vitest-environment jsdom
//
// QA-106 (Medium) — Download was a dead anchor whenever a signed URL was
// pending or unobtainable.
//
// Every download control was `<a href={maybeUndefined}>`. React omits an
// `undefined` href entirely, and an `<a>` without one is not a link: no
// focus, no pointer cursor, and a click that does nothing at all. So Download
// was inert for the few hundred milliseconds it takes to mint a signed URL,
// and inert forever if signing was refused — with no spinner, no disabled
// state and no message. "The button does nothing when you click it" is this
// project's own stated defining bug class.
//
// The regression this guards against is subtle and worth naming: it is NOT
// "the URL is missing". It is "the URL is missing AND the control still looks
// and behaves like a working one". So the assertions are about what the DOM
// offers the user, not about the href.
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import { DownloadLink } from "@/components/download-link";
import type { AttachmentUrlState } from "@/components/attachment-url";

afterEach(cleanup);

const READY: AttachmentUrlState = { url: "https://example.test/f", pending: false, failed: false };
const PENDING: AttachmentUrlState = { url: undefined, pending: true, failed: false };
const FAILED: AttachmentUrlState = { url: undefined, pending: false, failed: true };

function renderLink(state: AttachmentUrlState) {
  return render(
    React.createElement(DownloadLink, {
      state,
      fileName: "payroll.xlsx",
      "aria-label": "Download payroll.xlsx",
      children: "Download",
    })
  );
}

describe("a Download whose link is not ready (QA-106)", () => {
  it("CONTROL: a ready link is a real anchor that actually goes somewhere", () => {
    // First, because everything below is a negative and a component that
    // rendered nothing would satisfy all of them.
    const { container } = renderLink(READY);
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute("href", "https://example.test/f");
    expect(anchor).toHaveAttribute("download", "payroll.xlsx");
  });

  it("while the link is being minted, does not present itself as a working link", () => {
    const { container } = renderLink(PENDING);

    // THE ASSERTION. Before the fix this rendered an <a> with no href — which
    // looks identical to a working control and does nothing.
    expect(container.querySelector("a")).toBeNull();
    const control = screen.getByRole("button", { name: "Download payroll.xlsx" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAttribute("aria-busy", "true");
    expect(control).toHaveAttribute("title", expect.stringContaining("Preparing"));
  });

  it("when signing failed, says so rather than staying silently dead forever", () => {
    const { container } = renderLink(FAILED);

    expect(container.querySelector("a")).toBeNull();
    const control = screen.getByRole("button", { name: "Download payroll.xlsx" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    // Not busy — nothing is coming. This is the state that used to last
    // forever with no indication at all.
    expect(control).not.toHaveAttribute("aria-busy");
    expect(control.getAttribute("title")).toContain("couldn't be prepared");
  });
});
