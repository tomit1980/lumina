// @vitest-environment jsdom
//
// QA-123 (Medium) — a rejected message edit silently discarded what the user
// typed.
//
// `saveEdit` closed the edit box immediately and unconditionally. When the
// write was refused, `commit` restored the original text and toasted
// "Couldn't save" — and the rewrite the user had just composed was gone, with
// no way to recover it but memory. The composer one file over
// (components/chat/conversation.tsx) already solved exactly this: it puts the
// draft back when the send resolves falsy. This is that, for the editor.
//
// Driven through the rendered component rather than the store, because the
// harm is entirely in the UI — the store's behaviour was already correct.
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { MessageList } from "@/components/chat/conversation";
import { StoreProvider } from "@/lib/store";
import { LocalBackend, STORAGE_KEY } from "@/lib/backend/local";
import { FailingBackend, adminState, renderHydrated } from "./_support";
import type { AppState, Message } from "@/lib/types";
import type { Backend } from "@/lib/backend/types";

beforeAll(() => {
  Element.prototype.scrollTo = function scrollTo() {};
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.mockClear();
  toastMock.error.mockClear();
});

const MINE = "m_mine";

function stateWithMyMessage(): AppState {
  const state = adminState();
  const mine: Message = {
    id: MINE,
    channelId: "c_engineering",
    authorId: state.currentUserId,
    content: "the original wording",
    createdAt: Date.UTC(2026, 8, 10, 12, 0),
    reactions: [],
    attachments: [],
  };
  return { ...state, messages: [mine] };
}

async function mountList(backend: Backend) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateWithMyMessage()));
  return renderHydrated(
    React.createElement(
      StoreProvider,
      { backend },
      React.createElement(MessageList, { conversationId: "c_engineering", intro: null })
    )
  );
}

/** Opens the edit box and types a replacement, leaving the save to the caller. */
async function typeAnEdit(text: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
  const box = await screen.findByRole("textbox");
  fireEvent.change(box, { target: { value: text } });
  return box;
}

describe("an edit the store refuses (QA-123)", () => {
  it("gives the user back what they typed instead of throwing it away", async () => {
    await mountList(new FailingBackend("editMessage"));
    await typeAnEdit("the rewrite I do not want to lose");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The store rolled the message back and said so...
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());

    // ...and THE ASSERTION: the editor is open again, holding the rewrite.
    // Without the fix the box is closed, the original text is on screen, and
    // what the user wrote exists nowhere.
    const reopened = await screen.findByRole("textbox");
    expect(reopened).toHaveValue("the rewrite I do not want to lose");
  });

  it("CONTROL: an edit that lands closes the box and keeps the new text", async () => {
    // Without this, a `saveEdit` that never closed the box would satisfy the
    // test above while making editing impossible.
    const { container } = await mountList(new LocalBackend());
    await typeAnEdit("the accepted rewrite");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(within(container).queryByRole("textbox")).toBeNull()
    );
    expect(screen.getByText("the accepted rewrite")).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
