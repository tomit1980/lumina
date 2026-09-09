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

  // final-review.md finding 3. The channel reports `online: true` every time
  // it is healthy — on the first `SUBSCRIBED` of a page load, and again after
  // every re-join — so a store that reloads whenever it is true costs a
  // redundant whole-workspace fetch each time. The review logged
  // `true,false,true,false,true,false,true` across one sign-out/sign-in:
  // four of them. There is only something to recover when the socket was
  // DOWN and has come back.
  it("does not reload for a repeated online: true — only for the transition back up", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const before = backend.hydrateCalls;

    backend.emit({ kind: "connection", online: true });
    backend.emit({ kind: "connection", online: true });
    // A barrier, not a sleep, and not `waitFor(() => connected === true)` —
    // which is already true and would resolve before the apply core had
    // looked at either event. The apply core defers every event by a
    // macrotask, in FIFO order, so once THIS one is on screen both of those
    // have had their turn to be wrong. (`_support.ts` records the same trap
    // for `backend.emitted`.)
    backend.emit({ kind: "presence", onlineUserIds: ["u_maya"] });
    await waitFor(() =>
      expect(result.current.state.users.find((u) => u.id === "u_maya")!.presence)
        .toBe("online"));

    // The reload is issued from an EFFECT, so the render the events caused
    // has to be followed by its effects before "no reload" means anything.
    await act(async () => {});
    expect(backend.hydrateCalls).toBe(before);

    // The control: a real drop and recovery still costs exactly one reload,
    // so the assertion above is about redundancy and not about a store that
    // has stopped reloading altogether.
    backend.emit({ kind: "connection", online: false });
    await waitFor(() => expect(result.current.connected).toBe(false));
    backend.emit({ kind: "connection", online: true });
    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));
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
