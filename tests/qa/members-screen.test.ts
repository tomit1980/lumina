// @vitest-environment jsdom
//
// The Members screen, rendered.
//
// WHY THIS FILE EXISTS AT ALL. Until now nothing in the suite rendered this
// screen — `WorkspacePeople` appeared in exactly two files repo-wide, itself
// and the settings page. Its role select and its two-factor control have never
// had component coverage; only the store actions behind them.
//
// That gap has already cost once. The Change password work shipped a store
// action, a dialog and five passing tests around a menu item that did not
// exist, because two edits in one script silently did not run. It was caught
// only because an unrelated account-menu assertion happened to enumerate the
// items. A control nobody renders is a control nobody can prove is there.
//
// So this asserts the thing a unit test of the store structurally cannot: that
// the buttons are on the screen, and that they are on it for the right people.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// The members list routes to a DM when you click somebody's name, so the
// component calls useRouter. Same shim every other component suite here uses.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));

import { asUser, baseState, installMenuShims, renderHydrated } from "./_support";
import { AuthProvider } from "@/lib/auth";
import { StoreProvider } from "@/lib/store";
import { WorkspacePeople } from "@/components/settings/workspace-people";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as React from "react";
import type { AppState } from "@/lib/types";

const h = React.createElement;

installMenuShims();

async function renderMembers(state: AppState) {
  localStorage.setItem("lumina:v1", JSON.stringify(state));
  return renderHydrated(
    h(
      TooltipProvider,
      null,
      h(
        AuthProvider,
        null,
        h(
          StoreProvider,
          null,
          h(UIProvider, null, h(WorkspacePeople, { section: "members" }))
        )
      )
    )
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("the edit-details control", () => {
  it("is on every row for someone who can manage members", async () => {
    // u_vlad is an Admin, so `members.manage` holds.
    const state = asUser(baseState(), "u_vlad");
    await renderMembers(state);

    const pencils = screen.getAllByRole("button", { name: /details$/ });

    // One per member, including the admin's own row — correcting your own name
    // should not mean going to a different screen.
    expect(pencils.length).toBe(state.users.length);
    expect(
      screen.getByRole("button", { name: "Edit Maya Chen's details" })
    ).toBeInTheDocument();
  });

  it("is absent for a member, who cannot manage anybody", async () => {
    // u_maya is a Member. The database refuses her anyway
    // (`profiles_update_self` covers only her own row) — this is the cosmetic
    // half, and the half a person actually sees.
    await renderMembers(asUser(baseState(), "u_maya"));

    expect(screen.queryAllByRole("button", { name: /details$/ })).toHaveLength(0);
  });

  it("CONTROL: the member still sees the list itself", async () => {
    // Without this, the absence above would pass just as well against a screen
    // that rendered nothing at all — which is the failure mode of a permission
    // check applied one level too high.
    await renderMembers(asUser(baseState(), "u_maya"));

    expect(screen.getByText("Maya Chen")).toBeInTheDocument();
    expect(screen.getByText("Moshe Cohen")).toBeInTheDocument();
  });
});

describe("the role control, which has never been asserted either", () => {
  it("offers a role select to an admin, for everyone but themselves", async () => {
    // `setUserRole` is well tested; that it is reachable is not. The self case
    // is deliberate: `profiles_block_self_role_change` refuses it in Postgres,
    // so offering the control would be offering a refusal.
    const state = asUser(baseState(), "u_vlad");
    await renderMembers(state);

    const selects = screen.getAllByRole("combobox");

    expect(selects.length).toBe(state.users.length - 1);
  });

  it("offers none to a member", async () => {
    await renderMembers(asUser(baseState(), "u_maya"));

    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });
});
