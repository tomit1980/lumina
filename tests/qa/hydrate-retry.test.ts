// @vitest-environment jsdom
//
// Task 4 — what `StoreProvider` does when `hydrate()` rejects.
//
// `LocalBackend.hydrate()` cannot fail: it reads localStorage and falls back
// to a seed. A real backend fails routinely — a dropped connection, an expired
// session, a database that is briefly unreachable — and the three ways to get
// that wrong are a blank page, a spinner that never stops, and a silent fall
// back to seed data. The last is the worst: it would show a real user
// fictional colleagues and let them type into a workspace that does not exist.
//
// Every negative assertion below is paired with a positive control, so a
// provider that rendered *nothing at all* could not pass this file.
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import { LocalBackend } from "@/lib/backend/local";
import type { AppState } from "@/lib/types";
import { StoreProvider, useStore } from "@/lib/store";

const h = React.createElement;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Rejects the first `failures` hydrate calls, then behaves like the local
 *  one (which resolves with the seed — deliberately, so the "no silent seed"
 *  assertion below has something real to catch if the provider ever falls
 *  back on failure). */
class FlakyHydrateBackend extends LocalBackend {
  calls = 0;
  constructor(private readonly failures: number) {
    super();
  }
  override hydrate(): Promise<AppState> {
    this.calls += 1;
    return this.calls <= this.failures
      ? Promise.reject(new Error("network is down"))
      : super.hydrate();
  }
}

/** Renders something only reachable once the store has state. */
function Probe() {
  const { currentUser } = useStore();
  return h("div", null, `signed in as ${currentUser.name}`);
}

function mountProvider(backend: LocalBackend) {
  return render(h(StoreProvider, { backend }, h(Probe, null)));
}

describe("StoreProvider — a failed hydrate", () => {
  it("shows a plain-language retry state instead of a blank page or a spinner", async () => {
    const backend = new FlakyHydrateBackend(1);
    mountProvider(backend);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn’t load your workspace/i);
    // Plain language, not an error code or a stack trace.
    expect(alert).toHaveTextContent(/connection problem/i);
    expect(alert).toHaveTextContent(/nothing has been lost/i);

    // Not still spinning.
    expect(screen.queryByText(/loading lumina/i)).not.toBeInTheDocument();
    // And there is something to press.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does not fall back to seed data", async () => {
    const backend = new FlakyHydrateBackend(1);
    mountProvider(backend);
    await screen.findByRole("alert");

    // `super.hydrate()` would have produced the demo seed, whose admin is
    // Moshe Cohen. If the provider ever "recovers" by seeding, this fails.
    expect(screen.queryByText(/moshe cohen/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/signed in as/i)).not.toBeInTheDocument();
    expect(backend.calls).toBe(1);
  });

  it("retries on demand and renders the workspace when the retry succeeds", async () => {
    const backend = new FlakyHydrateBackend(1);
    mountProvider(backend);
    await screen.findByRole("alert");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });

    // Positive control for the two negatives above: the same provider, the
    // same children, now actually on screen.
    expect(await screen.findByText(/signed in as moshe cohen/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(backend.calls).toBe(2);
  });

  it("stays on the retry state when the retry also fails", async () => {
    const backend = new FlakyHydrateBackend(2);
    mountProvider(backend);
    await screen.findByRole("alert");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });

    await waitFor(() => expect(backend.calls).toBe(2));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/signed in as/i)).not.toBeInTheDocument();
  });

  it("shows no retry state at all when hydrate succeeds", async () => {
    const backend = new FlakyHydrateBackend(0);
    mountProvider(backend);

    expect(await screen.findByText(/signed in as moshe cohen/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});
