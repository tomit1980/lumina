/**
 * The Supabase channel: wires one `postgres_changes` subscription on
 * `schema: "public"`, plus that same channel's presence tracking, to the
 * `RealtimeEvent`s the store's apply core understands (see the union and its
 * rationale in `../types.ts`).
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

import type { LuminaClient } from "./client";
import type { Database } from "../../database.types";
import type { Message } from "../../types";
import type { RealtimeEvent, Unsubscribe } from "../types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

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

/** The one payload shape this file builds directly; everything else is `stale`. */
function toRealtimeEvent(
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>
): RealtimeEvent {
  if (payload.table === "messages" && payload.eventType === "INSERT") {
    return {
      kind: "message-insert",
      message: messageFromRow(payload.new as unknown as MessageRow),
    };
  }
  return { kind: "stale" };
}

/** The shape this file tracks with — see `subscribeToWorkspace`'s `track()` call. */
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
 * One channel, every `postgres_changes` row in `public`, plus this client's
 * own presence on it. `SupabaseBackend.subscribe` delegates to this directly.
 */
export function subscribeToWorkspace(
  client: LuminaClient,
  onEvent: (event: RealtimeEvent) => void
): Unsubscribe {
  const channel = client.channel("workspace-changes");

  // NOT chained onto `.channel(...)`: `.on()`'s return value is not used, so
  // a fake test double that gets its own chaining wrong (returning something
  // other than the channel) still works — only the `channel` binding itself
  // is relied on, for `.on()` (both registrations below) and `.subscribe()`.
  channel.on<Record<string, unknown>>(
    REALTIME_LISTEN_TYPES.POSTGRES_CHANGES,
    { event: "*", schema: "public" },
    (payload) => {
      // Deferred, exactly as lib/auth.tsx defers `onAuthStateChange`, and for
      // the same recorded reason: the client holds an internal lock across
      // this callback, and `onEvent` can end up calling back into THIS SAME
      // client from inside it — a `stale` event reaches the store's apply
      // core, which calls `backend.hydrate()`, which issues fresh queries on
      // this client — so running that synchronously from here can deadlock.
      // lib/store.tsx's own subscribe wiring defers too, but that guards only
      // its own call site; this function has to be safe for any caller.
      setTimeout(() => onEvent(toRealtimeEvent(payload)), 0);
    }
  );

  // `sync` fires once this client joins (after its own `track()` below
  // resolves) and again on every subsequent join/leave anywhere on the
  // channel — Realtime fires it for a closed tab exactly like an explicit
  // `untrack()`, which is what makes a dot clear within seconds of someone
  // leaving rather than only when they say goodbye. Deferred for the same
  // deadlock reason as the `postgres_changes` handler above.
  channel.on(REALTIME_LISTEN_TYPES.PRESENCE, { event: REALTIME_PRESENCE_LISTEN_EVENTS.SYNC }, () => {
    setTimeout(
      () => onEvent({ kind: "presence", onlineUserIds: onlineUserIds(channel) }),
      0
    );
  });

  channel.subscribe((status) => {
    // `SUBSCRIBED` is the only status this socket is actually up; the other
    // three Realtime can hand back here — `CHANNEL_ERROR`, `TIMED_OUT`,
    // `CLOSED` — all mean it is not, whatever their differences otherwise.
    // Collapsing them to one boolean is deliberate: the store's own comment
    // (lib/store.tsx) explains why the ONLY thing that matters on the way
    // back up is reloading, and there is nothing a finer-grained reason
    // would let it do differently. Deferred for the same deadlock reason as
    // the other two `on()` handlers above — `onEvent` can call back into
    // this client.
    setTimeout(
      () => onEvent({ kind: "connection", online: status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED }),
      0
    );
    if (status !== REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) return;
    void client.auth.getUser().then(({ data, error }) => {
      // Not signed in, or the channel outlived the session: nothing of this
      // client's own to announce. The `postgres_changes` half of this
      // channel still works — RLS, not presence, is what gates row access —
      // this only means nobody sees a dot for a client with no user to track.
      if (error || !data.user) return;
      void channel.track({ user_id: data.user.id } satisfies PresencePayload);
    });
  });

  return () => {
    channel.unsubscribe();
  };
}
