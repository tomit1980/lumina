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

describe("the rendered menu", () => {
  it("puts the decision on screen: what it can do, and not what it cannot", () => {
    // ONE opened menu, deliberately. Every Radix open costs seconds in jsdom
    // and the cost compounds within a file; seven of them took 165s and tipped
    // CI's reporter into a timeout that failed a build where all 883 tests
    // passed. The combinations live in ./two-factor-menu.test.ts, which runs in
    // milliseconds. This case exists because that one cannot tell whether
    // anything reached the screen at all — the gap ./members-screen.test.ts was
    // written for, where a control nobody renders is a control nobody can
    // prove is there.
    //
    // Somebody else's row, enrolled and required: the single case where all
    // three rules are visible at once.
    const { items, text } = readMenu({ isSelf: false, status: "enrolled", required: true });

    // Cannot: unenrolling somebody else needs the secret key.
    expect(items.join(" | ")).not.toMatch(/Reset/);
    expect(items).not.toContain("Disable two-factor");

    // Can: the requirement, still available to somebody who HAS enrolled.
    // Also the control for the two absences above — without it they would pass
    // just as well against a menu that never opened.
    expect(items).toContain("Cancel requirement");
    expect(text).toMatch(/Supabase dashboard/);
  });
});
