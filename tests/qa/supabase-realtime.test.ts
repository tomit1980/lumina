// Task 3 — the Supabase channel: `subscribeToWorkspace` (lib/backend/supabase/realtime.ts),
// which turns `postgres_changes` payloads into the `RealtimeEvent`s Task 2's
// apply core (lib/store.tsx) already knows how to land. Task 4 added this same
// channel's presence half — `track()` on subscribe, `presenceState()` read
// back on `sync` — covered in its own `describe` block below.
//
// Task 7 added the half that made all of the above actually work in a browser:
// the socket has to CARRY THE SESSION. A channel is authorized once, at join
// time, by whatever token the realtime socket held at that instant, and the
// publishable key satisfies no policy in this schema — so a channel opened
// before the session is attached is live, `SUBSCRIBED`, and permanently blind.
// That is what the app did, and it is why every suite here passed while
// nothing arrived in the real app: this fake had no auth at all, so there was
// no order to get wrong. It has one now (`signIn`, `signOut`, `refreshToken`,
// `realtime.setAuth`, and a `channel()` that returns the EXISTING channel for
// a still-registered topic), and the last describe block below is the
// regression.
//
// Driven entirely by a fake client — no network, no credentials. That fake is
// deliberately loose about what `.on()` returns (see `createFakeClient`
// below): the brief's own sketch has `.on()` return `this` from inside an
// arrow function, which is NOT the channel object, so an implementation that
// chains `.channel(...).on(...).subscribe()` would call `.subscribe()` on the
// wrong thing. Keeping that looseness in the fake, rather than "fixing" it to
// something convenient, is what proves the implementation calls `.on()` and
// `.subscribe()` on the SAME retained channel reference rather than chaining.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 *  `userId` is who this client is signed in as — `null` is "not signed in",
 *  matching what a real client answers once a session has ended but the
 *  channel has not yet been torn down. `signIn` / `signOut` move that session
 *  and notify the auth listener, and deliberately do NOT re-authorize an
 *  already-joined channel: that is the hazard Task 7 exists for, and a fake
 *  that quietly repaired it would make the regression below vacuous.
 *
 *  Two rules of the real client are modelled because the fix depends on them:
 *  `client.channel(topic)` hands back the EXISTING channel for a topic still
 *  registered on the client (so re-joining needs `removeChannel`, not just
 *  `unsubscribe`), and `realtime.setAuth` is where the socket's token — the
 *  one a join is authorized with — actually comes from. */
function createFakeClient(userId: string | null = "u_test") {
  type AuthListener = (event: string, session: { user: { id: string } } | null) => void;

  interface FakeChannel {
    name: string;
    handlers: Handler[];
    onCalls: Array<{ type: string; filter: unknown }>;
    trackCalls: unknown[];
    statusCallback?: StatusCallback;
    subscribeCalls: number;
    unsubscribeCalls: number;
    removed: boolean;
    /** The socket's token at the moment this channel joined — what its
     *  payloads would be filtered by for the rest of its life. */
    joinedWithToken: string | null;
    api: Record<string, unknown>;
  }

  const channels: FakeChannel[] = [];
  /** Topics currently registered on the client, exactly as realtime-js keeps
   *  them: `client.channel()` returns an existing one rather than a new one. */
  const live = new Map<string, FakeChannel>();
  const setAuthCalls: Array<string | null> = [];
  const authListeners: AuthListener[] = [];
  let socketToken: string | null = null;
  let session: { user: { id: string } } | null = userId ? { user: { id: userId } } : null;
  let presenceState: PresenceState = {};

  const makeChannel = (name: string): FakeChannel => {
    const ch: FakeChannel = {
      name,
      handlers: [],
      onCalls: [],
      trackCalls: [],
      subscribeCalls: 0,
      unsubscribeCalls: 0,
      removed: false,
      joinedWithToken: null,
      api: {},
    };
    ch.api = {
      on: (type: string, filter: unknown, cb: Handler) => {
        ch.onCalls.push({ type, filter });
        ch.handlers.push(cb);
        // Deliberately NOT the channel object — see the file banner. An
        // implementation that chains `.on(...).subscribe()` off this return
        // value breaks here.
        return undefined;
      },
      subscribe: (cb?: StatusCallback) => {
        ch.subscribeCalls++;
        ch.statusCallback = cb;
        // The join is authorized by whatever token the socket holds NOW.
        ch.joinedWithToken = socketToken;
        return {};
      },
      unsubscribe: () => {
        ch.unsubscribeCalls++;
        return Promise.resolve("ok");
      },
      track: (payload: unknown) => {
        ch.trackCalls.push(payload);
        return Promise.resolve({ status: "ok" });
      },
      presenceState: () => presenceState,
      /** Only so `removeChannel` can identify the handle it was given. */
      __channel: ch,
    };
    return ch;
  };

  const client = {
    channel: (name: string) => {
      const existing = live.get(name);
      if (existing) return existing.api;
      const ch = makeChannel(name);
      channels.push(ch);
      live.set(name, ch);
      return ch.api;
    },
    removeChannel: async (handle: { __channel?: FakeChannel }) => {
      // The real one unsubscribes and then tears down — which is what frees
      // the topic for a fresh join.
      const ch = handle?.__channel;
      if (!ch) return "error";
      ch.unsubscribeCalls++;
      ch.removed = true;
      if (live.get(ch.name) === ch) live.delete(ch.name);
      return "ok";
    },
    realtime: {
      setAuth: async (token: string | null = null) => {
        // A real client resolves a null token through its `accessToken`
        // callback, which answers the session's token or the anon key.
        socketToken = token ?? (session ? `token-${session.user.id}` : "anon-key");
        setAuthCalls.push(token);
      },
    },
    auth: {
      getSession: () =>
        Promise.resolve({
          data: {
            session: session
              ? { user: session.user, access_token: `token-${session.user.id}` }
              : null,
          },
          error: null,
        }),
      onAuthStateChange: (cb: AuthListener) => {
        authListeners.push(cb);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                const i = authListeners.indexOf(cb);
                if (i >= 0) authListeners.splice(i, 1);
              },
            },
          },
        };
      },
    },
  } as unknown as SupabaseClient<Database>;

  const current = (): FakeChannel | undefined => channels[channels.length - 1];

  return {
    client,
    /** The handlers of the CURRENT channel — the one a live socket would be
     *  delivering through. */
    get handlers() {
      return current()?.handlers ?? [];
    },
    get onCalls() {
      return current()?.onCalls ?? [];
    },
    get trackCalls() {
      return current()?.trackCalls ?? [];
    },
    /** Every channel ever opened, oldest first. A re-join adds one. */
    get channels() {
      return channels;
    },
    get setAuthCalls() {
      return setAuthCalls;
    },
    /** The token the socket is carrying right now. */
    get socketToken() {
      return socketToken;
    },
    /** The token the current channel was authorized with at join time. */
    get joinedWithToken() {
      return current()?.joinedWithToken ?? null;
    },
    /** Signs a user in, exactly as a real client does: the session moves and
     *  the auth listener is notified. It does NOT re-authorize a channel that
     *  has already joined — that is the whole hazard. */
    signIn(id: string) {
      session = { user: { id } };
      for (const l of [...authListeners]) l("SIGNED_IN", session);
    },
    signOut() {
      session = null;
      for (const l of [...authListeners]) l("SIGNED_OUT", null);
    },
    /** A token refresh for the SAME person — must not cost a re-join. */
    refreshToken() {
      for (const l of [...authListeners]) l("TOKEN_REFRESHED", session);
    },
    get authListenerCount() {
      return authListeners.length;
    },
    /** Fires `subscribe()`'s own status callback with `SUBSCRIBED`, as a real
     *  client would once the channel join completes — this is what triggers
     *  the `track()` call, so a test that wants to see `track()` fire has to
     *  call this first. */
    fireSubscribed() {
      current()?.statusCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
    },
    /** Fires `subscribe()`'s own status callback with any status — the
     *  Task 5 addition. Used for the other three the real client can hand
     *  back (`CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`), which `fireSubscribed`
     *  above cannot reach. */
    fireStatus(status: REALTIME_SUBSCRIBE_STATES) {
      current()?.statusCallback?.(status);
    },
    setPresenceState(state: PresenceState) {
      presenceState = state;
    },
    get subscribeCalls() {
      return channels.reduce((n, c) => n + c.subscribeCalls, 0);
    },
    get unsubscribeCalls() {
      return channels.reduce((n, c) => n + c.unsubscribeCalls, 0);
    },
    get channelNames() {
      return channels.map((c) => c.name);
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

// Two things need flushing, and neither is a sleep:
//
// - `subscribeToWorkspace` defers every `onEvent` by a macrotask — see the
//   comment in realtime.ts recording why (the same deadlock reason
//   lib/auth.tsx records for `onAuthStateChange`).
// - Since Task 7 it also hands the socket its token BEFORE opening the
//   channel, so the channel does not exist until a short promise chain has
//   settled.
//
// `advanceTimersByTimeAsync(0)` drains both — pending microtasks and 0ms
// timers — so every test uses fake timers and this helper.
const flush = async (times = 3) => {
  for (let i = 0; i < times; i++) await vi.runAllTimersAsync();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscribeToWorkspace", () => {
  it("turns a messages INSERT into a message-insert event", async () => {
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    fake.handlers[0]({ table: "messages", eventType: "INSERT", new: NEW_MESSAGE });

    // Still empty synchronously — the callback body is deferred.
    expect(events).toEqual([]);
    await flush();

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
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    fake.handlers[0]({
      table: "messages",
      eventType: "INSERT",
      new: { ...NEW_MESSAGE, author_id: null, edited_at: "2026-09-09T12:05:00.000Z" },
    });
    await flush();

    const [event] = events;
    expect(event.kind).toBe("message-insert");
    if (event.kind === "message-insert") {
      expect(event.message.authorId).toBe("");
      expect(event.message.editedAt).toBe(Date.parse("2026-09-09T12:05:00.000Z"));
    }
  });

  it("turns anything else into a single stale event", async () => {
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    fake.handlers[0]({
      table: "tasks",
      eventType: "UPDATE",
      new: { id: "t_1", title: "renamed" },
      old: { id: "t_1" },
    });
    await flush();

    expect(events).toEqual([{ kind: "stale" }]);
  });

  it("treats a messages UPDATE as stale, not message-insert", async () => {
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    fake.handlers[0]({
      table: "messages",
      eventType: "UPDATE",
      new: { ...NEW_MESSAGE, content: "edited" },
      old: { id: "m_1" },
    });
    await flush();

    expect(events).toEqual([{ kind: "stale" }]);
  });

  it("treats a messages DELETE as stale — a delete payload is untrustworthy under RLS", async () => {
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    // Exactly what Task 1 found DELETE payloads look like under RLS: a bare
    // primary key, nothing else — not even the columns a message needs.
    fake.handlers[0]({ table: "messages", eventType: "DELETE", new: {}, old: { id: "m_1" } });
    await flush();

    expect(events).toEqual([{ kind: "stale" }]);
  });

  it("opens exactly one channel: postgres_changes scoped to schema public, plus presence sync", async () => {
    const fake = createFakeClient();
    subscribeToWorkspace(fake.client, () => {});
    await flush();

    // One `client.channel(...)` call — postgres_changes and presence are two
    // `.on()` registrations on that SAME channel, not two channels.
    expect(fake.channelNames).toHaveLength(1);
    expect(fake.onCalls).toEqual([
      { type: "postgres_changes", filter: { event: "*", schema: "public" } },
      { type: "presence", filter: { event: "sync" } },
    ]);
    expect(fake.subscribeCalls).toBe(1);
  });

  it("unsubscribing tears the channel down", async () => {
    const fake = createFakeClient();
    const unsubscribe = subscribeToWorkspace(fake.client, () => {});
    await flush();

    expect(fake.unsubscribeCalls).toBe(0);
    unsubscribe();
    await flush();
    expect(fake.unsubscribeCalls).toBe(1);
    // And it stops listening for session changes, so a later sign-in on a
    // client this store no longer uses cannot resurrect a channel.
    expect(fake.authListenerCount).toBe(0);
  });
});

describe("subscribeToWorkspace — presence", () => {
  it("tracks this client's own user id once the channel is SUBSCRIBED", async () => {
    const fake = createFakeClient("u_maya");
    subscribeToWorkspace(fake.client, () => {});
    await flush();

    expect(fake.trackCalls).toEqual([]);
    fake.fireSubscribed();
    await flush();

    expect(fake.trackCalls).toEqual([{ user_id: "u_maya" }]);
  });

  it("does not track when nobody is signed in", async () => {
    const fake = createFakeClient(null);
    subscribeToWorkspace(fake.client, () => {});
    await flush();

    fake.fireSubscribed();
    await flush();

    expect(fake.trackCalls).toEqual([]);
  });

  it("turns a presence sync into a presence event carrying the whole online set", async () => {
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

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
    await flush();

    expect(events).toEqual([
      { kind: "presence", onlineUserIds: expect.arrayContaining(["u_maya", "u_sam"]) },
    ]);
    const [event] = events;
    if (event.kind === "presence") {
      expect(event.onlineUserIds).toHaveLength(2);
    }
  });

  it("reports nobody online once presenceState is empty — the leave case", async () => {
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    fake.setPresenceState({});
    fake.handlers[1]({});
    await flush();

    expect(events).toEqual([{ kind: "presence", onlineUserIds: [] }]);
  });
});

describe("subscribeToWorkspace — connection", () => {
  it("maps SUBSCRIBED to a connection event with online: true", async () => {
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    fake.fireSubscribed();
    await flush();

    expect(events).toEqual(
      expect.arrayContaining([{ kind: "connection", online: true }])
    );
  });

  it.each([
    REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR,
    REALTIME_SUBSCRIBE_STATES.TIMED_OUT,
    REALTIME_SUBSCRIBE_STATES.CLOSED,
  ])("maps %s to a connection event with online: false", async (status) => {
    const fake = createFakeClient();
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    fake.fireStatus(status);
    await flush();

    expect(events).toEqual([{ kind: "connection", online: false }]);
  });
});

// ---------------------------------------------------------------------------
// Task 7 — the socket carries the session, or it receives nothing and says it
// is fine.
//
// Everything above this block passed for days while live updates did not work
// at all in the browser. These are the assertions that would have caught it.
// ---------------------------------------------------------------------------
describe("subscribeToWorkspace — the socket carries the session", () => {
  it("hands the socket the session's token BEFORE the channel joins", async () => {
    const fake = createFakeClient("u_maya");
    subscribeToWorkspace(fake.client, () => {});
    await flush();

    // Not "setAuth was called at some point": the channel must have been
    // authorized WITH that token. A join that happened first is exactly the
    // blind channel this task is about, and it would still see a setAuth call
    // in the log a moment later.
    expect(fake.setAuthCalls).toContain("token-u_maya");
    expect(fake.joinedWithToken).toBe("token-u_maya");
  });

  it("re-joins when someone signs in after the channel is already open — the regression", async () => {
    // The app's real order, and the one every other suite here never took:
    // the channel opens on mount, signed out, and the session arrives later.
    const fake = createFakeClient(null);
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    expect(fake.channels).toHaveLength(1);
    expect(fake.joinedWithToken).toBe("anon-key");

    fake.signIn("u_maya");
    await flush();

    // A second channel, authorized with the signed-in user's token. Pushing a
    // token at the first one would not have done it: the server authorizes a
    // postgres_changes subscription once, at join.
    expect(fake.channels).toHaveLength(2);
    expect(fake.joinedWithToken).toBe("token-u_maya");
    // The blind one is gone, not merely unsubscribed — the topic is shared,
    // so a channel left registered would be handed back on the next join.
    expect(fake.channels[0].removed).toBe(true);
    // And the store was told the socket was down while that was happening,
    // rather than being left believing an anon-authorized channel was live.
    expect(events).toContainEqual({ kind: "connection", online: false });
  });

  it("re-joins as the new person when the account changes", async () => {
    const fake = createFakeClient("u_maya");
    subscribeToWorkspace(fake.client, () => {});
    await flush();
    expect(fake.joinedWithToken).toBe("token-u_maya");

    fake.signIn("u_sam");
    await flush();

    expect(fake.channels).toHaveLength(2);
    expect(fake.joinedWithToken).toBe("token-u_sam");
    // Nothing of Maya's is still being delivered anywhere.
    expect(fake.channels[0].removed).toBe(true);
  });

  it("re-joins as nobody on sign-out, so the socket stops carrying the last user's token", async () => {
    const fake = createFakeClient("u_maya");
    subscribeToWorkspace(fake.client, () => {});
    await flush();

    fake.signOut();
    await flush();

    expect(fake.channels).toHaveLength(2);
    expect(fake.channels[0].removed).toBe(true);
    expect(fake.socketToken).toBe("anon-key");
    expect(fake.joinedWithToken).toBe("anon-key");
  });

  it("does not re-join for a token refresh of the same person", async () => {
    const fake = createFakeClient("u_maya");
    subscribeToWorkspace(fake.client, () => {});
    await flush();

    fake.refreshToken();
    await flush();

    // One channel, still. supabase-js pushes a refreshed token to a joined
    // channel itself and the subscription's authorization does not change, so
    // tearing it down here would drop presence and events for no reason.
    expect(fake.channels).toHaveLength(1);
  });

  it("reports online: false — and re-joins — when a SUBSCRIBED channel joined as the wrong identity", async () => {
    // The blind socket, caught. The channel joins signed-out; the session
    // lands before the join is acknowledged, so the auth listener's re-join
    // and the SUBSCRIBED both refer to a channel that will receive nothing.
    // A status-based check would call this healthy. This one does not.
    const fake = createFakeClient(null);
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();

    // Session moves with no notification at all — the worst case, and the one
    // a listener alone would miss.
    fake.client.auth.getSession = () =>
      Promise.resolve({
        data: { session: { user: { id: "u_maya" }, access_token: "token-u_maya" } },
        error: null,
      }) as ReturnType<SupabaseClient<Database>["auth"]["getSession"]>;

    events.length = 0;
    fake.fireSubscribed();
    await flush();

    // Not `online: true` — the channel is subscribed and blind.
    expect(events).toContainEqual({ kind: "connection", online: false });
    // And it did not just complain: it repaired itself.
    expect(fake.channels).toHaveLength(2);
    expect(fake.joinedWithToken).toBe("token-u_maya");
    // A blind channel must not announce presence either: a dot for someone
    // whose socket receives nothing is the same class of lie.
    expect(fake.channels[0].trackCalls).toEqual([]);
  });

  it("ignores a superseded channel's payloads and statuses", async () => {
    const fake = createFakeClient(null);
    const events: RealtimeEvent[] = [];
    subscribeToWorkspace(fake.client, (e) => events.push(e));
    await flush();
    const blind = fake.channels[0];

    fake.signIn("u_maya");
    await flush();
    events.length = 0;

    // The old channel's `CLOSED` arrives after the new one is up (leaving
    // produces one). Reporting it would tell the store the live socket had
    // dropped, and a stale-token payload would land rows filtered by the
    // wrong identity.
    blind.statusCallback?.(REALTIME_SUBSCRIBE_STATES.CLOSED);
    blind.handlers[0]({ table: "messages", eventType: "INSERT", new: NEW_MESSAGE });
    await flush();

    expect(events).toEqual([]);
  });
});
