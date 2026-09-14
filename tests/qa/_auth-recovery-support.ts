// Harness for tests/qa/password-recovery.test.ts.
//
// Not a test file (it does not match `tests/**/*.test.ts`) — just the mocks and
// helpers that file needs. Split out because the module mocks must be hoisted
// above the imports they affect, and `auth-supabase.test.ts` already owns an
// identical set: duplicating them inline in a second test file is how two
// suites end up disagreeing about what `backendKind` is.
import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

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
import { AuthProvider } from "@/lib/auth";
import type { FakeSupabase } from "./_fake-supabase";

const h = React.createElement;

export const ALICE = {
  id: "11111111-1111-4111-8111-111111111111",
  handle: "alice",
  email: "alice@example.com",
  mfa_required: false,
};

export const BOB = {
  id: "22222222-2222-4222-8222-222222222222",
  handle: "bob",
  email: "bob@example.com",
  mfa_required: false,
};

/** AuthProvider + AuthGate — enough for the gate and the login screen. */
export async function renderGate(fake: FakeSupabase, app = "THE APP") {
  const out = render(
    h(AuthProvider, { client: fake.client }, h(AuthGate, null, h("div", null, app)))
  );
  await waitFor(() => expect(screen.queryByText("Securing your session…")).toBeNull());
  return out;
}

export async function signIn(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
  });
}

export async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/**
 * Fill one or more labelled fields and press a button.
 *
 * `extra` carries additional `[label, value]` pairs, so the two-field password
 * steps do not need a second helper that could drift from this one.
 */
export async function fillAndSubmit(
  label: string,
  value: string,
  button: string,
  extra: [string, string][] = []
) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  for (const [otherLabel, otherValue] of extra) {
    fireEvent.change(screen.getByLabelText(otherLabel), { target: { value: otherValue } });
  }
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
  });
}
