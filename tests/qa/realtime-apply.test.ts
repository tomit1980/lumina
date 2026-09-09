// @vitest-environment jsdom
//
// Suite — the apply core (Plan "realtime-and-presence", Task 2): what the
// store does with a change the *server* pushed, as opposed to one this browser
// made.
//
// The whole point of this task is that the store gains a SECOND WRITER. Every
// optimistic patch in `commit` (lib/store.tsx) snapshots the state it replaced
// and restores that snapshot if the backend refuses the write — logic written
// when this client was the only thing that could change `AppState`. A live
// update that lands between the patch and the refusal is invisible to that
// logic, and restoring the snapshot would erase it with no error and no toast.
// `writeSeq` is what makes it visible: the apply core bumps it exactly like an
// optimistic patch does, so a failing write sees that something landed on top
// of it and re-hydrates instead of rewinding.
//
// The last test of the first block and the one after it are that hazard. The
// first of them is the brief's, and it passes even against a store that never
// bumps `writeSeq` — `FailingBackend` rejects in a microtask while the apply
// path is deferred to a macrotask, so the rollback always wins the race and
// there is no interleaving to survive. The second one closes that: its backend
// refuses the write only when the test says so, which is the one way to hold a
// write genuinely in flight while the live update lands. See the comment on
// `SecondWriterBackend`.
//
// Every test here was checked by mutation, and every rule of the apply core has
// a test that kills it: dropping all events reddens all seven; dropping the
// dedup reddens the echo test; dropping the `writeSeq` bump reddens the
// second-writer test alone; dropping the `writeInFlight` guard reddens the last
// block alone. Two of those killers had to be written — see the barrier comment
// in the echo test and the preamble to the last block.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";

import type { AppState } from "@/lib/types";
import {
  EventBackend,
  FailingBackend,
  adminState,
  clone,
  mount,
  run,
} from "./_support";

afterEach(() => { cleanup(); localStorage.clear(); });

describe("live updates reach the screen", () => {
  it("appends a message that arrives from the server", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const before = result.current.state.messages.length;

    backend.emit({ kind: "message-insert", message: {
      id: "m_from_server", channelId: "c_general", authorId: "u_maya",
      content: "sent from another browser", createdAt: Date.now(),
      reactions: [], attachments: [],
    }});

    await waitFor(() =>
      expect(result.current.state.messages).toHaveLength(before + 1));
    expect(result.current.state.messages.at(-1)!.content)
      .toBe("sent from another browser");
  });

  it("does not duplicate the echo of a message this client already holds", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const sent = await run(() =>
      result.current.sendMessage("c_general", "mine"));
    expect(sent).toBe(true);
    const mine = result.current.state.messages.at(-1)!;
    const count = result.current.state.messages.length;

    backend.emit({ kind: "message-insert", message: mine });
    // A barrier, not a sleep — and not `waitFor(() => backend.emitted === 1)`,
    // which the brief reached for first. `emit()` increments `emitted`
    // SYNCHRONOUSLY, before the apply path has run at all: the apply core
    // defers every event by a macrotask (the deadlock reason lib/auth.tsx
    // records), so that wait resolves on the first tick and the assertion
    // below lands before the store has even looked at the echo. Verified
    // vacuous by mutation: breaking the dedup rule left it green.
    //
    // A second event is the honest barrier. The deferrals are `setTimeout(_,
    // 0)` and so run in FIFO order, so once the sentinel is on screen the echo
    // has already had its turn to be wrong.
    backend.emit({ kind: "message-insert", message: {
      ...mine, id: "m_sentinel", content: "after the echo",
    }});

    await waitFor(() =>
      expect(result.current.state.messages.some((m) => m.id === "m_sentinel"))
        .toBe(true));
    // The echo did not land a second time...
    expect(result.current.state.messages.filter((m) => m.id === mine.id))
      .toHaveLength(1);
    // ...and nothing else did either: the sentinel is the only new message.
    expect(result.current.state.messages).toHaveLength(count + 1);
  });

  it("coalesces a burst of stale events into exactly one reload", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const before = backend.hydrateCalls;

    for (let i = 0; i < 5; i++) backend.emit({ kind: "stale" });

    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));
    // And it stays one: no trailing reload per event.
    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));
    expect(result.current.state).not.toBeNull();
  });

  // The control that keeps the assertion above from being a statement about a
  // coalescer that simply latched shut. "Exactly one reload per burst" is only
  // meaningful if a LATER burst still reloads; without this, an apply core that
  // ignored `stale` after the first one would look identical.
  it("reloads again for a later burst — the coalescer does not latch", async () => {
    const backend = new EventBackend();
    await mount(adminState(), backend);
    const before = backend.hydrateCalls;

    backend.emit({ kind: "stale" });
    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));

    backend.emit({ kind: "stale" });
    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 2));
  });

  it("a failed write after a live update reloads instead of rewinding past it", async () => {
    // The second-writer hazard, and the most important test in this plan.
    const backend = new FailingBackend("updateProject");
    const { result } = await mount(adminState(), backend);
    const project = result.current.state.projects[0];

    const pending = run(() =>
      result.current.updateProject(project.id, { name: "renamed" }));
    backend.emit({ kind: "message-insert", message: {
      id: "m_during", channelId: "c_general", authorId: "u_maya",
      content: "arrived mid-write", createdAt: Date.now(),
      reactions: [], attachments: [],
    }});
    await pending;

    // The write was refused and undone, but the live message must survive:
    // rewinding to the pre-write snapshot would erase it silently.
    expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
      .toBe(project.name);
    await waitFor(() =>
      expect(result.current.state.messages.some((m) => m.id === "m_during"))
        .toBe(true));
  });
});

/**
 * The same hazard, with the race actually run.
 *
 * `FailingBackend` rejects synchronously (`Promise.reject`), so its rollback
 * runs a microtask after the action is called, while the apply core is
 * deliberately deferred by a macrotask (`setTimeout`, for the deadlock reason
 * lib/auth.tsx records). The rollback therefore ALWAYS completes before the
 * live update lands, and the message is appended to the already-restored
 * state — which is why the test above passes with or without the `writeSeq`
 * bump that makes the second writer visible.
 *
 * A real backend does not reject in a microtask; it rejects after a round
 * trip. This double models that by handing the test the reject function, which
 * is the only way to hold a write genuinely in flight while an event lands.
 *
 * `hydrate()` answers with the SERVER's truth from the second call on — the
 * rename refused, the pushed message kept — so "re-hydrated" is
 * distinguishable from "restored a snapshot". (Without it `LocalBackend`
 * re-reads localStorage, which the persist effect has already filled with the
 * optimistic rename, and the re-hydrate branch would look like a failure.)
 */
class SecondWriterBackend extends EventBackend {
  private failWrite: (() => void) | null = null;

  constructor(private readonly serverState: () => AppState) {
    super();
  }

  override hydrate(): Promise<AppState> {
    // `super.hydrate()` is what counts the call, so it runs either way.
    const stored = super.hydrate();
    return this.hydrateCalls > 1
      ? Promise.resolve(clone(this.serverState()))
      : stored;
  }

  /** Pends until `refuse()` is called — a write in flight, as one really is. */
  override updateProject(): Promise<void> {
    return new Promise<void>((_resolve, reject) => {
      this.failWrite = () => reject(new Error("updateProject failed"));
    });
  }

  refuse(): void {
    this.failWrite?.();
  }
}

describe("the second-writer hazard, with the write really in flight", () => {
  it("re-hydrates rather than rewinding over a live update that landed mid-write", async () => {
    const seeded = adminState();
    const project = seeded.projects[0];
    const live = {
      id: "m_during", channelId: "c_general", authorId: "u_maya",
      content: "arrived mid-write", createdAt: Date.now(),
      reactions: [], attachments: [],
    };
    // What the server holds once the write is refused: the original name, and
    // the message it pushed.
    const backend = new SecondWriterBackend(() => ({
      ...seeded,
      messages: [...seeded.messages, live],
    }));
    const { result } = await mount(seeded, backend);

    // 1. The optimistic rename is on screen, and the write is still in flight.
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.updateProject(project.id, { name: "renamed" });
    });
    expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
      .toBe("renamed");

    // 2. A live update lands ON TOP of that patch, before the write settles.
    backend.emit({ kind: "message-insert", message: live });
    await waitFor(() =>
      expect(result.current.state.messages.some((m) => m.id === "m_during"))
        .toBe(true));

    // 3. Only now does the server refuse the write.
    const hydratesBefore = backend.hydrateCalls;
    backend.refuse();
    await act(async () => {
      expect(await pending).toBe(false);
    });

    // The rename is gone — and so is any doubt about how. Restoring the
    // pre-write snapshot would ALSO have shown the original name, but it would
    // have taken `m_during` with it; the message is still here, and the reload
    // that kept it is counted.
    expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
      .toBe(project.name);
    expect(result.current.state.messages.some((m) => m.id === "m_during"))
      .toBe(true);
    expect(backend.hydrateCalls).toBe(hydratesBefore + 1);
  });
});

/**
 * Rule 3's second half, which the brief specifies but names no test for: a
 * `stale` reload must never land while a write is in flight.
 *
 * Found by mutation — deleting the `writeInFlight` guard left all six tests
 * above green, because none of them ever holds a write open across a debounce
 * window. `SecondWriterBackend` is the double that can, since its
 * `updateProject` pends until the test says otherwise.
 *
 * This is the one place in the suite that needs fake timers. Proving a reload
 * did NOT happen means waiting out the window it would have happened in, and
 * that is the asymmetry `waitFor` cannot cover: it can wait for a thing to
 * appear, not for a thing to stay absent. Fake timers make the window pass
 * deterministically rather than by sleeping through it.
 */
describe("a stale reload never lands on top of a write in flight", () => {
  // Generously past the store's debounce, without importing its constant —
  // the point is "the window went by", not the window's exact width.
  const WELL_PAST_THE_DEBOUNCE = 2_000;

  it("holds the reload until the write settles, then runs it", async () => {
    vi.useFakeTimers();
    try {
      const seeded = adminState();
      const project = seeded.projects[0];
      const backend = new SecondWriterBackend(() => seeded);
      const { result } = await mount(seeded, backend);

      let pending!: Promise<boolean>;
      act(() => {
        pending = result.current.updateProject(project.id, { name: "renamed" });
      });
      const before = backend.hydrateCalls;

      backend.emit({ kind: "stale" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WELL_PAST_THE_DEBOUNCE);
      });

      // Reloading here would replace the unconfirmed optimistic rename with a
      // server state that does not have it, and the write's own rollback would
      // then be reasoning about a state it never patched.
      expect(backend.hydrateCalls).toBe(before);
      expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
        .toBe("renamed");

      // The write settles — refused, so the rename is rolled back. Nothing
      // landed on top of it, so that rollback restores the snapshot rather
      // than re-hydrating: the reload that follows is the HELD one.
      backend.refuse();
      await act(async () => {
        expect(await pending).toBe(false);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WELL_PAST_THE_DEBOUNCE);
      });

      expect(backend.hydrateCalls).toBe(before + 1);
      expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
        .toBe(project.name);
    } finally {
      vi.useRealTimers();
    }
  });
});
