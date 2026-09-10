// @vitest-environment jsdom
//
// Suite — the chat write path against a real backend seam (Plan "store-swap",
// Task 5: sendMessage, sendToUser, editMessage, deleteMessage, toggleReaction,
// markChannelRead, openDm).
//
// Chat is the surface where the optimistic design earns its keep: nothing here
// is awaited by its call site, so what the store shows *before* the promise
// settles is the whole user-visible behaviour. Three properties, per action:
//
//  1. the patch is on screen while the write is still in flight;
//  2. a rejection restores exactly what was there and toasts;
//  3. the caller can tell the difference — every one of these resolves with a
//     falsy value on failure, which is what keeps a call site from claiming a
//     write that did not land.
//
// `FailingBackend` gained overrides for all seven in this task. That matters:
// an operation it does not override inherits `LocalBackend`'s immediate
// resolve, so naming it here would produce a "failing" backend that succeeds
// and a test that asserts nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { LocalBackend } from "@/lib/backend/local";
import type { AppState, DM } from "@/lib/types";
import {
  FailingBackend,
  addRole,
  addUser,
  asUser,
  baseState,
  clone,
  mount,
  run,
} from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

const CHANNEL = "c_general";
const ME = "u_vlad";
// Deliberately somebody the seed has NO existing DM with (it ships
// d_vlad_maya and d_vlad_priya), so openDm/sendToUser really do take the
// create path instead of the local find-it fast path.
const MATE = "u_jonas";

function adminState(): AppState {
  return asUser(baseState(), ME);
}

/** Starts a write inside a synchronous `act`, so React flushes the render the
 *  optimistic patch schedules but no microtask runs: whatever the store shows
 *  at that point, it showed before the promise settled. */
function startWrite<T>(fn: () => Promise<T>) {
  let promise!: Promise<T>;
  act(() => {
    promise = fn();
  });
  const probe = { settled: false };
  void promise.then(() => {
    probe.settled = true;
  });
  return { promise, probe };
}

async function finish<T>(promise: Promise<T>): Promise<T> {
  let out!: T;
  await act(async () => {
    out = await promise;
  });
  return out;
}

function lastErrorToast() {
  return toastMock.error.mock.calls.at(-1);
}

/** Posts a message and hands back its id. */
async function postInto(
  store: { sendMessage: (c: string, t: string) => Promise<boolean>; state: AppState },
  read: () => AppState,
  content: string
): Promise<string> {
  await run(() => store.sendMessage(CHANNEL, content));
  return read().messages.find((m) => m.content === content)!.id;
}

describe("the optimistic patch is on screen before the write resolves", () => {
  it("editMessage — the new text is showing while the write is in flight", async () => {
    const { result } = await mount(adminState());
    const id = await postInto(result.current, () => result.current.state, "before");

    const { promise, probe } = startWrite(() =>
      result.current.editMessage(id, "after")
    );

    expect(probe.settled).toBe(false);
    expect(result.current.state.messages.find((m) => m.id === id)?.content).toBe("after");
    await finish(promise);
  });

  it("deleteMessage — the message is already gone while the write is in flight", async () => {
    const { result } = await mount(adminState());
    const id = await postInto(result.current, () => result.current.state, "doomed");

    const { promise, probe } = startWrite(() => result.current.deleteMessage(id));

    expect(probe.settled).toBe(false);
    expect(result.current.state.messages.some((m) => m.id === id)).toBe(false);
    await finish(promise);
  });

  it("toggleReaction — the emoji is on the message while the write is in flight", async () => {
    const { result } = await mount(adminState());
    const id = await postInto(result.current, () => result.current.state, "react to me");

    const { promise, probe } = startWrite(() => result.current.toggleReaction(id, "🎉"));

    expect(probe.settled).toBe(false);
    expect(result.current.state.messages.find((m) => m.id === id)?.reactions).toEqual([
      { emoji: "🎉", userIds: [ME] },
    ]);
    await finish(promise);
  });

  it("openDm — the thread exists while the write is in flight", async () => {
    const { result } = await mount(adminState());
    const before = result.current.state.dms.length;

    const { promise, probe } = startWrite(() => result.current.openDm(MATE));

    expect(probe.settled).toBe(false);
    expect(result.current.state.dms).toHaveLength(before + 1);
    expect(await finish(promise)).not.toBeNull();
  });

  it("sendToUser — the thread and the message both exist while the write is in flight", async () => {
    const { result } = await mount(adminState());

    const { promise, probe } = startWrite(() =>
      result.current.sendToUser(MATE, "hello there")
    );

    expect(probe.settled).toBe(false);
    const dm = result.current.state.dms.find((d) => d.memberIds.includes(MATE));
    expect(dm).toBeDefined();
    expect(
      result.current.state.messages.some(
        (m) => m.channelId === dm!.id && m.content === "hello there"
      )
    ).toBe(true);
    expect(await finish(promise)).not.toBeNull();
  });
});

describe("a rejected chat write restores the snapshot and toasts", () => {
  it("editMessage — the original text comes back", async () => {
    const backend = new FailingBackend("editMessage");
    const { result } = await mount(adminState(), backend);
    const id = await postInto(result.current, () => result.current.state, "original");
    const before = clone(result.current.state.messages);

    await run(() => result.current.editMessage(id, "never saved"));

    expect(result.current.state.messages).toEqual(before);
    expect(result.current.state.messages.find((m) => m.id === id)?.content).toBe("original");
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
    expect(backend.hydrateCalls).toBe(1);
  });

  it("deleteMessage — the message comes back", async () => {
    const backend = new FailingBackend("deleteMessage");
    const { result } = await mount(adminState(), backend);
    const id = await postInto(result.current, () => result.current.state, "survives");
    const before = clone(result.current.state.messages);

    await run(() => result.current.deleteMessage(id));

    expect(result.current.state.messages).toEqual(before);
    expect(result.current.state.messages.some((m) => m.id === id)).toBe(true);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  it("toggleReaction — the emoji is taken back off", async () => {
    const backend = new FailingBackend("toggleReaction");
    const { result } = await mount(adminState(), backend);
    const id = await postInto(result.current, () => result.current.state, "no reactions");

    await run(() => result.current.toggleReaction(id, "🎉"));

    // Not "some other set of reactions" — none, exactly as before. A reaction
    // left on screen here is one that does not exist server-side.
    expect(result.current.state.messages.find((m) => m.id === id)?.reactions).toEqual([]);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  it("toggleReaction — a failed *removal* puts the reaction back", async () => {
    // The other direction, which a rollback that only knew how to un-add
    // would get wrong.
    const { result } = await mount(adminState());
    const id = await postInto(result.current, () => result.current.state, "already reacted");
    await run(() => result.current.toggleReaction(id, "👍"));
    cleanup();

    const backend = new FailingBackend("toggleReaction");
    const { result: second } = await mount(
      { ...result.current.state },
      backend
    );
    await run(() => second.current.toggleReaction(id, "👍"));

    expect(second.current.state.messages.find((m) => m.id === id)?.reactions).toEqual([
      { emoji: "👍", userIds: [ME] },
    ]);
  });

  it("markChannelRead — the unread marker is not moved", async () => {
    const backend = new FailingBackend("markChannelRead");
    const state = adminState();
    // A message from somebody else, so there is genuinely something unread.
    state.messages = [
      ...state.messages,
      {
        id: "m_unread",
        channelId: CHANNEL,
        authorId: MATE,
        content: "unread",
        createdAt: Date.now(),
        reactions: [],
        attachments: [],
      },
    ];
    // The seed marks general as read up to now, and markChannelRead
    // deliberately burns no write when there is nothing new — so clear the
    // marker, or this test would pass by never calling the backend at all.
    const key = `${ME}:${CHANNEL}`;
    delete state.lastRead[key];
    const { result } = await mount(state, backend);
    const before = result.current.state.lastRead[key];

    await run(() => result.current.markChannelRead(CHANNEL));

    expect(result.current.state.lastRead[key]).toBe(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  it("openDm — resolves null and leaves no phantom thread behind", async () => {
    const backend = new FailingBackend("openDm");
    const { result } = await mount(adminState(), backend);
    const before = clone(result.current.state.dms);

    const dm = await run(() => result.current.openDm(MATE));

    // The falsy return is what the four navigation call sites check before
    // routing — a truthy DM here would send the user to a thread that does
    // not exist.
    expect(dm).toBeNull();
    expect(result.current.state.dms).toEqual(before);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });

  it("sendToUser — resolves null and takes both the thread and the message back", async () => {
    const backend = new FailingBackend("sendToUser");
    const { result } = await mount(adminState(), backend);
    const beforeDms = clone(result.current.state.dms);
    const beforeMessages = clone(result.current.state.messages);

    const dm = await run(() => result.current.sendToUser(MATE, "never sent"));

    expect(dm).toBeNull();
    expect(result.current.state.dms).toEqual(beforeDms);
    expect(result.current.state.messages).toEqual(beforeMessages);
    expect(lastErrorToast()?.[0]).toBe("Couldn't save");
  });
});

// ---------------------------------------------------------------------------
// The composer's draft. `components/chat/conversation.tsx` clears the textarea
// before the write resolves — that is what makes typing feel instant — and
// restores it from the resolved value when the store reports a failure. The
// test is on the contract that restore depends on: sendMessage resolves FALSE,
// not void and not a rejection, so `.then(ok => ...)` can see it.
// ---------------------------------------------------------------------------
describe("a rejected send is recoverable, so nothing typed is lost", () => {
  it("sendMessage resolves false — the composer's restore branch is reachable", async () => {
    const backend = new FailingBackend("sendMessage");
    const { result } = await mount(adminState(), backend);

    let restored: string | null = null;
    const typed = "a paragraph the user does not want to retype";
    await run(() =>
      result.current.sendMessage(CHANNEL, typed).then((ok) => {
        // Exactly the composer's branch (conversation.tsx `send`).
        if (!ok) restored = typed;
        return ok;
      })
    );

    expect(restored).toBe(typed);
    expect(result.current.state.messages.some((m) => m.content === typed)).toBe(false);
  });

  it("sendMessage resolves true on the happy path, so the draft is not restored over a sent message", async () => {
    const { result } = await mount(adminState());

    let restored: string | null = null;
    await run(() =>
      result.current.sendMessage(CHANNEL, "sent").then((ok) => {
        if (!ok) restored = "sent";
        return ok;
      })
    );

    expect(restored).toBeNull();
    expect(result.current.state.messages.some((m) => m.content === "sent")).toBe(true);
  });

  it("a refusal is reported the same way a failed write is", async () => {
    // The guard fast path resolves immediately with the same falsy value, so
    // the composer needs one check, not two — and a user whose role cannot
    // post still gets their draft back. Every seeded role holds message.send,
    // so the silent one is built here.
    const silent = addUser(
      addRole(baseState(), { id: "r_silent", name: "Silent", permissions: [] }),
      { id: "u_silent", roleId: "r_silent" }
    );
    const { result } = await mount(asUser(silent, "u_silent"));
    expect(await run(() => result.current.sendMessage(CHANNEL, "not allowed"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The DM id belongs to the server. `find_or_create_dm` decides it, so the
// optimistic thread the store created has to be renamed when the backend hands
// back a different one — otherwise the caller navigates to `dm.id` and finds a
// conversation the store does not have.
// ---------------------------------------------------------------------------
describe("a server-assigned DM id is adopted, not ignored", () => {
  /** Stands in for `find_or_create_dm`: answers with its own id, the way the
   *  RPC does for a thread it created (or found) under a different one. */
  class RenamingBackend extends LocalBackend {
    constructor(private readonly serverId: string) {
      super();
    }
    private rename(dm: DM): Promise<DM> {
      return Promise.resolve({ ...dm, id: this.serverId, createdAt: 1_700_000_000_000 });
    }
    override openDm(dm: DM): Promise<DM> {
      return this.rename(dm);
    }
    override sendToUser(dm: DM): Promise<DM> {
      return this.rename(dm);
    }
  }

  it("openDm — the store holds the server's thread, not the optimistic one", async () => {
    const backend = new RenamingBackend("d_from_the_server");
    const { result } = await mount(adminState(), backend);

    const dm = await run(() => result.current.openDm(MATE));

    expect(dm!.id).toBe("d_from_the_server");
    // One thread, under the server's id — not two, and not the client's.
    const mine = result.current.state.dms.filter((d) => d.memberIds.includes(MATE));
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe("d_from_the_server");
    expect(mine[0].createdAt).toBe(1_700_000_000_000);
  });

  it("sendToUser — the message follows the thread to its real id", async () => {
    const backend = new RenamingBackend("d_real");
    const { result } = await mount(adminState(), backend);

    const dm = await run(() => result.current.sendToUser(MATE, "follow me"));

    expect(dm!.id).toBe("d_real");
    const message = result.current.state.messages.find((m) => m.content === "follow me");
    // A message left pointing at the optimistic id is a message in a
    // conversation nobody can open.
    expect(message?.channelId).toBe("d_real");
    expect(result.current.state.dms.filter((d) => d.memberIds.includes(MATE))).toHaveLength(1);
    // The sender's own read marker moved with it, so their message does not
    // come back to them as unread.
    expect(result.current.state.lastRead[`${ME}:d_real`]).toBe(message!.createdAt);
    expect(result.current.state.lastRead[`${ME}:${dm!.id}`]).toBeDefined();
  });

  it("leaves everything alone when the backend keeps the id it was given", async () => {
    // LocalBackend's answer. The rename path must not fire for it.
    const { result } = await mount(adminState());

    const dm = await run(() => result.current.sendToUser(MATE, "local"));

    expect(dm).not.toBeNull();
    expect(result.current.state.dms.filter((d) => d.memberIds.includes(MATE))).toHaveLength(1);
    expect(
      result.current.state.messages.find((m) => m.content === "local")?.channelId
    ).toBe(dm!.id);
  });
});

// ---------------------------------------------------------------------------
// QA-122 — three write actions that told the caller nothing.
//
// `editMessage`, `deleteMessage` and `moveTask` were declared `Promise<void>`,
// alone among the store's write actions, so their callers had no way to check
// before announcing what had happened. The store still refused and `commit`
// still rolled back and toasted, so the user saw "Message deleted" — or
// "marked as done" — followed by "Couldn't save … Your change has been undone"
// and the thing reappearing.
//
// The value has to be reachable through the seam, not just present: that is
// what the callers use.
// ---------------------------------------------------------------------------
describe("the three widened write actions report refusal (QA-122)", () => {
  it("editMessage resolves false when the write fails, true when it lands", async () => {
    const backend = new FailingBackend("editMessage");
    const { result } = await mount(adminState(), backend);
    const id = await postInto(result.current, () => result.current.state, "original");

    expect(await run(() => result.current.editMessage(id, "never saved"))).toBe(false);

    // CONTROL: the same call on a backend that accepts it. Without this, an
    // action hard-wired to `false` would pass the assertion above.
    const ok = new LocalBackend();
    const second = await mount(adminState(), ok);
    const id2 = await postInto(second.result.current, () => second.result.current.state, "original");
    expect(await run(() => second.result.current.editMessage(id2, "saved"))).toBe(true);
  });

  it("deleteMessage resolves false when the write fails, true when it lands", async () => {
    const backend = new FailingBackend("deleteMessage");
    const { result } = await mount(adminState(), backend);
    const id = await postInto(result.current, () => result.current.state, "survives");

    expect(await run(() => result.current.deleteMessage(id))).toBe(false);

    const ok = new LocalBackend();
    const second = await mount(adminState(), ok);
    const id2 = await postInto(second.result.current, () => second.result.current.state, "goes");
    expect(await run(() => second.result.current.deleteMessage(id2))).toBe(true);
  });

  it("moveTask resolves false when the write fails, true when it lands", async () => {
    const backend = new FailingBackend("moveTask");
    const { result } = await mount(adminState(), backend);
    const task = result.current.state.tasks[0];

    expect(await run(() => result.current.moveTask(task.id, "done", 0))).toBe(false);

    const ok = new LocalBackend();
    const second = await mount(adminState(), ok);
    const task2 = second.result.current.state.tasks[0];
    expect(await run(() => second.result.current.moveTask(task2.id, "done", 0))).toBe(true);
  });
});
