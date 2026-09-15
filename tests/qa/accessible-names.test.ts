// @vitest-environment jsdom
//
// QA-010 (Medium) — several icon-only buttons had no accessible name: the
// per-task quick-complete circles on the home page, four icon buttons in the
// sidebar shell, and the hover toolbar (emoji/edit/delete) on a chat message.
// This renders the *real* components — not a static source-text check — and
// asserts every icon-only button in each has a non-empty accessible name.
//
// One infrastructure note specific to this repo's Vitest setup:
// next/navigation's useRouter/usePathname/useSearchParams need an App Router
// context this harness doesn't provide, and app-shell.tsx also calls
// useAuth() directly, so both are mocked. (Vitest's esbuild transform now
// uses the automatic JSX runtime — see vitest.config.ts — so leaf components
// that don't import React themselves, relying on the runtime Next provides,
// no longer need a `globalThis.React` workaround here.)
import * as React from "react";
import { cleanup, screen } from "@testing-library/react";
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
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", resolvedTheme: "light", setTheme: vi.fn() }),
}));
// The shape app-shell.tsx consumes from `AuthValue`. `twoFactorStatus` answers
// "off" — the local flag's answer, and the one that keeps the sidebar's
// two-factor affordances in their default state for this render.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    requestSwitch: vi.fn(async () => {}),
    twoFactorStatus: () => "off",
    logout: vi.fn(),
    resetAll: vi.fn(async () => {}),
  }),
}));

import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import HomePage from "@/app/page";
import { AppShell } from "@/components/app-shell";
import { MessageItem } from "@/components/chat/message-item";
import { Composer } from "@/components/chat/conversation";
import { Board } from "@/components/kanban/board";
import { WorkspacePeople } from "@/components/settings/workspace-people";
import { STORAGE_KEY, asUser, baseState, renderHydrated } from "./_support";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Every button that has no visible text content is "icon-only" and must
 *  expose a non-empty accessible name some other way (aria-label here). */
function iconOnlyButtons(): HTMLElement[] {
  return screen.getAllByRole("button").filter((b) => !b.textContent?.trim());
}

describe("app/page.tsx — task quick-complete buttons (QA-010)", () => {
  it("each icon-only quick-complete button names the task it completes", async () => {
    const state = baseState();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    await renderHydrated(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(UIProvider, null, React.createElement(HomePage))
        )
      )
    );

    const buttons = iconOnlyButtons();
    // The seed gives u_vlad (the default current user) open assigned tasks,
    // so at least one quick-complete circle must be present and labelled.
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b).toHaveAccessibleName();
    }
    const markButtons = buttons.filter((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith('Mark "')
    );
    expect(markButtons.length).toBeGreaterThan(0);
    for (const b of markButtons) {
      expect(b.getAttribute("aria-label")).toMatch(/^Mark ".+" complete$/);
    }
  });
});

describe("components/app-shell.tsx — icon buttons (QA-010)", () => {
  it("every icon-only button in the sidebar shell has an accessible name", async () => {
    const state = baseState();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    await renderHydrated(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(
            UIProvider,
            null,
            React.createElement(AppShell, null, React.createElement("div"))
          )
        )
      )
    );

    const buttons = iconOnlyButtons();
    // Command palette, New channel, New message, New project, Options-for-*
    // (one per manageable row), and the mobile Open-navigation-menu button.
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) {
      expect(b).toHaveAccessibleName();
    }
  });
});

describe("components/chat/message-item.tsx — hover toolbar (QA-010)", () => {
  it("the emoji/edit/delete hover-toolbar buttons all have accessible names", async () => {
    const seed = baseState();
    const message = seed.messages[0];
    // Editing your own message needs currentUser.id === message.authorId.
    const state = asUser(seed, message.authorId);
    const author = state.users.find((u) => u.id === message.authorId)!;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    await renderHydrated(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(MessageItem, { message, author, compact: false })
        )
      )
    );

    const buttons = iconOnlyButtons();
    // Add reaction, Edit message, Delete message.
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) {
      expect(b).toHaveAccessibleName();
    }
    const names = buttons.map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(
      expect.arrayContaining(["Add reaction", "Edit message", "Delete message"])
    );
  });
});

// ---------------------------------------------------------------------------
// The three surfaces this file never rendered.
//
// FOUND BY A QA SWEEP OF THE RUNNING APP, not by this suite — which is the
// point. Twelve icon-only buttons across the composer, the board and the
// members list had no accessible name at all, and every one of them sat on a
// screen no test here mounted. The file's own header lists the three surfaces
// it covers; these are the three it did not.
//
// Two different causes, both represented below:
//   - a bare icon button with neither label nor tooltip (the board)
//   - a button whose only name was a Radix <TooltipContent>, which DESCRIBES
//     its trigger while open and never NAMES it (the composer, the members
//     list). The Attach button one element away from Send had the aria-label
//     the Send button was missing.
// ---------------------------------------------------------------------------

describe("components/chat/conversation.tsx — the composer (QA sweep)", () => {
  it("names the Send button, which a tooltip does not do", async () => {
    const state = baseState();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    await renderHydrated(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(UIProvider, null,
            React.createElement(Composer, {
              conversationId: "c_general",
              placeholder: "Message #general",
            })
          )
        )
      )
    );

    const buttons = iconOnlyButtons();
    // Attach files and Send.
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons) {
      expect(b).toHaveAccessibleName();
    }
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining(["Attach files", "Send message"])
    );
  });

  it("labels the message box rather than leaving it to a placeholder", async () => {
    // The repo's own rule, applied everywhere else: a placeholder is a hint,
    // not a label. It disappears the moment somebody types.
    const state = baseState();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    await renderHydrated(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(UIProvider, null,
            React.createElement(Composer, {
              conversationId: "c_general",
              placeholder: "Message #general",
            })
          )
        )
      )
    );

    expect(screen.getByRole("textbox")).toHaveAccessibleName();
  });
});

describe("components/kanban/board.tsx — per-column add buttons (QA sweep)", () => {
  it("each add-task button says WHICH column it adds to", async () => {
    // Five identical bare buttons, one per column. Naming them all "Add task"
    // would satisfy toHaveAccessibleName and still leave a screen-reader user
    // unable to tell them apart, so the column name is the assertion.
    const state = asUser(baseState(), "u_vlad");
    const project = state.projects[0];
    const tasks = state.tasks.filter((t) => t.projectId === project.id);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    await renderHydrated(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(UIProvider, null,
            React.createElement(Board, { project, tasks })
          )
        )
      )
    );

    const buttons = iconOnlyButtons();
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b).toHaveAccessibleName();
    }

    const names = buttons.map((b) => b.getAttribute("aria-label") ?? "");
    for (const status of state.statuses) {
      expect(names).toContain(`Add a task to ${status.name}`);
    }
    // Distinct among THEMSELVES, which is the whole reason the column name is
    // in there. Scoped to these: the board also renders a per-task menu button
    // on every card, and those legitimately share a name.
    const addButtons = names.filter((n) => n.startsWith("Add a task to"));
    expect(addButtons.length).toBe(state.statuses.length);
    expect(new Set(addButtons).size).toBe(addButtons.length);
  });
});

describe("components/settings/workspace-people.tsx — member rows (QA sweep)", () => {
  it("names the message button on each row, and says who it messages", async () => {
    const state = asUser(baseState(), "u_vlad");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    await renderHydrated(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(UIProvider, null,
            React.createElement(WorkspacePeople, { section: "members" })
          )
        )
      )
    );

    const buttons = iconOnlyButtons();
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b).toHaveAccessibleName();
    }

    const names = buttons.map((b) => b.getAttribute("aria-label") ?? "");
    const messageButtons = names.filter((n) => n.startsWith("Message "));
    expect(messageButtons.length).toBeGreaterThan(0);
    expect(new Set(messageButtons).size).toBe(messageButtons.length);
  });
});
