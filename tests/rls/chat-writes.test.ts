import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import type { DM, Message, MessageAttachment } from "@/lib/types";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { createChannel, seedRoles } from "../helpers/workspace";

// Task 5 — `SupabaseBackend`'s seven chat writes against lumina-dev, under the
// real policies.
//
// The unit suite (tests/qa/chat-writes.test.ts) proves what the STORE does with
// a resolved or rejected promise. This file is the other half: whether the
// database actually accepts or refuses the write, and — the part no double can
// tell us — whether a write RLS filtered away comes back looking like success.
// PostgREST reports an UPDATE or DELETE that matched no rows as `error: null`,
// so "the backend rejected it" is a real assertion here, not a formality.
//
// Every negative is paired with a positive control on the SAME client and the
// SAME method, so a backend that had simply stopped working could not pass by
// failing everything.
//
// Frugal like every file here: Supabase rate-limits signInWithPassword per
// project across the whole `npm run test:rls` run and these files execute in
// parallel forks. Exactly TWO identities ever sign in — `author`, who owns the
// messages, and `outsider`, who may see the public channel and nothing else.
// `mate` exists to be the far side of a DM and never authenticates.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const pubChannel = `c_cw_pub_${stamp}`;
const privChannel = `c_cw_priv_${stamp}`;
const privMessage = `m_cw_priv_${stamp}`;

const emails = {
  author: `cwauth-${stamp}@lumina.test`,
  outsider: `cwout-${stamp}@lumina.test`,
  mate: `cwmate-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

/** Conversations this file created through the backend; deleting the
 *  conversations row cascades into dms, dm_members, messages and read_state. */
const createdConversations = new Set<string>();

/** A `Message` shaped exactly as `lib/store.tsx`'s `buildMessage` produces it:
 *  a client-side id and a client-side `createdAt`, both of which the backend is
 *  expected to carry through unchanged. */
function message(
  id: string,
  conversationId: string,
  authorId: string,
  content: string,
  attachments: MessageAttachment[] = []
): Message {
  return {
    id: `m_cw_${id}_${stamp}`,
    channelId: conversationId,
    authorId,
    content,
    createdAt: Date.now(),
    reactions: [],
    attachments,
  };
}

/** The optimistic DM the store builds before the server has been asked — a
 *  client-generated id that `find_or_create_dm` is expected to replace. */
function optimisticDm(me: string, other: string): DM {
  return {
    id: `d_optimistic_${stamp}_${Math.random().toString(16).slice(2)}`,
    memberIds: [me, other],
    createdAt: Date.now(),
  };
}

async function backendFor(email: string): Promise<SupabaseBackend> {
  return new SupabaseBackend(await clientFor(email));
}

beforeAll(async () => {
  await seedRoles();

  // All three are plain Members: they hold message.send but not
  // message.deleteAny, so a refusal below is the row policy talking and not a
  // missing permission an admin fixture would have papered over.
  ids.author = await createTestUser({
    email: emails.author, password: TEST_PASSWORD,
    name: "Ari", handle: `cwari${stamp}`, roleId: "member",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Ola", handle: `cwola${stamp}`, roleId: "member",
  });
  ids.mate = await createTestUser({
    email: emails.mate, password: TEST_PASSWORD,
    name: "Moa", handle: `cwmoa${stamp}`, roleId: "member",
  });

  await createChannel({
    id: pubChannel, name: `cw-open-${stamp}`, isPrivate: false, createdBy: ids.author,
  });
  // Nobody is a member — not even its creator by row, so `author` cannot see
  // it either. Only `outsider`'s denials are asserted against it below.
  await createChannel({
    id: privChannel, name: `cw-shut-${stamp}`, isPrivate: true, createdBy: ids.author,
  });
  const seeded = await serviceClient.from("messages").insert({
    id: privMessage, conversation_id: privChannel, author_id: ids.author,
    content: "behind the door",
  });
  if (seeded.error) throw new Error(`seed messages failed: ${seeded.error.message}`);

  // Warm both sessions here: signInAs's rate-limit backoff can span ~45s,
  // which fits this hook's allowance but not a single test's.
  await clientFor(emails.author);
  await clientFor(emails.outsider);
}, 60_000);

afterAll(async () => {
  await serviceClient.from("conversations").delete().in("id", [
    pubChannel, privChannel, ...createdConversations,
  ]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("sendMessage", () => {
  it("writes the row with the client's own id and timestamp", async () => {
    const backend = await backendFor(emails.author);
    const msg = message("open", pubChannel, ids.author, "shipping today");

    await expect(backend.sendMessage(msg)).resolves.toMatchObject({ id: msg.id });

    const { data } = await serviceClient
      .from("messages").select("conversation_id,author_id,content,created_at")
      .eq("id", msg.id).single();
    expect(data?.conversation_id).toBe(pubChannel);
    expect(data?.author_id).toBe(ids.author);
    expect(data?.content).toBe("shipping today");
    // The optimistic copy on screen carries this exact millisecond; a row
    // stamped with now() instead would reshuffle the thread on the next load.
    expect(Date.parse(data!.created_at)).toBe(msg.createdAt);
  });

  it("moves the sender's own read marker with it", async () => {
    // Otherwise the sender's own message comes back unread after a hydrate:
    // the store's optimistic patch advances lastRead, and nothing would have
    // persisted it.
    const { data } = await serviceClient
      .from("read_state").select("last_read_at")
      .eq("user_id", ids.author).eq("conversation_id", pubChannel).maybeSingle();
    expect(data).not.toBeNull();
  });

  it("refuses a channel the sender cannot see", async () => {
    const backend = await backendFor(emails.outsider);

    // Positive control, same client and same method: the denial below is the
    // visibility rule, not a broken backend.
    const allowed = message("ctl", pubChannel, ids.outsider, "hello all");
    await expect(backend.sendMessage(allowed)).resolves.toMatchObject({ id: allowed.id });

    const denied = message("denied", privChannel, ids.outsider, "let me in");
    await expect(backend.sendMessage(denied)).rejects.toThrow();

    const { data } = await serviceClient.from("messages").select("id").eq("id", denied.id);
    expect(data).toEqual([]);
  });

  it("refuses a message carrying files rather than posting it without them", async () => {
    // Storage is Task 10; `attachments.storage_path` has nowhere to point.
    // Posting the text and dropping the files would be a write that looked
    // like it worked, which is the class this plan keeps closing.
    const backend = await backendFor(emails.author);
    const file: MessageAttachment = {
      id: `a_cw_${stamp}`, name: "budget.xlsx", size: 12, type: "application/vnd.ms-excel",
      dataUrl: "data:,", uploadedBy: ids.author, uploadedAt: Date.now(),
    };
    const msg = message("withfile", pubChannel, ids.author, "here you go", [file]);

    await expect(backend.sendMessage(msg)).rejects.toThrow(/task 10|storage/i);

    const { data } = await serviceClient.from("messages").select("id").eq("id", msg.id);
    expect(data).toEqual([]);
  });
});

describe("editMessage", () => {
  const target = `m_cw_edit_${stamp}`;

  beforeAll(async () => {
    const { error } = await serviceClient.from("messages").insert({
      id: target, conversation_id: pubChannel, author_id: ids.author, content: "first draft",
    });
    if (error) throw new Error(`seed edit target failed: ${error.message}`);
  });

  it("saves an edit to your own message", async () => {
    const backend = await backendFor(emails.author);
    const editedAt = Date.now();

    await expect(backend.editMessage(target, "second draft", editedAt)).resolves.toBeUndefined();

    const { data } = await serviceClient
      .from("messages").select("content,edited_at").eq("id", target).single();
    expect(data?.content).toBe("second draft");
    expect(Date.parse(data!.edited_at!)).toBe(editedAt);
  });

  it("REJECTS an edit to somebody else's message instead of reporting success", async () => {
    // This is the assertion the whole file exists for. `messages_update` uses
    // `author_id = auth.uid()`, and an UPDATE its USING clause filters away
    // comes back from PostgREST as error: null with zero rows changed. A
    // backend that only checked `error` would resolve here, `commit` would
    // keep the edit on screen, and nothing would have been saved.
    const backend = await backendFor(emails.outsider);

    await expect(backend.editMessage(target, "vandalised", Date.now())).rejects.toThrow();

    const { data } = await serviceClient
      .from("messages").select("content").eq("id", target).single();
    expect(data?.content).toBe("second draft");
  });
});

describe("deleteMessage", () => {
  it("REJECTS deleting somebody else's message, then allows the author's own", async () => {
    const owned = `m_cw_del_${stamp}`;
    const seeded = await serviceClient.from("messages").insert({
      id: owned, conversation_id: pubChannel, author_id: ids.author, content: "delete me",
    });
    expect(seeded.error).toBeNull();

    // Same silent-filter trap as the edit above: `messages_delete` allows
    // `author_id = auth.uid() or message.deleteAny`, and a plain Member has
    // neither for this row.
    const outsider = await backendFor(emails.outsider);
    await expect(outsider.deleteMessage(owned)).rejects.toThrow();
    const { data: survived } = await serviceClient
      .from("messages").select("id").eq("id", owned);
    expect(survived).toHaveLength(1);

    const author = await backendFor(emails.author);
    await expect(author.deleteMessage(owned)).resolves.toBeUndefined();
    const { data: gone } = await serviceClient.from("messages").select("id").eq("id", owned);
    expect(gone).toEqual([]);
  });
});

describe("toggleReaction", () => {
  const target = `m_cw_react_${stamp}`;

  beforeAll(async () => {
    const { error } = await serviceClient.from("messages").insert({
      id: target, conversation_id: pubChannel, author_id: ids.author, content: "react to me",
    });
    if (error) throw new Error(`seed reaction target failed: ${error.message}`);
  });

  it("adds then removes, through the RPC rather than a read-modify-write", async () => {
    const backend = await backendFor(emails.outsider);

    await expect(backend.toggleReaction(target, "🎉")).resolves.toBeUndefined();
    const { data: added } = await serviceClient
      .from("reactions").select("user_id").eq("message_id", target).eq("emoji", "🎉");
    expect(added).toEqual([{ user_id: ids.outsider }]);

    await expect(backend.toggleReaction(target, "🎉")).resolves.toBeUndefined();
    const { data: removed } = await serviceClient
      .from("reactions").select("user_id").eq("message_id", target).eq("emoji", "🎉");
    expect(removed).toEqual([]);
  });

  it("keeps a concurrent reaction from somebody else", async () => {
    // The client-side read-modify-write this replaces wrote the whole
    // reaction list back, so a reaction added between the read and the write
    // was erased. Seeded directly to stand in for that other person.
    const { error } = await serviceClient
      .from("reactions").insert({ message_id: target, emoji: "👍", user_id: ids.mate });
    expect(error).toBeNull();

    const backend = await backendFor(emails.outsider);
    await expect(backend.toggleReaction(target, "👍")).resolves.toBeUndefined();

    const { data } = await serviceClient
      .from("reactions").select("user_id").eq("message_id", target).eq("emoji", "👍");
    expect((data ?? []).map((r) => r.user_id).sort()).toEqual(
      [ids.mate, ids.outsider].sort()
    );
  });

  it("refuses a message in a channel the caller is not in", async () => {
    const backend = await backendFor(emails.outsider);
    // The positive control is the add/remove pair above, on the same client
    // and the same method.
    await expect(backend.toggleReaction(privMessage, "👀")).rejects.toThrow();

    const { data } = await serviceClient
      .from("reactions").select("user_id").eq("message_id", privMessage);
    expect(data).toEqual([]);
  });
});

describe("markChannelRead", () => {
  it("upserts one row per conversation and moves it forward", async () => {
    const backend = await backendFor(emails.outsider);
    const first = Date.now() - 60_000;

    await expect(backend.markChannelRead(pubChannel, first)).resolves.toBeUndefined();
    const { data: after } = await serviceClient
      .from("read_state").select("last_read_at")
      .eq("user_id", ids.outsider).eq("conversation_id", pubChannel);
    expect(after).toHaveLength(1);
    expect(Date.parse(after![0].last_read_at)).toBe(first);

    const second = Date.now();
    await expect(backend.markChannelRead(pubChannel, second)).resolves.toBeUndefined();
    const { data: moved } = await serviceClient
      .from("read_state").select("last_read_at")
      .eq("user_id", ids.outsider).eq("conversation_id", pubChannel);
    // One row, not two: a second insert would be a 23505 on the composite PK.
    expect(moved).toHaveLength(1);
    expect(Date.parse(moved![0].last_read_at)).toBe(second);
  });

  it("writes the caller's own marker and nobody else's", async () => {
    const { data } = await serviceClient
      .from("read_state").select("user_id").eq("conversation_id", pubChannel);
    const users = (data ?? []).map((r) => r.user_id).sort();
    // author's came from sendMessage, outsider's from the test above. mate,
    // who never called anything, has none.
    expect(users).toEqual([ids.author, ids.outsider].sort());
  });
});

describe("openDm", () => {
  it("returns the SERVER's thread id, not the optimistic one it was handed", async () => {
    const backend = await backendFor(emails.author);
    const optimistic = optimisticDm(ids.author, ids.mate);

    const opened = await backend.openDm(optimistic);
    createdConversations.add(opened.id);

    // The whole reason `adoptDmId` exists in lib/store.tsx: the id the caller
    // navigates to is chosen by find_or_create_dm, never by the client.
    expect(opened.id).not.toBe(optimistic.id);
    expect(opened.memberIds).toEqual(optimistic.memberIds);

    const { data } = await serviceClient
      .from("dm_members").select("user_id").eq("dm_id", opened.id);
    expect((data ?? []).map((r) => r.user_id).sort()).toEqual(
      [ids.author, ids.mate].sort()
    );
    // And the real creation time, not the placeholder the store stamped.
    const { data: row } = await serviceClient
      .from("dms").select("created_at").eq("id", opened.id).single();
    expect(opened.createdAt).toBe(Date.parse(row!.created_at));
  });

  it("finds the same thread again instead of creating a second one", async () => {
    const backend = await backendFor(emails.author);
    const again = await backend.openDm(optimisticDm(ids.author, ids.mate));
    expect(createdConversations.has(again.id)).toBe(true);

    const { data } = await serviceClient
      .from("dm_members").select("dm_id").eq("user_id", ids.mate);
    const withAuthor = new Set((data ?? []).map((r) => r.dm_id));
    expect(withAuthor.size).toBe(1);
  });

  it("refuses a DM with somebody the caller cannot see", async () => {
    const backend = await backendFor(emails.author);
    const ghost: DM = {
      id: `d_ghost_${stamp}`,
      memberIds: [ids.author, "00000000-0000-0000-0000-000000000000"],
      createdAt: Date.now(),
    };
    await expect(backend.openDm(ghost)).rejects.toThrow(/not on this team/i);
  });
});

describe("sendToUser", () => {
  it("posts into the server's thread, not the id the store guessed", async () => {
    const backend = await backendFor(emails.outsider);
    const optimistic = optimisticDm(ids.outsider, ids.mate);
    const msg = message("dm", optimistic.id, ids.outsider, "first word");

    const thread = await backend.sendToUser(optimistic, true, msg);
    createdConversations.add(thread.id);

    expect(thread.id).not.toBe(optimistic.id);

    const { data } = await serviceClient
      .from("messages").select("conversation_id,content").eq("id", msg.id).single();
    // The message follows the thread. Left on `optimistic.id` it would either
    // violate the foreign key or land in a conversation nobody can open.
    expect(data?.conversation_id).toBe(thread.id);
    expect(data?.content).toBe("first word");

    // Nothing was written under the id the client made up.
    const { data: phantom } = await serviceClient
      .from("conversations").select("id").eq("id", optimistic.id);
    expect(phantom).toEqual([]);
  });

  it("creates the thread and the message together, or neither", async () => {
    // A second send to the same person reuses the thread rather than racing a
    // new one — the find-then-create this replaced could produce two.
    const backend = await backendFor(emails.outsider);
    const optimistic = optimisticDm(ids.outsider, ids.mate);
    const msg = message("dm2", optimistic.id, ids.outsider, "second word");

    const thread = await backend.sendToUser(optimistic, false, msg);
    expect(createdConversations.has(thread.id)).toBe(true);

    const { data } = await serviceClient
      .from("messages").select("id").eq("conversation_id", thread.id);
    expect(data).toHaveLength(2);
  });

  it("writes nothing at all when the recipient is not visible", async () => {
    const backend = await backendFor(emails.outsider);
    const ghost = `00000000-0000-0000-0000-000000000000`;
    const optimistic: DM = {
      id: `d_ghost2_${stamp}`, memberIds: [ids.outsider, ghost], createdAt: Date.now(),
    };
    const msg = message("ghost", optimistic.id, ids.outsider, "into the void");

    await expect(backend.sendToUser(optimistic, true, msg)).rejects.toThrow();

    // The RPC is asked BEFORE the message is inserted precisely so a refused
    // thread leaves no orphan message behind.
    const { data } = await serviceClient.from("messages").select("id").eq("id", msg.id);
    expect(data).toEqual([]);
  });
});
