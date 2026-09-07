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
import { cleanup, render, screen } from "@testing-library/react";
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
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    requestSwitch: vi.fn(),
    twoFactorStatus: () => "none",
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
import { STORAGE_KEY, asUser, baseState } from "./_support";

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
  it("each icon-only quick-complete button names the task it completes", () => {
    const state = baseState();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(
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
  it("every icon-only button in the sidebar shell has an accessible name", () => {
    const state = baseState();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  it("the emoji/edit/delete hover-toolbar buttons all have accessible names", () => {
    const seed = baseState();
    const message = seed.messages[0];
    // Editing your own message needs currentUser.id === message.authorId.
    const state = asUser(seed, message.authorId);
    const author = state.users.find((u) => u.id === message.authorId)!;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    render(
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
