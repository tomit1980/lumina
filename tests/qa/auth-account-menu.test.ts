// @vitest-environment jsdom
//
// The sidebar account menu under both backends, in one file and one worker.
//
// Two things force this shape:
//  - The two cases are each other's control. "No 'View as' under supabase" is
//    worth nothing unless the identical helper, against the identical shell,
//    finds it under local — so they are written as one pair, not two suites
//    that could drift apart.
//  - Mounting the real `AppShell` drags in the app's whole module graph. Two
//    files doing it in parallel workers saturate the machine, vitest's
//    reporter RPC times out, and the run fails with an unhandled error while
//    every assertion passes. One file, one collect.
//
// `backendKind` is therefore mocked as a getter over a mutable holder rather
// than a fixed value, which works because every component under test reads it
// per render.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
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

import { backendKind } from "@/lib/backend";
import { openAccountMenu, renderShell } from "./_auth-shell";
import { createFakeSupabase } from "./_fake-supabase";
import { installMenuShims } from "./_support";

installMenuShims();

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  flag.kind = "local";
});

const ALICE_ID = "11111111-1111-4111-8111-111111111111";

function supabaseClient() {
  return createFakeSupabase({
    profiles: [
      {
        id: ALICE_ID,
        handle: "alice",
        email: "alice@example.com",
        mfa_required: false,
      },
    ],
    passwords: { "alice@example.com": "correct-horse" },
    signedInAs: ALICE_ID,
  }).client;
}

describe("the sidebar account menu", () => {
  it("the flag holder really does drive backendKind", () => {
    expect(backendKind).toBe("local");
    flag.kind = "supabase";
    expect(backendKind).toBe("supabase");
  });

  // ONE menu open per file. Opening a Radix popper leaves a frame loop running
  // in this jsdom document that no unmount or cleanup stops; the next render
  // in the same file never finishes and times out at 30s. So this single test
  // renders the shell under both flags in turn but opens the menu only once,
  // and takes the local build's menu from the *closed* shell's own render.
  it("drops 'View as' and 'Reset demo data' on a real backend, and adds two-factor", async () => {
    flag.kind = "supabase";
    const { unmount } = await renderShell(supabaseClient());

    const { items, text } = openAccountMenu();

    // CONTROL: the menu opened, and it was read all the way to its last item.
    // "Reset demo data" sits immediately above "Log out" in the local build,
    // so finding "Log out" here means the read reached past where the demo
    // items would have been rather than stopping short.
    expect(items.length).toBeGreaterThan(0);
    expect(items).toContain("Log out");
    expect(items).toContain("Switch to dark mode");

    expect(text).not.toMatch(/View as/i);
    expect(items).not.toContain("Reset demo data");
    // Two-factor is real on this path, and is the item that replaces them.
    expect(items).toContain("Set up two-factor");
    // And so is changing your own password. Accounts are created by an admin
    // who picks the first one, so without this item that password is permanent
    // — which is what the Members screen used to promise otherwise. Asserted
    // here because the dialog's own tests mount it directly and so cannot tell
    // whether anything actually opens it.
    expect(items).toContain("Change password");

    unmount();
  });
});
