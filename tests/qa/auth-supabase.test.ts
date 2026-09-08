// @vitest-environment jsdom
//
// Task 3 — the auth swap. Everything here runs with `backendKind` forced to
// "supabase", against the fake client in ./_fake-supabase.ts. No network: the
// unit suite never holds credentials, and tests/rls/ is where the real ones
// live.
//
// Every negative assertion in this file ("the app is not reachable", "the demo
// login is not rendered", "requestSwitch did nothing") is paired with a control
// that makes the same query succeed — either a second case here, or the
// local-flag counterpart in ./auth-local-controls.test.ts. A test that cannot
// fail is worse than no test.
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend")>();
  return { ...actual, backendKind: "supabase" as const };
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

import { AuthGate } from "@/components/auth/auth-gate";
import { SessionBridge } from "@/components/auth/session-bridge";
import { AuthProvider, DEMO_PASSWORD, useAuth } from "@/lib/auth";
import { StoreProvider, useStore } from "@/lib/store";
import { createFakeSupabase, type FakeSupabase } from "./_fake-supabase";
import { STORAGE_KEY, addProject, baseState, installMenuShims } from "./_support";

const h = React.createElement;

installMenuShims();

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const ALICE = {
  id: "11111111-1111-4111-8111-111111111111",
  handle: "alice",
  email: "alice@example.com",
  mfa_required: false,
};
const BOB = {
  id: "22222222-2222-4222-8222-222222222222",
  handle: "bob",
  email: "bob@example.com",
  mfa_required: false,
};

function fakeFor(overrides: Partial<Parameters<typeof createFakeSupabase>[0]> = {}) {
  return createFakeSupabase({
    profiles: [{ ...ALICE }, { ...BOB }],
    passwords: { [ALICE.email]: "correct-horse", [BOB.email]: "battery-staple" },
    ...overrides,
  });
}

/** AuthProvider + AuthGate only — enough for the gate and the login screen. */
async function renderGate(fake: FakeSupabase, app = "THE APP") {
  const out = render(
    h(AuthProvider, { client: fake.client }, h(AuthGate, null, h("div", null, app)))
  );
  await waitFor(() => expect(screen.queryByText("Securing your session…")).toBeNull());
  return out;
}

/** Drives the login form's credentials step. */
async function signIn(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  });
}

/** Types a code into the OTP field, which submits itself once six digits land. */
async function enterCode(code: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("6-digit verification code"), {
      target: { value: code },
    });
  });
}

describe("AuthGate — the app is behind authentication", () => {
  it("an unauthenticated visitor gets the login screen and never the app", async () => {
    await renderGate(fakeFor());

    expect(screen.getByText("Welcome to Lumina")).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
  });

  it("CONTROL — a restored session renders the app, so the query above can find it", async () => {
    await renderGate(fakeFor({ signedInAs: ALICE.id }));

    await waitFor(() => expect(screen.getByText("THE APP")).toBeInTheDocument());
    expect(screen.queryByText("Welcome to Lumina")).toBeNull();
  });

  it("a correct email and password reaches the app", async () => {
    const fake = fakeFor();
    await renderGate(fake);

    await signIn(ALICE.email, "correct-horse");

    await waitFor(() => expect(screen.getByText("THE APP")).toBeInTheDocument());
  });

  it("a wrong password does not, and says so without revealing whether the account exists", async () => {
    const fake = fakeFor();
    await renderGate(fake);

    await signIn(ALICE.email, "wrong-password");

    expect(await screen.findByText("Incorrect email or password.")).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
  });

  it("an account with no profile row is signed straight back out", async () => {
    // The auth user exists and the password is right; the trigger never made
    // them a profile. Sign-in therefore *succeeds* and the profile lookup is
    // the thing that fails — the case the runbook's troubleshooting describes.
    const fake = createFakeSupabase({
      profiles: [],
      passwords: { [ALICE.email]: "correct-horse" },
      authUsers: { [ALICE.email]: ALICE.id },
    });
    await renderGate(fake);

    await signIn(ALICE.email, "correct-horse");

    expect(await screen.findByText(/no Lumina profile yet/)).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
    expect(fake.signOutCalls).toBeGreaterThan(0);
  });
});

describe("the login screen's three-step machine, on real MFA", () => {
  it("holds a user with a verified factor at the TOTP step until they pass it", async () => {
    const fake = fakeFor({
      factors: [{ id: "factor-1", factor_type: "totp", status: "verified" }],
    });
    await renderGate(fake);

    await signIn(ALICE.email, "correct-horse");

    // Step 2, and — the point of the gate — the app is NOT reachable yet even
    // though Supabase has already issued an aal1 session.
    expect(await screen.findByText("Two-factor verification")).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
    expect(fake.session).not.toBeNull();

    await enterCode(fake.validCode);

    await waitFor(() => expect(screen.getByText("THE APP")).toBeInTheDocument());
  });

  it("a wrong code at the TOTP step keeps them out", async () => {
    const fake = fakeFor({
      factors: [{ id: "factor-1", factor_type: "totp", status: "verified" }],
    });
    await renderGate(fake);
    await signIn(ALICE.email, "correct-horse");
    await screen.findByText("Two-factor verification");

    await enterCode("000000");

    expect(await screen.findByText("That code isn't valid. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
  });

  it("forces enrolment when the profile requires two-factor and there is no factor yet", async () => {
    const fake = fakeFor();
    fake.profiles[0].mfa_required = true;
    await renderGate(fake);

    await signIn(ALICE.email, "correct-horse");

    expect(await screen.findByText("Secure your account")).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
    expect(fake.enrollCalls).toBe(1);
    // The secret Supabase returned, grouped for manual entry.
    expect(screen.getByLabelText("Copy setup key")).toHaveTextContent("JBSW");
    // Supabase hands back a ready-made QR, so nothing is generated locally.
    expect(screen.getByAltText("Two-factor QR code")).toHaveAttribute(
      "src",
      "data:image/svg+xml;utf8,<svg/>"
    );

    await enterCode(fake.validCode);

    await waitFor(() => expect(screen.getByText("THE APP")).toBeInTheDocument());
    expect(fake.factors[0].status).toBe("verified");
  });

  it("backing out of the second step ends the half-open session", async () => {
    const fake = fakeFor({
      factors: [{ id: "factor-1", factor_type: "totp", status: "verified" }],
    });
    await renderGate(fake);
    await signIn(ALICE.email, "correct-horse");
    await screen.findByText("Two-factor verification");
    expect(fake.session).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /back to sign in/i }));
    });

    await waitFor(() => expect(fake.session).toBeNull());
    expect(screen.getByText("Welcome to Lumina")).toBeInTheDocument();
  });

  it("a reload cannot walk past a forced enrolment", async () => {
    // A persisted session belonging to someone who owes an enrolment must not
    // be restored, or refreshing the page would be a one-click bypass.
    const fake = fakeFor({ signedInAs: ALICE.id });
    fake.profiles[0].mfa_required = true;

    await renderGate(fake);

    expect(screen.getByText("Welcome to Lumina")).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
    expect(fake.signOutCalls).toBe(1);
  });

  it("CONTROL — the same restore with the factor already verified does sign them in", async () => {
    const fake = fakeFor({
      signedInAs: ALICE.id,
      factors: [{ id: "factor-1", factor_type: "totp", status: "verified" }],
    });
    fake.profiles[0].mfa_required = true;

    await renderGate(fake);

    await waitFor(() => expect(screen.getByText("THE APP")).toBeInTheDocument());
    expect(fake.signOutCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sign-out clears the store
// ---------------------------------------------------------------------------

/** Renders the project names the store currently holds. */
function ProjectProbe() {
  const { state } = useStore();
  return h("div", { "data-testid": "projects" }, state.projects.map((p) => p.name).join(","));
}

function LogoutButton() {
  const { logout } = useAuth();
  return h("button", { onClick: logout }, "Sign out");
}

async function renderApp(fake: FakeSupabase) {
  // A project that exists only in this browser's persisted workspace, so its
  // survival or removal is an unambiguous read on whether the store was cleared.
  const state = addProject(baseState(), {
    id: "p_secret",
    name: "ACQUISITION-MEMO",
    createdBy: "u_vlad",
  });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  await act(async () => {
    render(
      h(
        AuthProvider,
        { client: fake.client },
        h(
          StoreProvider,
          null,
          h(SessionBridge),
          h(AuthGate, null, h(ProjectProbe), h(LogoutButton))
        )
      )
    );
  });
}

describe("SessionBridge — signing out clears the store", () => {
  it("a real workspace does not survive sign-out", async () => {
    const fake = fakeFor({ signedInAs: ALICE.id });
    await renderApp(fake);

    // CONTROL, inline: the probe really does see the project while signed in.
    // Without this the removal assertion below would pass against a probe that
    // never rendered anything.
    await waitFor(() =>
      expect(screen.getByTestId("projects")).toHaveTextContent("ACQUISITION-MEMO")
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    });

    await waitFor(() => expect(screen.getByText("Welcome to Lumina")).toBeInTheDocument());
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain("ACQUISITION-MEMO");
  });

  it("signing back in gets a clean workspace, not the previous person's", async () => {
    const fake = fakeFor({ signedInAs: ALICE.id });
    await renderApp(fake);
    await waitFor(() =>
      expect(screen.getByTestId("projects")).toHaveTextContent("ACQUISITION-MEMO")
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    });
    await screen.findByText("Welcome to Lumina");
    await signIn(BOB.email, "battery-staple");

    await waitFor(() => expect(screen.getByTestId("projects")).toBeInTheDocument());
    expect(screen.getByTestId("projects")).not.toHaveTextContent("ACQUISITION-MEMO");
  });
});

// ---------------------------------------------------------------------------
// The demo affordances are gone
// ---------------------------------------------------------------------------

describe("demo affordances are absent under the supabase flag", () => {
  it("the login screen offers no one-click demo accounts and prints no password", async () => {
    await renderGate(fakeFor());

    expect(screen.queryByText(new RegExp(DEMO_PASSWORD))).toBeNull();
    expect(screen.queryByRole("button", { name: /vlad/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /elena/i })).toBeNull();
    expect(screen.queryByText(/Demo accounts/i)).toBeNull();
    // CONTROL: the form itself is rendered, so the queries above were looking
    // at a real login screen and not at an empty tree.
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  // The sidebar account menu's own absences ("View as", "Reset demo data")
  // are asserted in ./auth-account-menu-supabase.test.ts, which has to stand
  // alone — see the note at the top of that file.
});

describe("account switching cannot happen on a real backend", () => {
  function SwitchProbe() {
    const { session, requestSwitch, pendingSwitch } = useAuth();
    return h(
      "div",
      null,
      h("span", { "data-testid": "session" }, session ?? "none"),
      h("span", { "data-testid": "pending" }, pendingSwitch ?? "none"),
      h("button", { onClick: () => void requestSwitch(BOB.id) }, "switch")
    );
  }

  it("requestSwitch is inert: it changes neither the session nor pendingSwitch", async () => {
    const fake = fakeFor({ signedInAs: ALICE.id });
    const out = render(h(AuthProvider, { client: fake.client }, h(SwitchProbe)));
    await waitFor(() =>
      expect(screen.getByTestId("session")).toHaveTextContent(ALICE.id)
    );
    // Let the auth-state listener's own deferred INITIAL_SESSION land BEFORE
    // the click, and assert SYNCHRONOUSLY after it. Both matter: that listener
    // re-publishes the true session, so a `waitFor` here would happily watch a
    // switch happen and then get overwritten, and the test would pass against
    // a `requestSwitch` that really did switch. (It did — caught by mutating
    // this one to `setSession(userId)` and finding the suite still green.)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    fireEvent.click(screen.getByRole("button", { name: "switch" }));

    expect(screen.getByTestId("session")).toHaveTextContent(ALICE.id);
    expect(screen.getByTestId("pending")).toHaveTextContent("none");
    out.unmount();
  });
});

describe("the People page's two-factor controls write profiles.mfa_required", () => {
  function AdminProbe() {
    const { twoFactorStatus, requireTwoFactor, clearTwoFactorRequirement } = useAuth();
    return h(
      "div",
      null,
      h("span", { "data-testid": "bob-status" }, twoFactorStatus(BOB.id)),
      h("button", { onClick: () => requireTwoFactor(BOB.id) }, "require"),
      h("button", { onClick: () => clearTwoFactorRequirement(BOB.id) }, "clear")
    );
  }

  async function renderAdmin(fake: FakeSupabase) {
    await act(async () => {
      render(h(AuthProvider, { client: fake.client }, h(AdminProbe)));
    });
  }

  it("requiring two-factor for someone updates their profile row", async () => {
    const fake = fakeFor({ signedInAs: ALICE.id });
    await renderAdmin(fake);
    expect(screen.getByTestId("bob-status")).toHaveTextContent("off");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "require" }));
    });

    await waitFor(() =>
      expect(screen.getByTestId("bob-status")).toHaveTextContent("pending")
    );
    expect(fake.requirementWrites).toEqual([{ id: BOB.id, mfa_required: true }]);
    expect(fake.profiles.find((p) => p.id === BOB.id)?.mfa_required).toBe(true);
  });

  it("a write the database refuses does not leave the UI claiming it worked", async () => {
    const fake = fakeFor({ signedInAs: ALICE.id });
    await renderAdmin(fake);
    fake.failRequirementWrites = true;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "require" }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Paired with the passing case above: identical click, identical probe,
    // and the badge stays "off" only because the write was refused.
    expect(screen.getByTestId("bob-status")).toHaveTextContent("off");
    expect(fake.requirementWrites).toEqual([]);
    expect(fake.profiles.find((p) => p.id === BOB.id)?.mfa_required).toBe(false);
  });

  it("another person's enrolment state is never reported as known", async () => {
    // Alice (signed in) has a verified factor; Bob is merely *required* to
    // have one. Listing Bob's factors is an auth.admin call the publishable
    // key cannot make, so Bob must never read as "enrolled" — not even by
    // Alice's own factor leaking across.
    const fake = fakeFor({
      signedInAs: ALICE.id,
      factors: [{ id: "factor-1", factor_type: "totp", status: "verified" }],
    });
    fake.profiles[1].mfa_required = true;
    await renderAdmin(fake);

    await waitFor(() =>
      expect(screen.getByTestId("bob-status")).toHaveTextContent("pending")
    );
    expect(screen.getByTestId("bob-status")).not.toHaveTextContent("enrolled");
  });
});
