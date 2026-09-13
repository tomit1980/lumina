// @vitest-environment jsdom
//
// The sign-in screen's refusals, as assistive technology receives them.
//
// WHY THIS FILE EXISTS. An independent audit (Astra 6.0, 2026-09-11) filed
// LUM-QA-001: the error was "an ordinary paragraph. Neither it nor its
// ancestors has role=alert or aria-live. Inputs lack aria-describedby and
// aria-invalid." It was right — `FormError` was a bare `<motion.p>`, and the
// only signal that anything had happened was red text appearing.
//
// The audit's stated limit was that it could not test screen-reader audio, and
// that is ours too. So these assert what a screen reader reads FROM: the role,
// the attributes, and where focus went. A test that claimed to prove
// "announced" would be claiming something neither of us measured.
//
// Every negative here is paired, because "no element is aria-invalid" passes
// beautifully against a screen that failed to render.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as React from "react";

vi.mock("@/lib/backend", () => ({ backendKind: "supabase" }));

import { LoginScreen } from "@/components/auth/login-screen";
import type { LoginOutcome } from "@/lib/auth";

const h = React.createElement;

/** Only what LoginScreen reads off `useAuth`. */
const auth = {
  login: vi.fn<(id: string, pw: string) => Promise<LoginOutcome>>(),
  submitLoginTotp: vi.fn(),
  submitEnrollment: vi.fn(),
  submitFirstPassword: vi.fn(),
  cancelPendingLogin: vi.fn(),
  loginEnrollment: null,
};
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  useAuth: () => auth,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function signIn(
  email: string,
  password: string,
  opts: { focusButtonFirst?: boolean } = {}
) {
  render(h(LoginScreen));
  if (email) {
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: email } });
  }
  if (password) {
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  }
  const button = screen.getByRole("button", { name: /sign in/i });
  if (opts.focusButtonFirst) button.focus();
  await act(async () => {
    fireEvent.click(button);
  });
}

describe("a refused sign-in, as a screen reader receives it", () => {
  it("announces the refusal and associates it with the fields", async () => {
    auth.login.mockResolvedValue({
      step: "error",
      message: "Incorrect email or password.",
    });

    await signIn("someone@example.com", "wrong");

    // `role="alert"` is implicitly aria-live="assertive" — the refusal
    // interrupts, which is right for something that blocks the only action.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Incorrect email or password.");

    // And the fields point AT it, so moving to one reads the reason rather
    // than leaving the person to hunt for it.
    const email = screen.getByLabelText("Work email");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email.getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
  });

  it("CONTROL: nothing is marked invalid before a submission", async () => {
    // Without this, the assertions above would pass just as well against a
    // screen that painted aria-invalid on unconditionally — which is the same
    // amount of information as never painting it at all.
    render(h(LoginScreen));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Work email")).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("aria-invalid", "true");
  });
});

describe("where focus goes", () => {
  // `field` on the outcome is what the screen steers by. The store decides it
  // (tests/qa/auth-supabase.test.ts asserts that); here the question is only
  // whether the screen honours it.
  it("moves to the email field when the address is the problem", async () => {
    // The audit found focus "remains on the button" after an empty submit and
    // "was reported on the page" after an async refusal. The second is worse:
    // focus on the body means the next Tab starts from the top of the
    // document, and nothing has been said.
    auth.login.mockResolvedValue({
      step: "error",
      message: "Sign in with your work email address.",
      field: "email",
    });

    // Focus is parked on the button first, deliberately. `autoFocus` already
    // puts it on the email field, so without this the assertion passes whether
    // or not anything moves it — which mutation testing caught: removing the
    // focus call reddened only the password case.
    await signIn("not-an-address", "hunter2", { focusButtonFirst: true });

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Work email"))
    );
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("moves to the password field when THAT is the problem", async () => {
    // The discriminating half. If focus always went to the email field, the
    // test above would pass while the behaviour was wrong for every refusal
    // about a password.
    auth.login.mockResolvedValue({
      step: "error",
      message: "Enter your password.",
      field: "password",
    });

    await signIn("someone@example.com", "");

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Password"))
    );
    expect(screen.getByLabelText("Work email")).not.toHaveAttribute("aria-invalid", "true");
  });
});
