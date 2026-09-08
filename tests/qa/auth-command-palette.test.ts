// @vitest-environment jsdom
//
// The command palette's account-switcher, under both backends.
//
// This is the cross-flag control the account-menu suite cannot have: opening a
// Radix *popper* poisons its jsdom document (see auth-account-menu.test.ts),
// but the palette is a dialog, so both flags can be exercised in one file —
// the same component, the same query, opposite expectations. If the local case
// ever stops finding "View as", the supabase case's absence has stopped
// meaning anything.
import * as React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { BackendKind } from "@/lib/backend";

const flag: { kind: BackendKind } = { kind: "local" };

vi.mock("@/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend")>();
  return {
    ...actual,
    get backendKind() {
      return flag.kind;
    },
  };
});
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

import { CommandPalette } from "@/components/command-palette";
import { UIProvider, useUI } from "@/components/ui-context";
import { AuthProvider } from "@/lib/auth";
import { StoreProvider } from "@/lib/store";
import { STORAGE_KEY, baseState, installMenuShims } from "./_support";

const h = React.createElement;

installMenuShims();

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  flag.kind = "local";
});

/** Opens the palette from the UI context, the way ⌘K does. */
function OpenPalette() {
  const { setPaletteOpen } = useUI();
  React.useEffect(() => setPaletteOpen(true), [setPaletteOpen]);
  return null;
}

async function renderPalette() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(baseState()));
  const out = render(
    h(
      AuthProvider,
      null,
      h(
        StoreProvider,
        null,
        h(UIProvider, null, h(OpenPalette), h(CommandPalette))
      )
    )
  );
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  return out;
}

/** The palette's per-user switch entries, found by the `value` cmdk indexes
 *  them under ("view as <name> <role>") rather than by a name that also
 *  appears in the direct-message group. */
function viewAsItems(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll("[data-value]"))
    .map((el) => el.getAttribute("data-value") ?? "")
    .filter((value) => value.startsWith("view as"));
}

describe("the command palette's 'View as' switcher", () => {
  // Note: teammate names appear elsewhere in the palette (the direct-message
  // group), so the switcher is identified by its own group heading and the
  // per-user "view as" entries under it, not by a name appearing anywhere.
  it("offers the switcher on the local demo", async () => {
    flag.kind = "local";
    const { unmount } = await renderPalette();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent ?? "").toMatch(/View as \(demo roles\)/);
    expect(viewAsItems(dialog).length).toBeGreaterThan(0);

    unmount();
  });

  it("offers nobody to view as on a real backend", async () => {
    flag.kind = "supabase";
    const { unmount } = await renderPalette();

    const dialog = screen.getByRole("dialog");
    const text = dialog.textContent ?? "";

    // CONTROL: the palette really rendered, and the group is really there —
    // it just has nobody in it. The case above reads the same nodes and finds
    // both the heading and the entries.
    expect(text).toContain("Account");
    expect(text).toContain("Signed in as");

    expect(text).not.toMatch(/View as/);
    expect(viewAsItems(dialog)).toEqual([]);

    unmount();
  });
});
