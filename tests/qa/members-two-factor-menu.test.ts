// @vitest-environment jsdom
//
// The two-factor dropdown on the Members screen.
//
// WHY THIS FILE EXISTS. `mfa_enrolled_ids()` made another person's enrolment
// knowable, and knowing it is what broke this menu. Every item used to hang
// off a single three-state badge, and `enrolled` was only ever true for the
// signed-in user — so "Reset" and "Disable two-factor" were invisible on other
// people's rows by accident rather than by rule. Making the badge truthful
// would have surfaced two buttons that cannot work on somebody else's account:
// unenrolling them is an `auth.admin` call the publishable key cannot make.
//
// It would also have taken something away. "Cancel requirement" lived only in
// the `pending` branch, so it would have disappeared the moment a person
// enrolled — removing the one thing an admin genuinely can still do for them.
//
// So requirement and enrolment are now separate inputs, and this asserts the
// split directly. The component is rendered with explicit props rather than
// driven through the whole screen: these are combinations of two booleans, and
// reaching them through a seeded workspace and a fake auth session would test
// the seeding more than the rule.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as React from "react";

import { installMenuShims } from "./_support";
import { TwoFactorControl } from "@/components/settings/workspace-people";

const h = React.createElement;

installMenuShims();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Render the control, open its menu, read everything, and close it again.
 *
 * Keyboard rather than pointer, and read-then-close rather than leaving it
 * open: both for the reasons `openAccountMenu` in ./_auth-shell.ts records —
 * jsdom has no PointerEvent, and an open Radix menu keeps a floating-ui
 * repositioning loop running that drains the next async act() forever.
 */
function readMenu(
  props: Partial<React.ComponentProps<typeof TwoFactorControl>> = {}
): { items: string[]; text: string } {
  render(
    h(TwoFactorControl, {
      userName: "Raz",
      status: "enrolled",
      required: true,
      isSelf: false,
      onRequire: vi.fn(),
      onClearRequirement: vi.fn(),
      onReset: vi.fn(),
      onDisable: vi.fn(),
      ...props,
    })
  );

  // Queried from the DOM rather than by role. `getByRole` computes accessible
  // names across the tree, which is slow enough here to starve the worker's
  // event loop — the same trap ./_auth-shell.ts records.
  const trigger = document.querySelector("button");
  if (!trigger) throw new Error("two-factor trigger not rendered");
  fireEvent.keyDown(trigger, { key: "Enter" });

  const menu = document.querySelector('[role="menu"]');
  if (!menu) throw new Error("two-factor menu did not open");
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
    (item) => item.textContent?.trim() ?? ""
  );
  const text = menu.textContent ?? "";

  // Closed AND unmounted before returning. Escape alone leaves Radix's
  // floating-ui repositioning loop running, and each test that left one behind
  // made the next one slower — seven trivial cases took over two minutes.
  fireEvent.keyDown(trigger, { key: "Escape" });
  cleanup();
  return { items, text };
}

describe("somebody else's row", () => {
  it("offers what an admin can do, and nothing it cannot", () => {
    // Enrolled, and required of them. Four assertions on ONE open menu: each
    // Radix open costs seconds in jsdom and the cost compounds within a file,
    // so the combinations below are covered by the fewest opens that still
    // discriminate. The two presences are the control for the two absences —
    // without them this would pass just as well against a menu that never
    // opened, which is the failure mode of asserting on a closed dropdown.
    const { items, text } = readMenu({ isSelf: false, status: "enrolled", required: true });

    expect(items.join(" | ")).not.toMatch(/Reset/);
    expect(items).not.toContain("Disable two-factor");

    // Still available to somebody who HAS enrolled — the item used to live in
    // the `pending` branch and would have vanished the moment they did.
    expect(items).toContain("Cancel requirement");
    expect(text).toMatch(/Supabase dashboard/);
  });

  it("offers Require to an enrolled person nobody has required it of", () => {
    const { items } = readMenu({ isSelf: false, status: "enrolled", required: false });

    expect(items).toContain("Require two-factor");
    expect(items).not.toContain("Cancel requirement");
  });
});

describe("your own row", () => {
  it("offers reset and disable, which are self-service and do work", () => {
    const { items, text } = readMenu({ isSelf: true, status: "enrolled" });

    expect(items.join(" | ")).toMatch(/Reset/);
    expect(items).toContain("Disable two-factor");
    // And does not send you to the dashboard for a factor you can drop here.
    expect(text).not.toMatch(/Supabase dashboard/);
  });
});
