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

  // NAMED for what it actually covers, after the final review (finding 9).
  // It used to be called "a failed write after a live update reloads instead
  // of rewinding past it", which claims the second-writer guarantee — and it
  // does not test it: `FailingBackend` rejects in a microtask while the apply
  // path is a macrotask, so the rollback always wins and there is no
  // interleaving to survive (its own comment said so). It passes with or
  // without the `writeSeq` bump. What it DOES cover is worth keeping: a live
  // update landing around a failed write is not lost. The guarantee itself is
  // tested in the next block, where the write is really held open.
  it("keeps a live update that lands around a failed write", async () => {
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

    // The write was refused and undone, and the live message is still here —
    // by the rollback having already finished, in this test's timing, rather
    // than by the second-writer rule. See the block above.
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

/**
 * The SECOND reload path, and the hole the final review found in it
 * (finding 1, blocking).
 *
 * A reconnect and a sign-in do not recover through the `stale` path at all.
 * They bump `hydrateAttempt`, which re-runs the hydration effect — and that
 * effect used to `adopt()` a whole fresh `AppState` while bumping nothing and
 * checking nothing. So a write in flight kept its number, the reload landed on
 * top of it invisibly, and when the write was then refused the rollback found
 * `writeSeq` unchanged, restored the PRE-RELOAD snapshot, and silently erased
 * everything the reconnect had just recovered. On the one path whose entire
 * purpose is recovering data, at the one moment — a network blip — when a
 * failing write and a reconnecting socket are most likely to coincide.
 *
 * `ReloadRaceBackend` is what makes that interleaving real: it holds BOTH the
 * reload and the write open, so the test decides the order rather than the
 * event loop happening to.
 */
class ReloadRaceBackend extends EventBackend {
  private failWrite: (() => void) | null = null;
  private landReload: ((state: AppState) => void) | null = null;

  /** What the SERVER holds: the refused rename undone, and the message that
   *  arrived while this browser's socket was down. */
  constructor(private readonly serverState: () => AppState) {
    super();
  }

  override hydrate(): Promise<AppState> {
    const stored = super.hydrate(); // counts the call, whatever happens next
    // 1 is the mount. 2 is the reconnect reload, and it PENDS until the test
    // lands it — that is the whole point. 3 onwards is the rollback's own
    // re-hydrate, which must answer with the server's truth so "re-hydrated"
    // is distinguishable from "restored a snapshot".
    if (this.hydrateCalls === 1) return stored;
    if (this.hydrateCalls === 2) {
      return new Promise<AppState>((resolve) => {
        this.landReload = resolve;
      });
    }
    return Promise.resolve(clone(this.serverState()));
  }

  /** Lands the reconnect reload. */
  land(): void {
    this.landReload?.(clone(this.serverState()));
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

describe("a reconnect reload is a second writer too", () => {
  it("keeps what the reload recovered when a write then fails on top of it", async () => {
    const seeded = adminState();
    const project = seeded.projects[0];
    /** What was posted while this browser's socket was down. The server does
     *  not replay it; the reload is the only thing that can recover it. */
    const recovered = {
      id: "m_recovered", channelId: "c_general", authorId: "u_maya",
      content: "posted while the socket was down", createdAt: Date.now(),
      reactions: [], attachments: [],
    };
    const backend = new ReloadRaceBackend(() => ({
      ...seeded,
      messages: [...seeded.messages, recovered],
    }));
    const { result } = await mount(seeded, backend);

    // 1. The socket drops and comes back, so the store reloads to recover
    //    what it missed. That reload is now in flight and holding.
    backend.emit({ kind: "connection", online: false });
    await waitFor(() => expect(result.current.connected).toBe(false));
    backend.emit({ kind: "connection", online: true });
    await waitFor(() => expect(backend.hydrateCalls).toBe(2));

    // 2. The user changes something while it is still in flight.
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.updateProject(project.id, { name: "renamed" });
    });
    expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
      .toBe("renamed");

    // 3. The reload lands, bringing the missed message with it.
    await act(async () => {
      backend.land();
    });
    await waitFor(() =>
      expect(result.current.state.messages.some((m) => m.id === "m_recovered"))
        .toBe(true));

    // 4. Only now does the server refuse the write.
    backend.refuse();
    await act(async () => {
      expect(await pending).toBe(false);
    });

    // The rename is gone, as a refused write's should be...
    expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
      .toBe(project.name);
    // ...and the recovered message is NOT. Restoring the pre-reload snapshot
    // would have shown the same project name and taken the message with it,
    // with no error and no toast beyond "Couldn't save".
    expect(result.current.state.messages.some((m) => m.id === "m_recovered"))
      .toBe(true);
  });

  it("holds a reconnect reload that arrives while a write is already in flight", async () => {
    // Rule 3 on this path, which the `stale` path has had all along. Fake
    // timers for the same reason the `stale` version needs them: proving a
    // reload did NOT happen means waiting out the window it would have
    // happened in, and `waitFor` cannot express an absence.
    vi.useFakeTimers();
    try {
      const seeded = adminState();
      const project = seeded.projects[0];
      const backend = new ReloadRaceBackend(() => seeded);
      const { result } = await mount(seeded, backend);

      let pending!: Promise<boolean>;
      act(() => {
        pending = result.current.updateProject(project.id, { name: "renamed" });
      });
      const before = backend.hydrateCalls;

      backend.emit({ kind: "connection", online: false });
      backend.emit({ kind: "connection", online: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      // Not even ASKED for: a reload issued here would replace the
      // unconfirmed optimistic rename with a server state that does not have
      // it, and the write's own rollback would then be reasoning about a
      // state it never patched.
      expect(backend.hydrateCalls).toBe(before);
      expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
        .toBe("renamed");

      // The write settles, and the held reload then runs — so this is a
      // deferral, not a reload that was dropped.
      backend.refuse();
      await act(async () => {
        expect(await pending).toBe(false);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(backend.hydrateCalls).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Presence across a reload (finding 2).
 *
 * `LocalBackend.hydrate()` reads back the presence the persist effect just
 * wrote, so no suite in this repo could see this: hydrating from localStorage
 * hands the dots straight back. A REAL backend cannot — a profile row does not
 * know who has a tab open, so `toUser` maps everyone to `"offline"` — and the
 * only thing that ever says otherwise is a `presence` event off the channel.
 * A reload that adopted a hydrate verbatim therefore blanked every dot, on
 * every coalesced `stale` reload, which is most workspace changes.
 */
class RowsOnlyBackend extends EventBackend {
  constructor(private readonly rows: () => AppState) {
    super();
  }

  override hydrate(): Promise<AppState> {
    void super.hydrate(); // counts the call
    const server = clone(this.rows());
    return Promise.resolve({
      ...server,
      users: server.users.map((u) => ({ ...u, presence: "offline" as const })),
    });
  }
}

describe("a reload does not blank presence", () => {
  it("keeps the dots the channel lit, because rows cannot know who is here", async () => {
    const seeded = adminState();
    const backend = new RowsOnlyBackend(() => seeded);
    const { result } = await mount(seeded, backend);
    const presenceOf = (id: string) =>
      result.current.state.users.find((u) => u.id === id)!.presence;

    backend.emit({ kind: "presence", onlineUserIds: ["u_maya"] });
    await waitFor(() => expect(presenceOf("u_maya")).toBe("online"));

    const before = backend.hydrateCalls;
    backend.emit({ kind: "stale" });
    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));

    // The reload answered with rows, and rows say nothing about who is here.
    expect(presenceOf("u_maya")).toBe("online");
    // The other half of the presence rule still holds across it: someone the
    // channel did not name is offline, so this is not "presence frozen".
    expect(presenceOf("u_sam")).toBe("offline");
  });

  it("still takes the channel's word for it after a reload — presence is not latched", async () => {
    // The control. Carrying presence across a reload would be worthless if it
    // also made the carried value permanent: a dot that survives a reload but
    // never clears is the stale dot the brief calls worse than no dot at all.
    const seeded = adminState();
    const backend = new RowsOnlyBackend(() => seeded);
    const { result } = await mount(seeded, backend);
    const presenceOf = (id: string) =>
      result.current.state.users.find((u) => u.id === id)!.presence;

    backend.emit({ kind: "presence", onlineUserIds: ["u_maya"] });
    await waitFor(() => expect(presenceOf("u_maya")).toBe("online"));

    const before = backend.hydrateCalls;
    backend.emit({ kind: "stale" });
    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));

    // Maya closes her tab; Sam opens one.
    backend.emit({ kind: "presence", onlineUserIds: ["u_sam"] });
    await waitFor(() => expect(presenceOf("u_sam")).toBe("online"));
    expect(presenceOf("u_maya")).toBe("offline");
  });

  it("lights a user the reload INTRODUCES — the sign-in case a browser found", async () => {
    // Found in the browser, not here: after signing in, no dot ever lit —
    // not even the signing-in user's own — until somebody happened to join
    // or leave. The order is the cause. The channel re-joins as the new
    // identity and tracks it immediately, so the `presence` event lands while
    // the store still holds the SIGNED-OUT SHELL, whose user list contains
    // nobody it names; the reload that fetches the real workspace arrives
    // after. Carrying presence forward user-by-user has nothing to carry
    // across that gap — the set does.
    const shell: AppState = { ...adminState(), users: [], currentUserId: "" };
    const real = adminState();
    const backend = new SignInBackend(shell, real);
    const { result } = await mount(real, backend);

    // The shell: no users at all, so the event below cannot be applied to
    // anything yet.
    expect(result.current.state.users).toEqual([]);
    backend.emit({ kind: "presence", onlineUserIds: ["u_maya"] });

    // Sign-in's reload brings the workspace.
    backend.emit({ kind: "stale" });
    await waitFor(() =>
      expect(result.current.state.users.length).toBeGreaterThan(0));

    const presenceOf = (id: string) =>
      result.current.state.users.find((u) => u.id === id)!.presence;
    expect(presenceOf("u_maya")).toBe("online");
    // And nobody else was lit by accident.
    expect(presenceOf("u_sam")).toBe("offline");
  });
});

/** Hydrates the signed-out shell first and the real workspace afterwards —
 *  what a sign-in actually looks like through the `Backend` seam. Rows only,
 *  everybody offline, for the same reason as `RowsOnlyBackend`. */
class SignInBackend extends EventBackend {
  constructor(
    private readonly shell: AppState,
    private readonly real: AppState
  ) {
    super();
  }

  override hydrate(): Promise<AppState> {
    void super.hydrate(); // counts the call
    const server = clone(this.hydrateCalls === 1 ? this.shell : this.real);
    return Promise.resolve({
      ...server,
      users: server.users.map((u) => ({ ...u, presence: "offline" as const })),
    });
  }
}
