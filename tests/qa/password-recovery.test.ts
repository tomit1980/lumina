// @vitest-environment jsdom
//
// Forgetting your password, and getting back in.
//
// TWO HALVES, AND ONLY ONE OF THEM IS NEW CODE.
//
// Requesting a reset is a form and one call. The half that matters is what
// happens when the link is FOLLOWED, because until this feature existed the
// app could not tell a recovery session from a restored one:
//
//   * for an ordinary account the restore pass admitted it — a reset link
//     worked as a magic link, letting somebody into the workspace without ever
//     setting a password;
//   * for a `must_change_password` account it signed them straight out, the
//     link spent in silence, for exactly the person most likely to be using
//     one.
//
// Both are asserted below. The fake reproduces the real arrival faithfully —
// session already present AND the fragment still on `window.location` — which
// is what lets a provider that keys on the event alone fail here, as it would
// in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { createFakeSupabase, type FakeSupabase } from "./_fake-supabase";
import { renderGate, signIn, ALICE, BOB, fillAndSubmit, click } from "./_auth-recovery-support";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = "";
});

beforeEach(() => {
  window.location.hash = "";
});

function fakeFor(overrides: Partial<Parameters<typeof createFakeSupabase>[0]> = {}) {
  return createFakeSupabase({
    profiles: [{ ...ALICE }, { ...BOB }],
    passwords: { [ALICE.email]: "correct-horse", [BOB.email]: "battery-staple" },
    ...overrides,
  });
}

describe("asking for a reset link", () => {
  it("offers the link on a real backend", async () => {
    await renderGate(fakeFor());

    expect(screen.getByRole("button", { name: "Forgot your password?" })).toBeInTheDocument();
  });

  it("sends the typed address, with a redirect back to this page", async () => {
    // The redirect is derived from the location rather than configured, so it
    // is right on dev and production without a fourth build secret. Asserting
    // it here is what stops that derivation silently changing.
    const fake = fakeFor();
    await renderGate(fake);

    await click("Forgot your password?");
    await fillAndSubmit("Work email", ALICE.email, "Email me a reset link");

    expect(fake.resetRequests).toHaveLength(1);
    expect(fake.resetRequests[0].email).toBe(ALICE.email);
    expect(fake.resetRequests[0].redirectTo).toBe(
      `${window.location.origin}${window.location.pathname}`
    );
  });

  it("says a link is on its way without claiming it was sent", async () => {
    const fake = fakeFor();
    await renderGate(fake);

    await click("Forgot your password?");
    await fillAndSubmit("Work email", ALICE.email, "Email me a reset link");

    // "on its way", not "sent": on the free tier the mailer caps at about two
    // an hour and the shared sender lands in spam. Nothing in the browser can
    // know either, so nothing in the browser claims otherwise.
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/reset link is on its way/i);
    expect(notice).toHaveTextContent(/ask an admin/i);
    expect(screen.queryByText(/we sent|email sent|check your inbox for the email we sent/i))
      .toBeNull();
  });

  it("ANTI-ENUMERATION: an address with no account gets the identical sentence", async () => {
    // The form must not become a way to discover which addresses have
    // accounts. Supabase answers the same for both, the fake answers the same
    // for both, and this asserts the screen does too — by comparing the two
    // renderings rather than by matching a message, so a future edit that
    // diverged them would fail even if both new messages looked reasonable.
    const known = fakeFor();
    await renderGate(known);
    await click("Forgot your password?");
    await fillAndSubmit("Work email", ALICE.email, "Email me a reset link");
    const forKnown = (await screen.findByRole("status")).textContent;

    cleanup();
    window.location.hash = "";

    const unknown = fakeFor();
    await renderGate(unknown);
    await click("Forgot your password?");
    await fillAndSubmit("Work email", "nobody@example.com", "Email me a reset link");
    const forUnknown = (await screen.findByRole("status")).textContent;

    expect(forUnknown).toBe(forKnown);
  });

  it("refuses an address with no @ before spending a request", async () => {
    const fake = fakeFor();
    await renderGate(fake);

    await click("Forgot your password?");
    await fillAndSubmit("Work email", "not-an-address", "Email me a reset link");

    expect(await screen.findByRole("alert")).toHaveTextContent(/work email address/i);
    expect(fake.resetRequests).toHaveLength(0);
  });

  it("names the rate limit rather than pretending a link is coming", async () => {
    // The failure that has actually happened here. Reporting the usual
    // sentence would send somebody to wait for an email that was never sent.
    const fake = fakeFor();
    fake.resetFailure = "email rate limit exceeded";
    await renderGate(fake);

    await click("Forgot your password?");
    await fillAndSubmit("Work email", ALICE.email, "Email me a reset link");

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many reset emails/i);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("following the link", () => {
  it("THE REGRESSION: holds a recovery session instead of admitting it", async () => {
    // Before this, the restore pass treated a recovery session like any other
    // and called setSession — a reset link acting as a magic link. The session
    // is real and present; what changed is that it is no longer published.
    const fake = fakeFor({ recovery: { userId: ALICE.id } });

    await renderGate(fake);

    expect(await screen.findByText("Choose a new password")).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
    expect(fake.session).not.toBeNull();
  });

  it("THE OTHER HALF: a must-change-password account is not signed out on arrival", async () => {
    // The restore pass discards any session whose account still holds the
    // password it was handed. That is right for a restore and wrong for a
    // reset link — it spent the link, silently, for the one person who most
    // needed it to work.
    const fake = fakeFor({ recovery: { userId: ALICE.id } });
    fake.profiles[0].must_change_password = true;

    await renderGate(fake);

    expect(await screen.findByText("Choose a new password")).toBeInTheDocument();
    expect(fake.signOutCalls).toBe(0);
  });

  it("CONTROL: an ordinary restored session still lands in the workspace", async () => {
    // Without this, every assertion above would pass against a provider that
    // had stopped admitting anybody at all.
    const fake = fakeFor({ signedInAs: ALICE.id });

    await renderGate(fake);

    await waitFor(() => expect(screen.getByText("THE APP")).toBeInTheDocument());
  });

  it("sets the new password, signs out, and sends them back to sign in", async () => {
    // Signing out is the design, not tidiness: a recovery session is aal1 and
    // proves inbox access, not a second factor. The next sign-in runs every
    // gate in order.
    const fake = fakeFor({ recovery: { userId: ALICE.id } });
    await renderGate(fake);
    await screen.findByText("Choose a new password");

    await fillTwice("replaced-by-link", "Set password");

    expect(fake.passwordUpdates).toEqual(["replaced-by-link"]);
    expect(fake.signOutCalls).toBe(1);
    expect(await screen.findByText("Welcome to Lumina")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(/password updated/i);
    expect(screen.queryByText("THE APP")).toBeNull();
  });

  it("CONTROL: the new password then actually signs in, and the old one does not", async () => {
    // The assertion that separates a real change from a call that returned
    // and did nothing.
    const fake = fakeFor({ recovery: { userId: ALICE.id } });
    await renderGate(fake);
    await screen.findByText("Choose a new password");
    await fillTwice("replaced-by-link", "Set password");
    await screen.findByText("Welcome to Lumina");

    await signIn(ALICE.email, "correct-horse");
    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect email or password/i);

    await signIn(ALICE.email, "replaced-by-link");
    await waitFor(() => expect(screen.getByText("THE APP")).toBeInTheDocument());
  });

  it("refuses a short password without spending the link", async () => {
    const fake = fakeFor({ recovery: { userId: ALICE.id } });
    await renderGate(fake);
    await screen.findByText("Choose a new password");

    await fillTwice("short", "Set password");

    expect(await screen.findByRole("alert")).toHaveTextContent(/8 characters/i);
    expect(fake.passwordUpdates).toEqual([]);
    expect(fake.signOutCalls).toBe(0);
  });

  it("refuses a mismatch locally", async () => {
    const fake = fakeFor({ recovery: { userId: ALICE.id } });
    await renderGate(fake);
    await screen.findByText("Choose a new password");

    await fillTwice("replaced-by-link", "Set password", "replaced-by-lynk");

    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/i);
    expect(fake.passwordUpdates).toEqual([]);
  });
});

/** Fill both password fields on the recover step and submit. */
async function fillTwice(value: string, button: string, again = value) {
  await fillAndSubmit("New password", value, button, [["Type it again", again]]);
}
