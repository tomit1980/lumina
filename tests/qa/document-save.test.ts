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

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// QA-105 needs the ONE thing the local backend cannot do: a save that has
// already replaced the file's bytes somewhere outside the workspace blob. On
// `LocalBackend` the reference IS the bytes and nothing is written until the
// project is persisted, so `saveAttachmentBytes` is stood in for — and only
// for the test that says so; every other test in this file gets the real one.
const { saveOverride } = vi.hoisted(() => ({
  saveOverride: { fn: null as null | (() => Promise<unknown>) },
}));
vi.mock("@/lib/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/attachments")>();
  return {
    ...actual,
    saveAttachmentBytes: (...args: Parameters<typeof actual.saveAttachmentBytes>) =>
      saveOverride.fn ? saveOverride.fn() : actual.saveAttachmentBytes(...args),
  };
});

import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocumentPage } from "@/components/documents/document-page";
import { textToDataUrl } from "@/lib/documents";
import { FailingBackend, STORAGE_KEY, addProject, baseState } from "./_support";
import type { Backend } from "@/lib/backend/types";
import type { Attachment, Project } from "@/lib/types";

afterEach(() => {
  cleanup();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  saveOverride.fn = null;
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

async function renderDocumentPage(
  project: ReturnType<typeof seedProjectWithDoc>["project"],
  backend?: Backend
) {
  render(
    React.createElement(
      StoreProvider,
      { backend },
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
  // The Markdown editor is a `next/dynamic` import, so this genuinely waits
  // on a chunk load. Testing Library's default is one second, which is fine
  // for this file alone and not fine when the whole suite runs in parallel —
  // it produced an intermittent failure that had nothing to do with what the
  // test asserts. Nothing here is weakened; it just waits long enough.
  return screen.findByPlaceholderText("# Start writing…", undefined, {
    timeout: 15_000,
  });
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

// QA-105 (High) — "Your change has been undone" after the file's bytes have
// already been replaced.
//
// `save()` is two writes: `saveAttachmentBytes` overwrites the object in
// Storage IN PLACE, and `updateProject` records the new size and edit stamp.
// When the second failed, the user got `commit`'s stock rollback toast —
// "We couldn't save “Docs”. Your change has been undone." — while the
// previous contents of the file were already gone and unrecoverable, and the
// header kept saying "Unsaved changes" about edits that were, by then, the
// only copy the server had. A UI claiming the opposite of what happened, on
// the one operation where the previous state cannot be got back.
describe("document-page.tsx — an honest failure after the bytes are gone (QA-105)", () => {
  it("does not claim the change was undone, and does not keep warning about edits that landed", async () => {
    const { project } = seedProjectWithDoc();
    // The bytes went to Storage and the object was replaced in place, so the
    // reference comes back unchanged and is NOT a `data:` URL — which is how
    // save() knows the old contents are already gone.
    saveOverride.fn = async () => ({
      ok: true as const,
      dataUrl: "project-files/a_doc",
      size: 13,
    });

    const textarea = await renderDocumentPage(project, new FailingBackend("updateProject"));
    fireEvent.change(textarea, { target: { value: "hello, edited" } });
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    ctrlS();

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    const description = toastMock.error.mock.calls
      .map((call) => String((call[1] as { description?: string } | undefined)?.description ?? ""))
      .join(" | ");

    // The lie.
    expect(description).not.toMatch(/undone/i);
    // The truth: the file was saved; only the project's record of it was not.
    expect(description).toMatch(/notes\.md itself was saved/i);
    expect(toastMock.success).not.toHaveBeenCalled();

    // And the same lie in the other direction — "Unsaved changes" over an
    // edit that is now the only version on the server.
    await waitFor(() =>
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
    );
  });

  it("still says the change was undone when nothing had been written yet — the control", async () => {
    // On the local backend the bytes never leave the workspace blob, so a
    // refused `updateProject` really does undo everything, and the stock
    // message is the accurate one. Without this, the test above would pass
    // against a build that had simply deleted the sentence.
    const { project } = seedProjectWithDoc();
    const textarea = await renderDocumentPage(project, new FailingBackend("updateProject"));
    fireEvent.change(textarea, { target: { value: "hello, edited" } });

    ctrlS();

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    const description = toastMock.error.mock.calls
      .map((call) => String((call[1] as { description?: string } | undefined)?.description ?? ""))
      .join(" | ");
    expect(description).toMatch(/undone/i);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// QA-108 (Medium) — a colleague's save to the same document was invisible, and
// the next save silently overwrote it.
//
// An in-place overwrite deliberately keeps the same storage path so every link
// and message referring to the file stays valid. The consequence was that
// `file.dataUrl` never changed when the CONTENTS did, and the bytes effect —
// keyed on exactly that — never re-ran. A `stale` reload brought in the
// colleague's new `size` and `editedBy`, so the header updated to "edited by
// … a few seconds ago" over content downloaded when the page opened, and the
// next save serialised the stale in-memory document over their version. No
// conflict detection, no warning, and the one visible signal was a timestamp
// that a person editing a document is not watching.
//
// `editedAt` does change on every save, which is what makes the detection
// possible at all.
// ---------------------------------------------------------------------------
describe("someone else saves the same document (QA-108)", () => {
  const page = (project: Project) =>
    React.createElement(
      StoreProvider,
      null,
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(
          UIProvider,
          null,
          React.createElement(DocumentPage, {
            project,
            fileId: "a_doc",
            canManageFiles: true,
          })
        )
      )
    );

  it("says so, instead of letting the next save quietly replace their version", async () => {
    const { project } = seedProjectWithDoc();
    // Rendered here rather than through the helper, because the whole point
    // is to change the file UNDER a component that is already mounted — a
    // second `render` would be a fresh instance that never saw the original.
    const view = render(page(project));
    const textarea = await screen.findByPlaceholderText("# Start writing…", undefined, {
      timeout: 15_000,
    });

    // Local edits, so re-reading the file is not an option — this is the case
    // that used to end in a silent overwrite.
    fireEvent.change(textarea, { target: { value: "my local rewrite" } });
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeInTheDocument());

    // A colleague saves. The storage path is unchanged — that is the whole
    // point of an in-place overwrite — so only `editedAt` and `size` move.
    const edited = {
      ...project.attachments[0],
      size: 999,
      editedBy: "u_maya",
      editedAt: Date.now() + 60_000,
    };
    await act(async () => {
      view.rerender(page({ ...project, attachments: [edited] }));
    });

    // THE ASSERTION: the page says a newer version exists. Before the fix
    // nothing did — the header showed a fresh edit stamp over stale content,
    // which suggested the opposite of the truth. Matched on the container's
    // text because the warning is assembled from several JSX children.
    await waitFor(() =>
      expect(view.container.textContent).toMatch(/newer version/i)
    );
  });

  it("CONTROL: an untouched document shows no such warning", async () => {
    // Without this, a page that always warned would satisfy the test above
    // while crying wolf on every document anyone opens.
    const { project } = seedProjectWithDoc();
    const view = render(page(project));
    await screen.findByPlaceholderText("# Start writing…", undefined, { timeout: 15_000 });

    expect(view.container.textContent).not.toMatch(/newer version/i);
  });
});
