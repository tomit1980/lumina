// @vitest-environment jsdom
//
// QA-003b (Critical) — Ctrl+S reported "Saved" having written nothing.
// document-page.tsx's save() guarded on `!file || !editorRef.current ||
// readOnly || saving` but not `dirty`, so the *keyboard* path (which bypasses
// the disabled Save button) serialised and persisted an unchanged document
// and toasted success. The fix adds `dirty` to that guard.
//
// This renders the real DocumentPage + MarkdownEditor and dispatches a real
// Ctrl+S keydown on window (the actual listener document-page.tsx installs),
// rather than calling an extracted save() function, so it exercises the same
// path QA found broken.
//
// See tests/qa/accessible-names.test.ts for why the next/navigation mock is
// needed under this repo's Vitest setup.
//
// One more infra wrinkle specific to this file: document-page.tsx loads its
// editors via `next/dynamic(..., { ssr: false })`. Next's shipped Loadable
// wrapper (node_modules/next/dist/shared/lib/lazy-dynamic/loadable.js) is a
// plain (non-forwardRef) function component, so `editorRef` ends up bound to
// the wrong thing (`editorRef.current.getDataUrl is not a function`) instead
// of the editor's imperative handle. A minimal `next/dynamic` mock that goes
// straight to `React.lazy` + `React.forwardRef` restores correct ref
// forwarding without touching any source file — the editor module itself
// (and everything it does) is untouched and still loaded for real.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    const Lazy = React.lazy(() =>
      loader().then((mod) => ({
        default: ((mod as { default?: unknown })?.default ?? mod) as React.ComponentType<
          Record<string, unknown>
        >,
      }))
    );
    const Wrapper = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) =>
      React.createElement(React.Suspense, { fallback: null }, React.createElement(Lazy, { ...props, ref }))
    );
    Wrapper.displayName = "MockedNextDynamic";
    return Wrapper;
  },
}));

import * as React from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocumentPage } from "@/components/documents/document-page";
import { textToDataUrl } from "@/lib/documents";
import { STORAGE_KEY, addProject, baseState } from "./_support";
import type { Attachment } from "@/lib/types";

afterEach(() => {
  cleanup();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

function seedProjectWithDoc() {
  let state = baseState();
  const attachment: Attachment = {
    id: "a_doc",
    name: "notes.md",
    size: 5,
    type: "text/markdown",
    dataUrl: textToDataUrl("hello", "text/markdown"),
    uploadedBy: state.currentUserId,
    uploadedAt: Date.now(),
  };
  state = addProject(state, {
    id: "p_doc",
    name: "Docs",
    createdBy: state.currentUserId,
    attachments: [attachment],
  });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const project = state.projects.find((p) => p.id === "p_doc")!;
  return { state, project };
}

async function renderDocumentPage(project: ReturnType<typeof seedProjectWithDoc>["project"]) {
  render(
    React.createElement(
      StoreProvider,
      null,
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(
          UIProvider,
          null,
          React.createElement(DocumentPage, { project, fileId: "a_doc", canManageFiles: true })
        )
      )
    )
  );
  return screen.findByPlaceholderText("# Start writing…");
}

function ctrlS() {
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
}

describe("document-page.tsx — save() honesty (QA-003b)", () => {
  it("Ctrl+S with no changes is a no-op: no success toast, storage untouched", async () => {
    const { project } = seedProjectWithDoc();
    await renderDocumentPage(project);

    const before = window.localStorage.getItem(STORAGE_KEY);
    ctrlS();
    // Flush any pending microtasks from the (would-be) async save.
    await waitFor(() => Promise.resolve());

    expect(toastMock.success).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("Ctrl+S still saves and toasts once there are real changes", async () => {
    const { project } = seedProjectWithDoc();
    const textarea = await renderDocumentPage(project);

    fireEvent.change(textarea, { target: { value: "hello, edited" } });
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    ctrlS();

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining("notes.md"));

    // The write goes through the store's persist effect, which is not
    // guaranteed to have flushed to localStorage yet even though the toast
    // has already fired — read it inside waitFor so the assertion waits for
    // the write it's asserting about instead of racing it.
    await waitFor(() => {
      const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
      const savedAttachment = persisted.projects
        .find((p: { id: string }) => p.id === "p_doc")
        .attachments.find((a: { id: string }) => a.id === "a_doc");
      expect(savedAttachment.editedAt).toBeTruthy();
    });
  });

  // Review finding 5 (fix-review.md): updateProject can now deny a write
  // (object-level manageability check) in strictly more cases than before,
  // but save() used to ignore the return value entirely, so a denied save
  // still cleared `dirty` and toasted "Saved" — the same lie QA-003b was
  // about, arriving through a different door. updateProject now returns
  // `false` on denial and save() only reports success when it returns `true`.
  it("a save the store denies leaves the document dirty and shows no Saved toast", async () => {
    let state = baseState();
    const attachment: Attachment = {
      id: "a_doc",
      name: "notes.md",
      size: 5,
      type: "text/markdown",
      dataUrl: textToDataUrl("hello", "text/markdown"),
      uploadedBy: state.currentUserId,
      uploadedAt: Date.now(),
    };
    state = addProject(state, {
      id: "p_doc",
      name: "Docs",
      createdBy: "u_sam", // not the acting user — see below
      attachments: [attachment],
    });
    // u_maya holds the seeded "member" role, which lacks project.create, so
    // updateProject's guard denies the write outright.
    state = { ...state, currentUserId: "u_maya" };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const project = state.projects.find((p) => p.id === "p_doc")!;

    const textarea = await renderDocumentPage(project);
    fireEvent.change(textarea, { target: { value: "hello, edited" } });
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    ctrlS();

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    const savedAttachment = persisted.projects
      .find((p: { id: string }) => p.id === "p_doc")
      .attachments.find((a: { id: string }) => a.id === "a_doc");
    expect(savedAttachment.editedAt).toBeUndefined();
  });
});
