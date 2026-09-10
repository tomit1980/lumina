// @vitest-environment jsdom
//
// QA-116 (High) — a message whose author the client could not resolve was
// rendered as `state.users[0]`: a real colleague's name, avatar, colour and
// profile card, on somebody else's words. `hydrate.ts` orders profiles by
// name, so the victim was whoever sorts first in the workspace.
//
// Two ways in, and the second is routine. `messages.author_id` is
// `on delete set null`, so every message by someone who later leaves is
// re-attributed permanently. And until 20260910003000 `profiles` was not in
// the realtime publication, so a new teammate's first message arrived at every
// open tab carrying an author_id that tab had never seen — confirmed against
// lumina-dev with a control on the same socket (a published table's change
// arrived; the profile change did not). It was the one finding in the pass
// with no window: it never self-corrected.
//
// WHAT MAKES THIS TEST REAL. The bug is not "no name shown", it is "the WRONG
// name shown", so asserting that "Someone" appears is not enough on its own —
// a render that showed both would pass that. The load-bearing assertion is
// that the first user's name is absent from the unresolved message while the
// control message right beside it, by a real author, still carries theirs.
import * as React from "react";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { MessageList } from "@/components/chat/conversation";
import { StoreProvider } from "@/lib/store";
import { STORAGE_KEY } from "@/lib/backend/local";
import { addUser, asUser, baseState, renderHydrated } from "./_support";
import type { AppState, Message } from "@/lib/types";

// jsdom implements no scrolling at all, and `MessageList` scrolls itself to
// the newest message on mount. Stubbing the method is the narrow fix; making
// the component defensive about it would be changing production code to suit
// the harness.
beforeAll(() => {
  Element.prototype.scrollTo = function scrollTo() {};
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function message(id: string, authorId: string, content: string): Message {
  return {
    id,
    channelId: "c_engineering",
    authorId,
    content,
    createdAt: Date.UTC(2026, 8, 10, 12, 0),
    reactions: [],
    attachments: [],
  } as Message;
}

/** A workspace whose alphabetically-first member is unmistakable in the DOM,
 *  holding one message by a real author and one by an id nobody can resolve. */
function stateWithAnOrphanedMessage(): AppState {
  let state = baseState();
  // The victim: `state.users[0]` was what the fallback reached for.
  state = addUser(state, {
    id: "u_aaron",
    roleId: "member",
    name: "Aaron Alphabetical",
    handle: "aaron",
  });
  state = {
    ...state,
    users: [
      state.users.find((u) => u.id === "u_aaron")!,
      ...state.users.filter((u) => u.id !== "u_aaron"),
    ],
    messages: [
      message("m_real", "u_vlad", "written by a real member"),
      message("m_orphan", "u_deleted_or_unknown", "written by nobody we know"),
    ],
  };
  return asUser(state, "u_vlad");
}

async function mountList(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return renderHydrated(
    React.createElement(
      StoreProvider,
      null,
      React.createElement(MessageList, { conversationId: "c_engineering", intro: null })
    )
  );
}

describe("a message whose author cannot be resolved (QA-116)", () => {
  it("is not attributed to the alphabetically-first colleague", async () => {
    await mountList(stateWithAnOrphanedMessage());

    const orphan = screen.getByText("written by nobody we know").closest("div.group");
    expect(orphan).not.toBeNull();

    // THE ASSERTION THAT CATCHES THE BUG. With `?? state.users[0]` restored,
    // this message renders "Aaron Alphabetical" and this fails.
    expect(within(orphan as HTMLElement).queryByText("Aaron Alphabetical")).toBeNull();
    expect(within(orphan as HTMLElement).getByText("Someone")).toBeInTheDocument();
  });

  it("CONTROL: a message by a real author still shows that author's name", async () => {
    await mountList(stateWithAnOrphanedMessage());

    const real = screen.getByText("written by a real member").closest("div.group");
    expect(real).not.toBeNull();
    // Without this, a component that rendered "Someone" for every message
    // would pass the test above while being comprehensively broken.
    expect(within(real as HTMLElement).getByText("Moshe Cohen")).toBeInTheDocument();
    expect(within(real as HTMLElement).queryByText("Someone")).toBeNull();
  });
});
