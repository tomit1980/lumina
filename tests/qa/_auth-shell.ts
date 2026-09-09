// Renders the real sidebar shell and opens its account menu, so a suite can
// assert on what that menu actually offers. Used by auth-account-menu.test.ts
// under both `backendKind` values — the same helper, the same queries,
// opposite expectations. That pairing is what stops the "not rendered"
// assertions being vacuous.
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UIProvider } from "@/components/ui-context";
import { AuthProvider } from "@/lib/auth";
import type { Database } from "@/lib/database.types";
import { StoreProvider } from "@/lib/store";
import { STORAGE_KEY, baseState } from "./_support";

const h = React.createElement;

/** Mounts `AppShell` over a seeded workspace. `client` is only used on the
 *  Supabase path; the local provider ignores it. */
export async function renderShell(client?: SupabaseClient<Database>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(baseState()));
  // Plain `render` + `waitFor`, never `await act(async …)`. Once a Radix menu
  // has been opened in this jsdom document, an async `act` never settles: it
  // keeps draining work the popper's frame loop keeps scheduling. `waitFor`
  // polls instead, so it is unaffected — and `render` is already act-wrapped
  // synchronously by testing-library, so effects still run.
  const out = render(
    h(
      AuthProvider,
      { client },
      h(
        StoreProvider,
        null,
        h(
          TooltipProvider,
          null,
          h(UIProvider, null, h(AppShell, null, h("div", null, "content")))
        )
      )
    )
  );
  // StoreProvider renders a loading screen until `backend.hydrate()` resolves.
  await waitFor(() => expect(screen.getByText("Moshe Cohen")).toBeTruthy());
  return out;
}

/** Opens the account menu at the foot of the sidebar, reads it, and closes it
 *  again — returning the item labels and the menu's full text.
 *
 *  Keyboard, not pointer: jsdom has no PointerEvent. Deliberately *not*
 *  wrapped in an async `act()`, and closed before returning: an open Radix
 *  menu keeps a floating-ui repositioning loop running, and the next async
 *  `act()` anywhere in the file then drains it forever and times out. Reading
 *  everything up front is also why the callers assert on these strings rather
 *  than re-querying `screen` — by then the menu is gone. */
export function openAccountMenu(): { items: string[]; text: string } {
  // Found by text and CSS, not by `getByRole(..., { name })`: computing
  // accessible names across the whole shell blocks the worker's event loop for
  // seconds, long enough for vitest's reporter RPC to time out and fail the
  // run with an unhandled error while every assertion passes.
  const trigger = screen.getByText("Moshe Cohen").closest("button");
  if (!trigger) throw new Error("account menu trigger not found");

  fireEvent.keyDown(trigger, { key: "Enter" });

  const menu = document.querySelector('[role="menu"]');
  if (!menu) throw new Error("account menu did not open");
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
    (item) => item.textContent?.trim() ?? ""
  );
  const text = menu.textContent ?? "";

  fireEvent.keyDown(trigger, { key: "Escape" });
  return { items, text };
}
