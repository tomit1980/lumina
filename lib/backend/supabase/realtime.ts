/**
 * The Supabase channel: wires one `postgres_changes` subscription on
 * `schema: "public"`, plus that same channel's presence tracking, to the
 * `RealtimeEvent`s the store's apply core understands (see the union and its
 * rationale in `../types.ts`).
 *
 * ---------------------------------------------------------------------------
 * THE SOCKET CARRIES THE SESSION, OR IT RECEIVES NOTHING AND SAYS IT IS FINE
 * ---------------------------------------------------------------------------
 *
 * A realtime channel is authorized ONCE, at join time, with whatever token
 * the socket was holding at that instant. Every `postgres_changes` payload it
 * will ever be handed is filtered by row-level security against THAT token.
 * The publishable ("anon") key is a token too — one that satisfies no policy
 * in this schema, because every policy is `to authenticated`. So a channel
 * that joins before the session is attached is not merely unauthorized: it is
 * live, healthy, `SUBSCRIBED`, and permanently blind. It receives nothing,
 * for as long as it exists, and reports itself connected the whole time.
 *
 * That was the real bug behind "live updates do not work", and it was
 * invisible to 629 unit tests, 234 access tests and 11 probes — because they
 * all subscribe AFTER signing in, which is the order that works. The app's
 * order is the other one: `StoreProvider` subscribes on mount and the session
 * attaches separately, so the channel joined as nobody. Proven with three
 * sockets against the dev database (tests/probes/realtime_auth_probe.mjs):
 * never-signed-in receives nothing, signed-in-then-subscribed receives,
 * subscribed-then-signed-in receives nothing — all three `SUBSCRIBED`.
 *
 * Two things follow, and this file does both:
 *
 * 1. **Attach the token before joining, and re-join when the identity
 *    changes.** `client.realtime.setAuth()` is the explicit way supabase-js
 *    hands the realtime socket a token — it is a separate token from the REST
 *    one, which is why a working `hydrate()` proves nothing about the socket.
 *    `join()` below awaits it before opening the channel. supabase-js also
 *    calls `setAuth` itself on `SIGNED_IN` (`_handleTokenChanged`), but that
 *    only pushes a new token to an ALREADY-JOINED channel, and the probe
 *    shows the server does not re-authorize an existing `postgres_changes`
 *    subscription when it arrives — the channel stays blind. Repairing it
 *    takes a real re-join: leave the channel, then join again with the new
 *    token. So the fix is NOT "delay the first subscribe until auth is
 *    ready"; that would fix first load and leave the identical hole open on
 *    every later sign-in, sign-out and account switch, where it would be
 *    invisible all over again.
 *
 * 2. **Make the blindness detectable.** A blind socket's own status is
 *    `SUBSCRIBED`, so status alone cannot be trusted to mean "connected".
 *    This file therefore reports `{ kind: "connection", online: true }` only
 *    once the channel is subscribed AND the identity it joined with has been
 *    re-verified against the session (`joinedAs`, re-read on every
 *    `SUBSCRIBED` and on every auth change) AND that identity is somebody —
 *    a channel carrying only the publishable key satisfies no policy here, so
 *    it receives nothing by construction and says so. Nothing is claimed
 *    before that check answers, rather than claimed and retracted. A mismatch
 *    is exactly the lie this task exists to kill, so it is `online: false` — the
 *    "Reconnecting…" strip is honest about a socket that is delivering
 *    nothing — and repaired by re-joining. `connected: true` now means the
 *    socket is receiving what this user may see, not merely that a websocket
 *    is open.
 *
 * Session changes are observed through `client.auth.onAuthStateChange`, which
 * is the mechanism lib/auth.tsx already uses (and the one supabase-js itself
 * uses internally); nothing new is invented here and no second listener is
 * threaded down from React. The backend owns its socket, so the socket's
 * repair belongs next to it.
 *
 * ---------------------------------------------------------------------------
 *
 * Only one `postgres_changes` case is built directly: a `messages` INSERT. A
 * brand-new message has no reactions and no attachments — nothing else could
 * reference an id the client had not produced yet — so its row is
 * self-contained, and it is mapped inline HERE rather than through the
 * grouped functions in `./mapping.ts`. Those build a whole `AppState` from
 * lookups assembled once per `hydrate()` (message id -> its reactions,
 * message id -> its attachment links, ...); a lone row off a socket has none
 * of that context, so calling them would need a lookup rebuilt per event —
 * defeating the reason they are grouped — for a mapping this file can just
 * write inline.
 *
 * Everything else — every other table, and every other event on `messages`
 * too (UPDATE, DELETE) — becomes `{ kind: "stale" }`. The store coalesces a
 * burst of those into one reload, which re-fetches only what RLS lets this
 * user see. That last clause is what makes `stale` the right answer for a
 * DELETE specifically: Task 1 established empirically that row-level
 * security filters `postgres_changes` INSERT and UPDATE payloads but NOT
 * DELETE — a delete can arrive for a row this user was never entitled to
 * read, carrying nothing but the table name and (per the schema's replica
 * identity) the deleted row's primary key. Routing it to `stale` rather than
 * trying to interpret its payload is what keeps that leak inert: the reload
 * asks Postgres again, under RLS, for what this user may actually see,
 * instead of trusting anything a delete event says about a row it was never
 * allowed to hold.
 *
 * Presence — Task 4 — is not a table, so it is not a `postgres_changes` case
 * at all. It is a feature of THIS SAME channel: once the channel is joined,
 * this client `track()`s its own user id, and every `sync` (fired on join,
 * and again whenever anyone else tracks or untracks — which Realtime also
 * fires automatically the instant a socket disconnects, closed tab included)
 * reads `presenceState()` back and emits `{ kind: "presence", onlineUserIds }`
 * with the WHOLE current set. That "whole set, not a delta" shape is what
 * lets the apply core (lib/store.tsx) mark everyone not named offline in the
 * same pass — the store's own comment there says why that half matters: it
 * is what clears a dot when someone's tab closes, rather than only ever
 * lighting one up.
 */
import {
  REALTIME_LISTEN_TYPES,
  REALTIME_PRESENCE_LISTEN_EVENTS,
  REALTIME_SUBSCRIBE_STATES,
} from "@supabase/supabase-js";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";

import { sessionIsAssured } from "./assurance.ts";
import type { LuminaClient } from "./client";
import type { Database } from "../../database.types";
import type { Message } from "../../types";
import type { RealtimeEvent, Unsubscribe } from "../types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

/**
 * The channel topic. One constant, shared by every client, on purpose:
 * presence is scoped to a topic, so a per-tab or per-join unique name would
 * hide everyone from everyone. That it is shared is also why re-joining goes
 * through `client.removeChannel()` rather than `channel.unsubscribe()` — see
 * `join()`.
 */
const TOPIC = "workspace-changes";

/**
 * Builds a `Message` from one freshly-inserted row alone. Mirrors two of the
 * mismatches `./mapping.ts` documents for the grouped path, because they are
 * still true of a single row: mismatch 5 (`conversation_id` -> `channelId`)
 * and mismatch 9 (a null owner column becomes `""`, not a dropped message).
 * Reactions and attachments are `[]` — see the module comment.
 */
function messageFromRow(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.conversation_id,
    authorId: row.author_id ?? "",
    content: row.content,
    createdAt: Date.parse(row.created_at),
    ...(row.edited_at !== null ? { editedAt: Date.parse(row.edited_at) } : {}),
    reactions: [],
    attachments: [],
  };
}

/**
 * The one payload shape this file builds directly; everything else is
 * `stale`. Returns `null` for a change that must not cost a reload at all.
 *
 * `read_state` is that case (QA-110). Its policy is `user_id = auth.uid()`,
 * so nobody else ever sees your marker move — but YOU do, and the catch-all
 * below turned every echo of your own read marker into a coalesced
 * whole-workspace hydrate 250 ms later. `postMessage` upserts `read_state` on
 * every message sent, so posting in a busy channel meant one full re-fetch
 * per message typed, per participant, on top of the `message-insert` echo
 * that the dedup rule correctly makes free. It is pure waste besides: the
 * client already applied its own optimistic `lastRead` patch, so the reload
 * can only tell it what it already knows.
 *
 * Dropped here rather than removed from the publication, because the
 * subscription is what makes the row's own RLS filter apply — and because a
 * later feature (read receipts across devices) would want the event, just not
 * a reload.
 */
function toRealtimeEvent(
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>
): RealtimeEvent | null {
  if (payload.table === "messages" && payload.eventType === "INSERT") {
    return {
      kind: "message-insert",
      message: messageFromRow(payload.new as unknown as MessageRow),
    };
  }
  if (payload.table === "read_state") return null;
  return { kind: "stale" };
}

/** The shape this file tracks with — see `openChannel`'s `track()` call. */
type PresencePayload = { user_id: string };

/**
 * Everyone currently tracked on `channel`, deduplicated.
 *
 * `presenceState()` is keyed by Realtime's own per-connection presence ref,
 * not by user — the same person open in two tabs tracks twice, under two
 * different keys, both carrying that person's `user_id`. Collapsing to a
 * `Set` is what keeps two tabs from reading as two different online people.
 */
function onlineUserIds(channel: RealtimeChannel): string[] {
  const state = channel.presenceState<PresencePayload>();
  const ids = new Set<string>();
  for (const presences of Object.values(state)) {
    for (const p of presences) ids.add(p.user_id);
  }
  return [...ids];
}

/**
 * Whose session this client currently holds AND may act on, or null.
 *
 * "May act on" is the QA-104 half: a password-only (`aal1`) session on an
 * account with a verified second factor is a real session with a real token,
 * and it is NOBODY as far as this socket is concerned — see
 * ./assurance.ts. Both callers below go through this one function so they
 * cannot disagree: if `attachSession` treated a gated session as nobody while
 * the blindness check still read the raw session id, every `SUBSCRIBED` would
 * see `now !== uid` and re-join forever.
 */
async function sessionUserId(client: LuminaClient): Promise<string | null> {
  try {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) return null;
    return (await sessionIsAssured(client)) ? data.session.user.id : null;
  } catch {
    return null;
  }
}

/**
 * Hands the realtime socket the session's access token and reports whose it
 * is. This is the whole fix in one call: the realtime client keeps a token of
 * its own, separate from the one REST requests carry, and a channel joined
 * before it is set is authorized as the anon key — which no policy in this
 * schema grants anything to.
 *
 * `setAuth(null)` is deliberate for the signed-out case rather than skipping
 * the call: it makes the socket drop the previous user's token instead of
 * keeping it, which is the difference between "signed out" and "still
 * receiving the last person's rows".
 */
async function attachSession(client: LuminaClient): Promise<string | null> {
  const { data } = await client.auth.getSession().catch(() => ({ data: { session: null } }));
  const held = data?.session ?? null;
  // A session behind an unanswered second factor is not one this socket may
  // carry: joining with its token would authorize a channel — and, through
  // the `online: true` transition, a whole-workspace hydrate — for someone
  // who has not finished signing in. `setAuth(null)` rather than skipping the
  // call, for the same reason the signed-out case does it: the socket must
  // drop the token, not keep the last one it had.
  const session = held && (await sessionIsAssured(client)) ? held : null;
  try {
    await client.realtime.setAuth(session?.access_token ?? null);
  } catch (error) {
    console.error("Lumina: could not hand the realtime socket its token", error);
  }
  return session?.user.id ?? null;
}

/**
 * One channel, every `postgres_changes` row in `public`, plus this client's
 * own presence on it. `SupabaseBackend.subscribe` delegates to this directly.
 */
export function subscribeToWorkspace(
  client: LuminaClient,
  onEvent: (event: RealtimeEvent) => void
): Unsubscribe {
  let disposed = false;
  /** The live channel, or null between joins. */
  let channel: RealtimeChannel | null = null;
  /** The identity the LIVE channel joined with — what RLS is filtering its
   *  payloads by. `undefined` until the first join. Compared against the
   *  session to detect a blind socket. */
  let joinedAs: string | null | undefined;
  /** Bumped on every re-join so a superseded channel's late status callbacks
   *  and handlers are ignored rather than reported as the current socket's. */
  let generation = 0;
  /** A repair is already pending for the current channel, so the several
   *  statuses one drop can produce (CHANNEL_ERROR then CLOSED, say) cost one
   *  re-join rather than one each. */
  let repairing = false;
  /** Consecutive failed joins, for the backoff. Reset by a SUBSCRIBED. */
  let repairAttempts = 0;
  /** Joins are serialized: a sign-out immediately followed by a sign-in must
   *  not have two `join()`s interleaving their leave/join on one topic. */
  let queue: Promise<void> = Promise.resolve();

  // Deferred, exactly as lib/auth.tsx defers `onAuthStateChange`, and for the
  // same recorded reason: the client holds an internal lock across these
  // callbacks, and `onEvent` can end up calling back into THIS SAME client
  // from inside one — a `stale` event reaches the store's apply core, which
  // calls `backend.hydrate()`, which issues fresh queries on this client — so
  // running that synchronously can deadlock. lib/store.tsx's own subscribe
  // wiring defers too, but that guards only its own call site; this function
  // has to be safe for any caller.
  const emit = (event: RealtimeEvent) => {
    setTimeout(() => {
      if (!disposed) onEvent(event);
    }, 0);
  };

  const schedule = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((error: unknown) => {
      console.error("Lumina: realtime channel could not be (re)joined", error);
    });
  };

  /**
   * Opens the channel for `uid`, the identity `attachSession` just put on the
   * socket. `mine` is the generation this channel belongs to: every callback
   * checks it, so a channel being replaced can neither report a status for
   * the socket that replaced it nor land an event filtered by a stale token.
   */
  const openChannel = (uid: string | null, mine: number): RealtimeChannel => {
    const opened = client.channel(TOPIC);

    // NOT chained onto `.channel(...)`: `.on()`'s return value is not used, so
    // a fake test double that gets its own chaining wrong (returning something
    // other than the channel) still works — only the `opened` binding itself
    // is relied on, for `.on()` (both registrations below) and `.subscribe()`.
    opened.on<Record<string, unknown>>(
      REALTIME_LISTEN_TYPES.POSTGRES_CHANGES,
      { event: "*", schema: "public" },
      (payload) => {
        if (mine !== generation) return;
        const event = toRealtimeEvent(payload);
        if (event) emit(event);
      }
    );

    // `sync` fires once this client joins (after its own `track()` below
    // resolves) and again on every subsequent join/leave anywhere on the
    // channel — Realtime fires it for a closed tab exactly like an explicit
    // `untrack()`, which is what makes a dot clear within seconds of someone
    // leaving rather than only when they say goodbye.
    opened.on(REALTIME_LISTEN_TYPES.PRESENCE, { event: REALTIME_PRESENCE_LISTEN_EVENTS.SYNC }, () => {
      if (mine !== generation) return;
      emit({ kind: "presence", onlineUserIds: onlineUserIds(opened) });
    });

    opened.subscribe((status) => {
      if (mine !== generation) return;
      // `SUBSCRIBED` is the only status this socket is actually up; the other
      // three Realtime can hand back here — `CHANNEL_ERROR`, `TIMED_OUT`,
      // `CLOSED` — all mean it is not, whatever their differences otherwise.
      // Collapsing them to one boolean is deliberate: the store's own comment
      // (lib/store.tsx) explains why the ONLY thing that matters on the way
      // back up is reloading, and there is nothing a finer-grained reason
      // would let it do differently.
      const up = status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED;
      if (!up) {
        emit({ kind: "connection", online: false });
        // QA-111 — AND THEN TRY TO FIX IT, which nothing here used to do.
        //
        // This branch reported the drop and returned. `channel` was still
        // non-null and `joinedAs` still held the current uid, so `join()`'s
        // idempotence guard and the auth listener's both refused to re-join
        // for the same identity; the module's only self-repair paths are an
        // identity CHANGE and the blindness check, and neither fires here.
        // Recovery was left entirely to supabase-js's internal rejoin timer
        // producing a fresh SUBSCRIBED through this same callback. When it
        // does, fine — but a wedged socket, or a channel the server closed
        // and will not re-authorize, left the app on "Reconnecting…"
        // indefinitely with no way back but a page reload.
        //
        // This file goes to great length to stop claiming a socket is healthy
        // when it is not; the mirror-image case — saying it is unhealthy and
        // then never trying again — is the same abdication.
        //
        // `joinedAs = undefined` is what makes the retry actually happen: it
        // is the half of `join()`'s guard that a same-identity re-join trips
        // on. Clearing `channel` instead would be WRONG and was the first
        // attempt here — `client.channel(TOPIC)` hands back the EXISTING
        // channel while the topic is still registered on the client, so
        // dropping only our reference re-subscribes the dead object rather
        // than opening a new one. Leaving `channel` set is what lets `join()`
        // take its `previous` branch and do the real `removeChannel`
        // teardown.
        //
        // The generation is NOT bumped here: this channel is not being
        // replaced yet — `join()` does that itself — and bumping now would
        // silence the very SUBSCRIBED that a library-driven recovery
        // delivers through this same callback.
        if (mine === generation && !repairing) {
          repairing = true;
          const wait = Math.min(30_000, 1_000 * 2 ** repairAttempts++);
          setTimeout(() => {
            repairing = false;
            if (disposed || mine !== generation) return;
            joinedAs = undefined;
            schedule(join);
          }, wait);
        }
        return;
      }
      // Back up: forget the backoff, so a socket that flaps once in an hour
      // does not start its next repair thirty seconds late.
      repairAttempts = 0;

      // The blindness check, and NOTHING is claimed until it answers.
      // `SUBSCRIBED` is precisely the status a channel that joined as nobody
      // reports, so it is not on its own evidence that anything will arrive.
      // Re-reading the session here catches a sign-in that landed while this
      // join was in flight — the exact race that made the app blind — and
      // turns it into a re-join instead of a silent lie. Announcing
      // `online: true` up front and correcting it a moment later would be a
      // smaller version of the same lie: a channel about to be torn down and
      // re-joined would be reported healthy on the way past.
      void (async () => {
        const now = await sessionUserId(client);
        if (disposed || mine !== generation) return;
        if (now !== uid) {
          console.warn(
            `Lumina: realtime socket joined as ${uid ?? "nobody"} but the session is ${
              now ?? "nobody"
            } — it would receive nothing. Re-joining.`
          );
          emit({ kind: "connection", online: false });
          schedule(join);
          return;
        }
        // Signed out, and the session agrees — so this is not a race, it is
        // simply nobody. The channel is nonetheless receiving nothing and
        // will keep receiving nothing for as long as it exists: every policy
        // in this schema is `to authenticated`, and the socket is carrying
        // the publishable key, which satisfies none of them. `connected` on
        // this branch means "receiving what this user may see", so the
        // honest answer is `false` — an anon channel reporting itself
        // healthy is the same class of claim this file exists to delete.
        // Nothing is announced for presence either: there is no user to
        // track. (`ConnectionStatus` lives inside the auth gate, so a
        // signed-out browser is looking at the sign-in screen and sees no
        // strip; this only stops the store from believing a lie.)
        if (!uid) {
          emit({ kind: "connection", online: false });
          return;
        }
        emit({ kind: "connection", online: true });
        void opened.track({ user_id: uid } satisfies PresencePayload);
      })();
    });

    return opened;
  };

  /**
   * Re-establishes the channel against the session the client holds NOW.
   *
   * Idempotent by identity: if a channel is already live and joined with the
   * current session's user, this refreshes the socket's token and returns —
   * a token refresh for the same person does not need (and must not cause) a
   * re-join, since supabase-js pushes the new token to the joined channel
   * itself and the subscription's authorization does not change.
   */
  async function join(): Promise<void> {
    if (disposed) return;
    const uid = await attachSession(client);
    if (disposed) return;
    if (channel && uid === joinedAs) return;

    // Past this point the current channel is being replaced: bump the
    // generation FIRST so its remaining callbacks (including the `CLOSED`
    // that leaving produces) are ignored rather than reported as a drop of
    // the socket that is about to take its place.
    const mine = ++generation;
    const previous = channel;
    channel = null;
    if (previous) {
      // Say so. Between here and the new channel's `SUBSCRIBED` there is no
      // socket carrying this session, and the whole point of this task is
      // that a `connected: true` which is false in practice is a lie. Emitted
      // ONLY when a channel is really being replaced, so this can never leave
      // the indicator stuck: every `false` from here is answered by the new
      // channel's own status.
      emit({ kind: "connection", online: false });
      // `removeChannel`, NOT `previous.unsubscribe()`. `client.channel(TOPIC)`
      // hands back the EXISTING channel for a topic still registered on the
      // client, so an unsubscribe alone would have the next line re-adopt the
      // dead one and never actually re-join. `removeChannel` awaits the leave
      // acknowledgement and tears the channel down, which is what frees the
      // topic — and the topic is shared by every client, so it cannot simply
      // be made unique per join (presence is scoped to it).
      try {
        await client.removeChannel(previous);
      } catch (error) {
        console.error("Lumina: could not leave the realtime channel", error);
      }
      if (disposed || mine !== generation) return;
    }
    joinedAs = uid;
    channel = openChannel(uid, mine);
  }

  schedule(join);

  /**
   * The session changing is the other half of the fix. Signing in, signing
   * out and signing in as someone else all land here, and all of them mean
   * the live channel is now filtered by the wrong identity — receiving the
   * previous user's rows, or (far more often) nothing at all. Each one is
   * reported as a disconnection, because that is what it is, and repaired by
   * a re-join.
   *
   * `client.auth.onAuthStateChange` is the same mechanism lib/auth.tsx
   * observes sessions with; this listens to it directly rather than having
   * React thread a session down into the backend, so the socket is repaired
   * even in a build where no component ever renders.
   */
  const { data: sub } = client.auth.onAuthStateChange((_event, next) => {
    // Deferred for the same lock/deadlock reason recorded on `emit` above:
    // `join()` calls back into this client from inside this callback.
    const uid = next?.user.id ?? null;
    setTimeout(() => {
      if (disposed) return;
      // Same person (a token refresh): supabase-js has already pushed the new
      // token to the joined channel and the subscription's authorization has
      // not changed, so there is nothing to re-join. Anything else — and
      // anything ambiguous, including an event arriving while the first join
      // is still in flight — goes to `join()`, which is idempotent by
      // identity and reports the disconnection itself if it really does
      // replace the channel.
      if (uid === joinedAs && channel) return;
      schedule(join);
    }, 0);
  });

  return () => {
    disposed = true;
    generation++;
    try {
      sub.subscription.unsubscribe();
    } catch {
      // A test double may not register one; nothing to undo.
    }
    const live = channel;
    channel = null;
    if (live) void client.removeChannel(live);
  };
}
