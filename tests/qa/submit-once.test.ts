// @vitest-environment jsdom
//
// QA-126 (Low, but only on the demo) — no in-flight guard on dialog submits,
// so a double-click created two.
//
// Every create/save dialog was an async handler with no busy state. On the
// local backend the round trip is a resolved promise and the window is
// sub-millisecond, so nothing showed; on Supabase it is a real network call,
// and a double-click or a held Enter made two projects, two channels, two
// tasks or two roles.
//
// The guard has to be a REF, not the state flag, and that is what these tests
// are really about: a second click can arrive in the same tick as the first,
// before React has re-rendered with `pending: true`. A state-only guard reads
// `false` on that second click and lets it through — which is exactly the
// double-click case, so a state-only "fix" would have looked right and fixed
// nothing.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSubmitOnce } from "@/components/use-submit-once";

afterEach(cleanup);

/** A promise the test decides when to resolve — an in-flight network call. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useSubmitOnce (QA-126)", () => {
  it("ignores a second call made while the first is still in flight", async () => {
    const gate = deferred();
    const fn = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useSubmitOnce(fn));

    // Both in the SAME tick, which is the double-click. No await between
    // them, so React has not re-rendered and a state-only guard would not
    // have been set yet.
    await act(async () => {
      void result.current[0]();
      void result.current[0]();
    });

    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
  });

  it("CONTROL: allows a second call once the first has finished", async () => {
    // Without this, a guard that latched shut permanently would pass the test
    // above while making every dialog single-use.
    const fn = vi.fn(async () => {});
    const { result } = renderHook(() => useSubmitOnce(fn));

    await act(async () => {
      await result.current[0]();
    });
    await act(async () => {
      await result.current[0]();
    });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("releases the guard even when the handler throws", async () => {
    // A refused write must not leave the dialog permanently unable to retry.
    const failing = vi.fn(async () => {
      throw new Error("refused");
    });
    const { result } = renderHook(() => useSubmitOnce(failing));

    await act(async () => {
      await result.current[0]().catch(() => {});
    });
    await act(async () => {
      await result.current[0]().catch(() => {});
    });

    expect(failing).toHaveBeenCalledTimes(2);
  });
});
