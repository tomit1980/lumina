// @vitest-environment jsdom
//
// Suite — connection lifecycle (Plan "realtime-and-presence", Task 5):
// `{ kind: "connection"; online: boolean }` and the store's `connected` flag.
//
// Why this task decides whether any of the rest is trustworthy: when the
// socket drops, changes that happened meanwhile are simply gone — the server
// does not replay them. A client that reconnects without reloading is
// silently stale, which is worse than looking offline, because people act on
// what they see. So there are exactly two things to prove here:
//   1. going back online triggers exactly one reload (the only way to
//      recover what was missed while disconnected);
//   2. `connected` actually reflects the last event, both ways — it must
//      flip false on a drop AND flip back true on reconnect, not get stuck
//      either direction.
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ConnectionStatus } from "@/components/connection-status";
import { StoreProvider } from "@/lib/store";
import { EventBackend, adminState, mount } from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("connection events", () => {
  // The brief's own test. Two assertions folded into one: if a mutation
  // never flips `connected` back to `true` on reconnect, the last line
  // reddens; if a mutation never issues the reconnect reload, the
  // `hydrateCalls` wait times out. Either cheap mutation kills this alone.
  it("reloads on reconnect, because events missed while offline are gone", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const before = backend.hydrateCalls;

    backend.emit({ kind: "connection", online: false });
    await waitFor(() => expect(result.current.connected).toBe(false));
    backend.emit({ kind: "connection", online: true });

    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));
    expect(result.current.connected).toBe(true);
  });

  // Defaults to connected. This is the half that keeps the other 33 suites
  // that mount `StoreProvider` without ever emitting a `connection` event
  // meaningful: if the default were `false`, every one of them would render
  // — and, for any that assert on it, silently pass — a permanently
  // "disconnected" workspace that never had a dropped socket at all.
  it("starts connected, before any connection event has ever landed", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);

    expect(result.current.connected).toBe(true);
  });

  // Going offline must not, by itself, cost a reload — there is nothing to
  // recover yet, and reloading while offline would just fail. Only the
  // transition back to online does. A mutation that reloads on every
  // `connection` event regardless of `online` would turn this red.
  it("does not reload merely for going offline", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const before = backend.hydrateCalls;

    backend.emit({ kind: "connection", online: false });
    await waitFor(() => expect(result.current.connected).toBe(false));

    expect(backend.hydrateCalls).toBe(before);
  });
});

// `ConnectionStatus` itself — the visible half. Rendered for real (not just
// through the hook), so these prove what actually reaches the DOM, not just
// what `useStore()` returns.
describe("ConnectionStatus", () => {
  function mountStatus(backend: EventBackend) {
    return render(
      React.createElement(StoreProvider, { backend }, React.createElement(ConnectionStatus))
    );
  }

  it("renders nothing while connected — the normal case is visually unchanged", async () => {
    const backend = new EventBackend();
    await act(async () => {
      mountStatus(backend);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders a quiet status line once disconnected", async () => {
    const backend = new EventBackend();
    await act(async () => {
      mountStatus(backend);
    });

    backend.emit({ kind: "connection", online: false });

    // Positive control for the test above: the same tree, the same backend,
    // now actually showing something — so "renders nothing" up there cannot
    // be an artifact of the component never rendering at all.
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("clears the status line once reconnected", async () => {
    const backend = new EventBackend();
    await act(async () => {
      mountStatus(backend);
    });

    backend.emit({ kind: "connection", online: false });
    await screen.findByRole("status");

    backend.emit({ kind: "connection", online: true });

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
