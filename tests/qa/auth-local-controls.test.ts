// @vitest-environment jsdom
//
// The positive controls for ./auth-supabase.test.ts.
//
// That suite asserts a list of absences: no demo logins, no printed password,
// no "View as", no "Reset demo data", a `requestSwitch` that does nothing, a
// sign-out that clears the store. Each of those queries would also pass
// against a component that failed to render, a menu that never opened, or a
// probe wired to nothing — the failure mode this project has been bitten by
// twice. So the same helpers and the same queries run here under the default
// (local) flag, where every one of them must FIND what the other suite must
// not. If one of these ever goes red, the matching absence over there has
// stopped meaning anything.
//
// No `vi.mock` of "@/lib/backend" here on purpose: `backendKind` resolves to
// "local" from the environment, which is what the public build ships.
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { AuthGate } from "@/components/auth/auth-gate";
import { SessionBridge } from "@/components/auth/session-bridge";
import { AuthProvider, DEMO_PASSWORD, useAuth } from "@/lib/auth";
import { backendKind } from "@/lib/backend";
import { StoreProvider, useStore } from "@/lib/store";
import { STORAGE_KEY, addProject, baseState, installMenuShims } from "./_support";

const h = React.createElement;

installMenuShims();

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("this file really is running on the local flag", () => {
  expect(backendKind).toBe("local");
});

describe("CONTROL — the demo affordances the supabase flag hides are present here", () => {
  it("the login screen still offers one-click demo accounts and prints the password", async () => {
    render(h(AuthProvider, null, h(AuthGate, null, h("div", null, "THE APP"))));
    await waitFor(() => expect(screen.getByText("Welcome to Lumina")).toBeInTheDocument());

    expect(screen.getByText(new RegExp(DEMO_PASSWORD))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /moshe/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /elena/i })).toBeInTheDocument();
  });

  // The sidebar account menu's counterpart control lives in
  // ./auth-account-menu-local.test.ts, which has to stand alone.

  it("requestSwitch really does switch accounts here", async () => {
    function SwitchProbe() {
      const { session, requestSwitch } = useAuth();
      return h(
        "div",
        null,
        h("span", { "data-testid": "session" }, session ?? "none"),
        h("button", { onClick: () => void requestSwitch("u_maya") }, "switch")
      );
    }
    render(h(AuthProvider, null, h(SwitchProbe)));
    await waitFor(() => expect(screen.getByTestId("session")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "switch" }));

    await waitFor(() =>
      expect(screen.getByTestId("session")).toHaveTextContent("u_maya")
    );
  });
});

describe("CONTROL — sign-out leaves the demo workspace alone", () => {
  function ProjectProbe() {
    const { state } = useStore();
    return h(
      "div",
      { "data-testid": "projects" },
      state.projects.map((p) => p.name).join(",")
    );
  }
  function LogoutButton() {
    const { logout } = useAuth();
    return h("button", { onClick: logout }, "Sign out");
  }

  it("a project survives sign-out on the local path, proving the clear is the flag's doing", async () => {
    const state = addProject(baseState(), {
      id: "p_secret",
      name: "ACQUISITION-MEMO",
      createdBy: "u_vlad",
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.localStorage.setItem("lumina:session", "u_vlad");

    await act(async () => {
      render(
        h(
          AuthProvider,
          null,
          h(
            StoreProvider,
            null,
            h(SessionBridge),
            h(AuthGate, null, h(ProjectProbe), h(LogoutButton))
          )
        )
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("projects")).toHaveTextContent("ACQUISITION-MEMO")
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    });

    await waitFor(() =>
      expect(screen.getByText("Welcome to Lumina")).toBeInTheDocument()
    );
    // Still there: the demo's own "Reset demo data" is the deliberate wipe.
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain("ACQUISITION-MEMO");
  });
});
