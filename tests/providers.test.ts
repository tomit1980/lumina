// @vitest-environment jsdom
//
// Task 0 (store-swap) — components/providers.tsx registers a global
// `unhandledrejection` listener as a safety net. React error boundaries
// (app/error.tsx, app/global-error.tsx) only catch throws during render and
// lifecycle methods; every store action becomes `Promise<T>` in the
// store-swap and every one of them runs from an event handler (a button's
// onClick), so a rejected call that nobody explicitly `.catch`es becomes an
// *unhandled promise rejection*, not a render throw — no boundary, no
// toast, the button just looks dead. This is the failure mode the spec
// calls the single most likely one in Phase 1.
//
// jsdom does not implement the browser's unhandled-rejection machinery: there
// is no `PromiseRejectionEvent`, and nothing bridges Node's process-level
// `unhandledRejection` to a `window` event. Bridging it here was tried and is
// actively unsafe: a genuinely-unhandled rejection anywhere during a Vitest
// run fails the *entire run* (exit code 1) via Vitest's own process-level
// detector, regardless of any listener this test also registers — verified
// empirically before writing this file. So this test dispatches, on
// `window`, the same event a real browser delivers when a promise from an
// event handler goes unhandled — driving the hook exactly the way
// production code will see it — while keeping the underlying promise itself
// handled (a no-op `.catch`) so the test run's own unhandled-rejection
// detector never trips.
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { useUnhandledRejectionToast } from "@/components/providers";

/** Simulates the browser dispatching `unhandledrejection` on `window` for a
 *  promise nobody in application code caught — see file header for why a
 *  genuinely-unhandled promise isn't used instead. */
function dispatchUnhandledRejection(reason: unknown) {
  const promise = Promise.reject(reason);
  promise.catch(() => {}); // keep Vitest's own detector from tripping
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  Object.defineProperty(event, "promise", { value: promise });
  window.dispatchEvent(event);
}

function Harness() {
  useUnhandledRejectionToast();
  return React.createElement(
    "button",
    {
      onClick: () => {
        // The shape the store-swap introduces: a fire-and-forget call to an
        // async store action with no .then/.catch/await at the call site.
        dispatchUnhandledRejection(new Error("simulated store failure"));
      },
    },
    "Do the thing"
  );
}

afterEach(() => {
  cleanup();
  toastMock.mockClear();
  toastMock.error.mockClear();
});

describe("useUnhandledRejectionToast (components/providers.tsx)", () => {
  it("a rejected promise from an event handler surfaces a toast", () => {
    render(React.createElement(Harness));
    fireEvent.click(screen.getByRole("button", { name: "Do the thing" }));

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith("That last action didn't go through", {
      description: "Something went wrong. Please try again.",
    });
  });

  // What used to be here — dispatching `new Event("some-other-event")` and
  // asserting no toast — could not fail: an event of one name can never reach
  // a listener registered for another, so it asserted that
  // `addEventListener` works rather than anything about this hook. No
  // plausible regression in the hook turned it red. It is replaced by the
  // negative that CAN: a rejection arriving after the hook has gone.
  it("stops toasting once it is unmounted", () => {
    const { unmount } = render(React.createElement(Harness));
    // A positive first, so a harness that never worked cannot pass this by
    // being broken in both directions.
    dispatchUnhandledRejection(new Error("before unmount"));
    expect(toastMock.error).toHaveBeenCalledTimes(1);

    unmount();
    dispatchUnhandledRejection(new Error("after unmount"));

    // Still one: the listener really is gone, not merely asked to go.
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it("removes its listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(React.createElement(Harness));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("unhandledrejection", expect.any(Function));
    removeSpy.mockRestore();
  });
});
