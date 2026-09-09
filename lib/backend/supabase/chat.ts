/**
 * The chat write path — messages, DMs, reactions and read state (store-swap
 * Task 5). `SupabaseBackend` delegates its seven chat operations here so
 * `index.ts` stays a table of contents rather than an implementation dump.
 *
 * Four rules govern this file.
 *
 * **The store has already patched the screen.** Every function here is called
 * *after* `commit()` in `lib/store.tsx` applied the optimistic patch, and the
 * call site never awaits it. Resolving means "the rows are on the server";
 * rejecting means "they are not, undo it". There is no third answer, which is
 * why nothing below returns quietly on a failure.
 *
 * **A filtered-away write is a failure, not a success.** PostgREST reports an
 * UPDATE or DELETE that RLS filtered to zero rows as `error: null` — the
 * request was well-formed, it simply matched nothing. Taking that as success is
 * the exact false-success class this project has now fixed seven times, so
 * every update and delete below asks for the affected rows back with `.select()`
 * and rejects when none came.
 *
 * **The two race-prone operations belong to the server.** `find_or_create_dm`
 * and `toggle_reaction` (supabase/migrations/20260908000800_store_swap.sql)
 * exist precisely so this file does not read-then-write. Do not reimplement
 * either here: the client-side version of the first can create two DMs for one
 * pair, and of the second can silently drop a concurrent reaction.
 *
 * **Files are Task 10's.** `attachments.storage_path` has nowhere to point
 * until Storage exists, so a message carrying files is refused outright rather
 * than posted with its attachments silently dropped.
 */
import type { LuminaClient } from "./client";
import type { DM, Message } from "../../types";

/** supabase-js resolves on a database error instead of rejecting, so every
 *  call below has to be checked by hand. One place to do it. */
function fail(what: string, error: { message: string; code?: string }): never {
  const code = error.code ? ` [${error.code}]` : "";
  throw new Error(`${what} failed${code}: ${error.message}`);
}

/**
 * `auth.uid()` for the rows that carry it explicitly (`read_state.user_id`).
 *
 * `getSession()` rather than `getUser()`: the latter round-trips to the auth
 * server, and `markChannelRead` runs on every conversation the user opens. The
 * id is only ever used as a value the database then re-checks against
 * `auth.uid()` under RLS, so a locally-read session cannot be used to write as
 * somebody else — the policy would refuse it.
 */
async function currentUserId(client: LuminaClient): Promise<string> {
  const { data, error } = await client.auth.getSession();
  if (error) fail("reading the session", error);
  const id = data.session?.user.id;
  if (!id) throw new Error("You are not signed in.");
  return id;
}

/**
 * Refused, not degraded. `readFileAsAttachment` still produces a data: URL and
 * the `attachments` table wants a `storage_path`, so the honest options are
 * "reject" and "post the message and drop the files". The second would be a
 * write that looks like it worked — the message appears, the files are gone —
 * which is the thing this plan keeps having to fix. Task 10 wires up Storage
 * and this guard goes away with it.
 */
function refuseAttachments(message: Message): void {
  if (message.attachments.length > 0) {
    throw new Error(
      "Sharing files isn't available on this workspace yet (store-swap task 10 — Storage)."
    );
  }
}

/** The message row, as `messages` wants it. `created_at` is the client's own
 *  timestamp rather than `now()` so the row and the optimistic copy already on
 *  screen agree — re-reading it after a hydrate must not shuffle the order. */
function messageRow(message: Message, conversationId: string) {
  return {
    id: message.id,
    conversation_id: conversationId,
    author_id: message.authorId,
    content: message.content,
    created_at: new Date(message.createdAt).toISOString(),
  };
}

/**
 * Your own read marker, moved forward.
 *
 * Split out because sending is also reading: `appendMessage` in the store
 * advances `lastRead` for the sender, and without persisting that the sender's
 * own message comes back unread on the next hydrate. Callers that are posting
 * a message treat a failure here as non-fatal — see `postMessage`.
 */
async function writeReadState(
  client: LuminaClient,
  conversationId: string,
  readAt: number
): Promise<{ message: string; code?: string } | null> {
  const userId = await currentUserId(client);
  const { error } = await client.from("read_state").upsert(
    {
      user_id: userId,
      conversation_id: conversationId,
      last_read_at: new Date(readAt).toISOString(),
    },
    { onConflict: "user_id,conversation_id" }
  );
  return error;
}

/**
 * Insert one message, then move the author's read marker to it.
 *
 * The read marker is deliberately *not* allowed to fail the operation. It is a
 * follow-up to a row that is already committed, and rejecting here would make
 * `commit()` roll a posted message back off the sender's screen while it sat on
 * the server for everybody else — a false *failure*, which is worse than the
 * stale marker it would be reporting. A marker that did not land self-corrects:
 * after the next hydrate `lastRead` is behind the message, so `MessageList`'s
 * effect stops short-circuiting and `markChannelRead` writes it properly.
 */
async function postMessage(
  client: LuminaClient,
  message: Message,
  conversationId: string
): Promise<void> {
  const { error } = await client
    .from("messages")
    .insert(messageRow(message, conversationId));
  if (error) fail("sending your message", error);

  const readError = await writeReadState(client, conversationId, message.createdAt);
  if (readError) {
    console.warn(
      `Lumina: the message was sent but its read marker was not: ${readError.message}`
    );
  }
}

export async function sendMessage(
  client: LuminaClient,
  message: Message
): Promise<Message> {
  refuseAttachments(message);
  await postMessage(client, message, message.channelId);
  return message;
}

/** The other half of a two-person thread, from the store's optimistic row. */
function otherMember(dm: DM, me: string): string {
  const other = dm.memberIds.find((id) => id !== me);
  if (!other) throw new Error("A direct message needs someone else.");
  return other;
}

/**
 * Resolve the *server's* id for this pair, and the thread's real creation time.
 *
 * `find_or_create_dm` is authoritative — it decides the id, it enforces
 * `message.send`, and it refuses somebody the caller cannot see. The store's
 * optimistically-created DM therefore has to be re-identified afterwards; that
 * is what `adoptDmId` in `lib/store.tsx` does with the row returned here.
 *
 * `created_at` is read rather than assumed because an *existing* thread's real
 * creation date is nothing like the `Date.now()` the store just stamped on its
 * placeholder. It is not worth failing over, though, so a read error falls back
 * to the optimistic value the next hydrate will correct anyway.
 */
async function resolveDm(client: LuminaClient, dm: DM, me: string): Promise<DM> {
  const { data, error } = await client.rpc("find_or_create_dm", {
    other_user_id: otherMember(dm, me),
  });
  if (error) fail("opening that conversation", error);
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("opening that conversation failed: no thread was returned");
  }

  const row = await client.from("dms").select("created_at").eq("id", data).maybeSingle();
  return {
    id: data,
    memberIds: dm.memberIds,
    createdAt: row.data ? Date.parse(row.data.created_at) : dm.createdAt,
  };
}

/**
 * Open-or-find the thread and post into it, in that order.
 *
 * `isNewDm` is ignored on purpose: the RPC is find-*or*-create, so asking it
 * unconditionally is both correct and the whole point — the client's belief
 * about whether a thread exists is exactly the stale read the RPC replaces.
 * The parameter stays in the seam because `LocalBackend` has no server to ask.
 */
export async function sendToUser(
  client: LuminaClient,
  dm: DM,
  message: Message
): Promise<DM> {
  refuseAttachments(message);
  const me = await currentUserId(client);
  const thread = await resolveDm(client, dm, me);
  // Into `thread.id`, never `message.channelId`: the store built the message
  // against its optimistic thread id, and posting to that would either fail on
  // the foreign key or — worse, if the id somehow existed — land in the wrong
  // conversation.
  await postMessage(client, message, thread.id);
  return thread;
}

export async function openDm(client: LuminaClient, dm: DM): Promise<DM> {
  const me = await currentUserId(client);
  return resolveDm(client, dm, me);
}

/**
 * `.select("id")` is load-bearing, not decoration: `messages_update` uses
 * `author_id = auth.uid()`, and an UPDATE whose USING clause filters the row
 * away reports success with zero rows changed. Without the returned rows this
 * would resolve, the edit would stay on screen, and nothing would be saved.
 */
export async function editMessage(
  client: LuminaClient,
  messageId: string,
  content: string,
  editedAt: number
): Promise<void> {
  const { data, error } = await client
    .from("messages")
    .update({ content, edited_at: new Date(editedAt).toISOString() })
    .eq("id", messageId)
    .select("id");
  if (error) fail("editing that message", error);
  if (!data || data.length === 0) {
    throw new Error("editing that message failed: you can only edit your own messages");
  }
}

/** Same reasoning as `editMessage`: `messages_delete` can filter the row away
 *  silently, and a delete that matched nothing must not report success. */
export async function deleteMessage(
  client: LuminaClient,
  messageId: string
): Promise<void> {
  const { data, error } = await client
    .from("messages")
    .delete()
    .eq("id", messageId)
    .select("id");
  if (error) fail("deleting that message", error);
  if (!data || data.length === 0) {
    throw new Error("deleting that message failed: it is not yours to delete");
  }
}

/**
 * One statement, server-side. The client version this replaces read the
 * reaction list, decided add-or-remove from it, and wrote the whole list back —
 * so a reaction added by somebody else between the read and the write was
 * erased. The RPC decides from the row it is deleting, under `security invoker`
 * so `reactions_insert` / `reactions_delete` are still the enforcement.
 *
 * The returned payload (`added`, `user_ids`, `count`) is not adopted: the store
 * has already computed the same toggle optimistically, and a disagreement means
 * a concurrent change that the next hydrate settles. Rejecting is what matters
 * here — a refused toggle must take the emoji back off.
 */
export async function toggleReaction(
  client: LuminaClient,
  messageId: string,
  emoji: string
): Promise<void> {
  const { error } = await client.rpc("toggle_reaction", {
    message_id: messageId,
    emoji,
  });
  if (error) fail("adding that reaction", error);
}

/** Upsert, because the row is per (user, conversation) and the user has almost
 *  certainly read this conversation before. `read_state_own` gates both halves
 *  on `user_id = auth.uid()`, so this can only ever move the caller's own
 *  marker. */
export async function markChannelRead(
  client: LuminaClient,
  conversationId: string,
  readAt: number
): Promise<void> {
  const error = await writeReadState(client, conversationId, readAt);
  if (error) fail("marking this conversation read", error);
}
