// Task 3 — the Supabase channel: `subscribeToWorkspace` (lib/backend/supabase/realtime.ts),
// which turns `postgres_changes` payloads into the `RealtimeEvent`s Task 2's
// apply core (lib/store.tsx) already knows how to land. Task 4 added this same
// channel's presence half — `track()` on subscribe, `presenceState()` read
// back on `sync` — covered in its own `describe` block below.
//
// Driven entirely by a fake client — no network, no credentials. That fake is
// deliberately loose about what `.on()` returns (see `createFakeClient`
// below): the brief's own sketch has `.on()` return `this` from inside an
// arrow function, which is NOT the channel object, so an implementation that
// chains `.channel(...).on(...).subscribe()` would call `.subscribe()` on the
// wrong thing. Keeping that looseness in the fake, rather than "fixing" it to
// something convenient, is what proves the implementation calls `.on()` and
// `.subscribe()` on the SAME retained channel reference rather than chaining.
import { afterEach, describe, expect, it, vi } from "vitest";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { subscribeToWorkspace } from "@/lib/backend/supabase/realtime";
import type { Database } from "@/lib/database.types";
import type { RealtimeEvent } from "@/lib/backend/types";

type Handler = (payload: unknown) => void;
type StatusCallback = (status: REALTIME_SUBSCRIBE_STATES, err?: Error) => void;
type PresenceState = Record<string, Array<{ user_id: string }>>;

/** A `postgres_changes` + presence stand-in: records every `.on()`
 *  registration, every `.subscribe()` / `.unsubscribe()` / `.track()` call,
 *  and lets a test fire a payload straight at the handler
 *  `subscribeToWorkspace` registered, or drive `subscribe()`'s own status
 *  callback (`fireSubscribed()`), or set what `presenceState()` answers.
 *
 *  `userId` stands in for `client.auth.getUser()` — `null` (the default)
 *  is "not signed in", matching what a real client answers once a session
 *  has ended but the channel has not yet been torn down. */
function createFakeClient(userId: string | null = "u_test") {
  const handlers: Handler[] = [];
  const onCalls: Array<{ type: string; filter: unknown }> = [];
  const trackCalls: unknown[] = [];
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let statusCallback: StatusCallback | undefined;
  let presenceState: PresenceState = {};
  const channelNames: string[] = [];

  const channel = {
    on: (type: string, filter: unknown, cb: Handler) => {
      onCalls.push({ type, filter });
      handlers.push(cb);
      // Deliberately NOT the channel object — see the file banner. An
      // implementation that chains `.on(...).subscribe()` off this return
      // value breaks here.
      return undefined;
    },
    subscribe: (cb?: StatusCallback) => {
      subscribeCalls++;
      statusCallback = cb;
      return {};
    },
    unsubscribe: () => {
      unsubscribeCalls++;
    },
    track: (payload: unknown) => {
      trackCalls.push(payload);
      return Promise.resolve({ status: "ok" });
    },
    presenceState: () => presenceState,
  };

  const client = {
    channel: (name: string) => {
      channelNames.push(name);
      return channel;
    },
    auth: {
      getUser: () =>
        Promise.resolve(
          userId
            ? { data: { user: { id: userId } }, error: null }
            : { data: { user: null }, error: new Error("not signed in") }
        ),
    },
  } as unknown as SupabaseClient<Database>;

  return {
    client,
    handlers,
    onCalls,
    trackCalls,
    /** Fires `subscribe()`'s own status callback with `SUBSCRIBED`, as a real
     *  client would once the channel join completes — this is what triggers
     *  the `track()` call, so a test that wants to see `track()` fire has to
     *  call this first. */
    fireSubscribed() {
      statusCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
    },
    setPresenceState(state: PresenceState) {
      presenceState = state;
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get channelNames() {
      return channelNames;
    },
  };
}

const NEW_MESSAGE = {
  id: "m_1",
  conversation_id: "c_general",
  author_id: "u_maya",
  content: "hi",
  created_at: "2026-09-09T12:00:00.000Z",
  edited_at: null as string | null,
};

// `subscribeToWorkspace` defers `onEvent` by a macrotask — see the comment in
// realtime.ts recording why (the same deadlock reason lib/auth.tsx records
// for `onAuthStateChange`). Each test that fires a payload uses fake timers
// to flush that deterministically, rather than a real sleep.
afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeToWorkspace", () => {
  it("turns a messages INSERT into a message-insert event", async () => {
    vi.useFakeTimers();
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));

    fake.handlers[0]({ table: "messages", eventType: "INSERT", new: NEW_MESSAGE });

    // Still empty synchronously — the callback body is deferred.
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([
      {
        kind: "message-insert",
        message: expect.objectContaining({
          id: "m_1",
          channelId: "c_general",
          content: "hi",
        }),
      },
    ]);
    // A brand-new message is self-contained: no reactions, no attachments.
    const inserted = events[0];
    if (inserted.kind === "message-insert") {
      expect(inserted.message.reactions).toEqual([]);
      expect(inserted.message.attachments).toEqual([]);
      expect(inserted.message.authorId).toBe("u_maya");
      expect(inserted.message.createdAt).toBe(Date.parse(NEW_MESSAGE.created_at));
      expect(inserted.message.editedAt).toBeUndefined();
    }
  });

  it("maps a null author and a set edited_at (mismatch 9 and the edited-message case)", async () => {
    vi.useFakeTimers();
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));

    fake.handlers[0]({
      table: "messages",
      eventType: "INSERT",
      new: { ...NEW_MESSAGE, author_id: null, edited_at: "2026-09-09T12:05:00.000Z" },
    });
    await vi.advanceTimersByTimeAsync(0);

    const [event] = events;
    expect(event.kind).toBe("message-insert");
    if (event.kind === "message-insert") {
      expect(event.message.authorId).toBe("");
      expect(event.message.editedAt).toBe(Date.parse("2026-09-09T12:05:00.000Z"));
    }
  });

  it("turns anything else into a single stale event", async () => {
    vi.useFakeTimers();
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));

    fake.handlers[0]({
      table: "tasks",
      eventType: "UPDATE",
      new: { id: "t_1", title: "renamed" },
      old: { id: "t_1" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([{ kind: "stale" }]);
  });

  it("treats a messages UPDATE as stale, not message-insert", async () => {
    vi.useFakeTimers();
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));

    fake.handlers[0]({
      table: "messages",
      eventType: "UPDATE",
      new: { ...NEW_MESSAGE, content: "edited" },
      old: { id: "m_1" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([{ kind: "stale" }]);
  });

  it("treats a messages DELETE as stale — a delete payload is untrustworthy under RLS", async () => {
    vi.useFakeTimers();
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));

    // Exactly what Task 1 found DELETE payloads look like under RLS: a bare
    // primary key, nothing else — not even the columns a message needs.
    fake.handlers[0]({ table: "messages", eventType: "DELETE", new: {}, old: { id: "m_1" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([{ kind: "stale" }]);
  });

  it("opens exactly one channel: postgres_changes scoped to schema public, plus presence sync", () => {
    const fake = createFakeClient();
    subscribeToWorkspace(fake.client, () => {});

    // One `client.channel(...)` call — postgres_changes and presence are two
    // `.on()` registrations on that SAME channel, not two channels.
    expect(fake.channelNames).toHaveLength(1);
    expect(fake.onCalls).toEqual([
      { type: "postgres_changes", filter: { event: "*", schema: "public" } },
      { type: "presence", filter: { event: "sync" } },
    ]);
    expect(fake.subscribeCalls).toBe(1);
  });

  it("unsubscribing tears the channel down", () => {
    const fake = createFakeClient();
    const unsubscribe = subscribeToWorkspace(fake.client, () => {});

    expect(fake.unsubscribeCalls).toBe(0);
    unsubscribe();
    expect(fake.unsubscribeCalls).toBe(1);
  });
});

describe("subscribeToWorkspace — presence", () => {
  it("tracks this client's own user id once the channel is SUBSCRIBED", async () => {
    const fake = createFakeClient("u_maya");
    subscribeToWorkspace(fake.client, () => {});

    expect(fake.trackCalls).toEqual([]);
    fake.fireSubscribed();
    // `track()` is called from inside a `.then()` on `client.auth.getUser()`
    // — a real promise, not deferred by a timer — so a microtask flush is
    // enough; no fake timers needed for this one.
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.trackCalls).toEqual([{ user_id: "u_maya" }]);
  });

  it("does not track when nobody is signed in", async () => {
    const fake = createFakeClient(null);
    subscribeToWorkspace(fake.client, () => {});

    fake.fireSubscribed();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.trackCalls).toEqual([]);
  });

  it("turns a presence sync into a presence event carrying the whole online set", async () => {
    vi.useFakeTimers();
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));

    // Two presence keys (two distinct connections) both carrying the same
    // user — the handler must deduplicate down to one id, not report someone
    // with two tabs open as two different online people.
    fake.setPresenceState({
      key_a: [{ user_id: "u_maya" }],
      key_b: [{ user_id: "u_sam" }, { user_id: "u_maya" }],
    });
    // handlers[1] is the presence `sync` registration — handlers[0] is
    // postgres_changes, registered first (see the test above).
    fake.handlers[1]({});

    // Still empty synchronously — deferred exactly like the postgres_changes
    // handler, and for the same deadlock reason (see realtime.ts).
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([
      { kind: "presence", onlineUserIds: expect.arrayContaining(["u_maya", "u_sam"]) },
    ]);
    const [event] = events;
    if (event.kind === "presence") {
      expect(event.onlineUserIds).toHaveLength(2);
    }
  });

  it("reports nobody online once presenceState is empty — the leave case", async () => {
    vi.useFakeTimers();
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));

    fake.setPresenceState({});
    fake.handlers[1]({});
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([{ kind: "presence", onlineUserIds: [] }]);
  });
});
