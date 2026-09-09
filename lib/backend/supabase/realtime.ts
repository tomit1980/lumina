/**
 * The Supabase channel: wires one `postgres_changes` subscription on
 * `schema: "public"` to the `RealtimeEvent`s the store's apply core
 * understands (see the union and its rationale in `../types.ts`).
 *
 * Only one case is built directly: a `messages` INSERT. A brand-new message
 * has no reactions and no attachments — nothing else could reference an id
 * the client had not produced yet — so its row is self-contained, and it is
 * mapped inline HERE rather than through the grouped functions in
 * `./mapping.ts`. Those build a whole `AppState` from lookups assembled once
 * per `hydrate()` (message id -> its reactions, message id -> its attachment
 * links, ...); a lone row off a socket has none of that context, so calling
 * them would need a lookup rebuilt per event — defeating the reason they are
 * grouped — for a mapping this file can just write inline.
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
 */
import { REALTIME_LISTEN_TYPES } from "@supabase/supabase-js";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

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

/**
 * One channel, every `postgres_changes` row in `public`.
 * `SupabaseBackend.subscribe` delegates to this directly.
 */
export function subscribeToWorkspace(
  client: LuminaClient,
  onEvent: (event: RealtimeEvent) => void
): Unsubscribe {
  const channel = client.channel("workspace-changes");

  // NOT chained onto `.channel(...)`: `.on()`'s return value is not used, so
  // a fake test double that gets its own chaining wrong (returning something
  // other than the channel) still works — only the `channel` binding itself
  // is relied on, for both `.on()` and `.subscribe()` below.
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

  channel.subscribe();

  return () => {
    channel.unsubscribe();
  };
}
