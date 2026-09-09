// Task 4 — `SupabaseBackend` itself: the query plan, the not-yet-implemented
// writes, and the module-graph guarantee that lets this file exist at all.
//
// No credentials and no network. The unit suite has never held
// `NEXT_PUBLIC_SUPABASE_*`, and `lib/supabase.ts` throws at import time when
// they are missing — so the fact that this file can import `@/lib/backend`
// and `@/lib/backend/supabase` and still run *is* the assertion that the real
// client stayed out of the static graph. The first describe block makes that
// implicit guarantee explicit.
import { describe, expect, it } from "vitest";

import { createBackend } from "@/lib/backend";
import { LocalBackend } from "@/lib/backend/local";
import { SupabaseBackend } from "@/lib/backend/supabase";
import type { Backend } from "@/lib/backend/types";
import { hydrateWorkspace } from "@/lib/backend/supabase/hydrate";
import type { LuminaClient } from "@/lib/backend/supabase/client";

const ME = "11111111-1111-4111-8111-111111111111";

type QueryResult = { data: unknown[] | null; error: { message: string; code?: string } | null };

/**
 * A PostgREST stand-in. Records every table touched, in order, and resolves
 * each query on a later microtask so the parallelism assertion below has
 * something to observe.
 */
function fakeClient(opts: {
  rows?: Record<string, unknown[]>;
  errors?: Record<string, { message: string; code?: string }>;
  rpcData?: Record<string, unknown>;
  userId?: string | null;
} = {}) {
  const issued: string[] = [];

  const builder = (table: string): PromiseLike<QueryResult> & Record<string, unknown> => {
    const settle = (): Promise<QueryResult> =>
      Promise.resolve().then(() => {
        const error = opts.errors?.[table];
        return error ? { data: null, error } : { data: opts.rows?.[table] ?? [], error: null };
      });
    const self: Record<string, unknown> = {
      select: () => self,
      order: () => self,
      limit: () => self,
      eq: () => self,
      in: () => self,
      // Task 5's writes. Each still settles through `settle()`, so a table
      // named in `errors` fails and every other one comes back empty — which
      // is exactly the "RLS filtered it away" shape the update and delete
      // guards below have to notice.
      insert: () => self,
      update: () => self,
      delete: () => self,
      upsert: () => self,
      single: () => self,
      maybeSingle: () => settle().then((r) => ({ data: null, error: r.error })),
      then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return self as PromiseLike<QueryResult> & Record<string, unknown>;
  };

  const client = {
    issued,
    auth: {
      getUser: () => {
        issued.push("auth.getUser");
        return Promise.resolve(
          opts.userId === null
            ? { data: { user: null }, error: null }
            : { data: { user: { id: opts.userId ?? ME } }, error: null }
        );
      },
      // Read locally, not over the network — see `currentUserId` in
      // lib/backend/supabase/chat.ts for why the hot path uses this one.
      getSession: () => {
        issued.push("auth.getSession");
        return Promise.resolve(
          opts.userId === null
            ? { data: { session: null }, error: null }
            : { data: { session: { user: { id: opts.userId ?? ME } } }, error: null }
        );
      },
    },
    rpc: (name: string) => {
      issued.push(`rpc.${name}`);
      const error = opts.errors?.[`rpc.${name}`];
      return Promise.resolve(
        error ? { data: null, error } : { data: opts.rpcData?.[name] ?? null, error: null }
      );
    },
    from: (table: string) => {
      issued.push(table);
      return builder(table);
    },
  };
  return client;
}

const asClient = (fake: ReturnType<typeof fakeClient>) => fake as unknown as LuminaClient;

// ---------------------------------------------------------------------------

describe("the static module graph", () => {
  it("has no Supabase credentials, which is what makes the next assertion mean something", () => {
    // If this ever becomes false, the import assertion below stops proving
    // anything — `lib/supabase.ts` would import cleanly either way.
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBeUndefined();
  });

  it("constructs a SupabaseBackend without ever loading lib/supabase.ts", () => {
    // `lib/supabase.ts` throws at module scope on the missing vars above. A
    // static import anywhere under lib/backend/supabase/ — or in
    // lib/backend/index.ts — would have failed this file at collection time,
    // and with it every other suite that mounts the store.
    expect(() => new SupabaseBackend()).not.toThrow();
  });

  it("gives a local build the local backend", () => {
    // NEXT_PUBLIC_BACKEND is unset here, so this is the default path the
    // public GitHub Pages build takes.
    expect(createBackend()).toBeInstanceOf(LocalBackend);
  });
});

describe("hydrateWorkspace — the query plan", () => {
  const TABLES = [
    "profiles",
    "roles",
    "channels",
    "channel_members",
    "dms",
    "dm_members",
    "messages",
    "reactions",
    "message_attachments",
    "attachments",
    "projects",
    "project_members",
    "project_attachments",
    "tasks",
    "task_collaborators",
    "task_attachments",
    "activities",
    "read_state",
  ];

  it("issues every select before awaiting any of them", async () => {
    const fake = fakeClient();
    const pending = hydrateWorkspace(asClient(fake));
    // Synchronous check, before the first await resolves: a sequential
    // implementation would have issued exactly one request by now. This is
    // the whole point — sign-in latency to a distant region is one round
    // trip, not nineteen.
    expect(fake.issued).toHaveLength(TABLES.length + 1);
    await pending;
  });

  it("reads exactly the tables the plan names, and no others", async () => {
    const fake = fakeClient();
    await hydrateWorkspace(asClient(fake));
    expect([...fake.issued].sort()).toEqual([...TABLES, "auth.getUser"].sort());
  });

  it("takes currentUserId from the session, not from the profile rows", async () => {
    const fake = fakeClient({
      userId: ME,
      rows: {
        profiles: [
          {
            id: "99999999-9999-4999-8999-999999999999",
            email: "other@lumina.test",
            name: "Someone Else",
            handle: "else",
            title: "",
            role_id: "member",
            color: "#7c3aed",
            created_at: "2026-09-08T10:00:00+00:00",
            mfa_required: false,
          },
        ],
      },
    });
    // This is the Task 3 carry-over closing: SessionBridge already passed a
    // real auth UUID, but the store fell back to users[0]. It must not now.
    const state = await hydrateWorkspace(asClient(fake));
    expect(state.currentUserId).toBe(ME);
  });

  it("adds no client-side filter to read_state", async () => {
    // RLS's read_state_own policy is the filter. A `.eq("user_id", me)` here
    // would produce a correct-looking AppState even with that policy broken.
    const fake = fakeClient();
    const seen: string[] = [];
    const spied = {
      ...fake,
      from: (table: string) => {
        const b = fake.from(table) as Record<string, unknown>;
        const eq = b.eq as () => unknown;
        b.eq = (...args: unknown[]) => {
          seen.push(`${table}.eq(${String(args[0])})`);
          return eq();
        };
        return b;
      },
    };
    await hydrateWorkspace(spied as unknown as LuminaClient);
    expect(seen).toEqual([]);
  });
});

describe("hydrateWorkspace — failure", () => {
  it("rejects, naming the table, when a select errors", async () => {
    const fake = fakeClient({
      errors: { messages: { message: "permission denied for table messages", code: "42501" } },
    });
    await expect(hydrateWorkspace(asClient(fake))).rejects.toThrow(/reading messages failed \[42501\]/);
  });

  it("surfaces a missing table (PGRST205) rather than reporting an empty workspace", async () => {
    // Verified in this project: `.select("*", { head: true })` returns
    // `error: null` for a table that does not exist, and `{ count: "exact" }`
    // does not fix it — only a body select produces PGRST205. Nothing in
    // hydrate.ts uses a head request or a `count ?? 0` existence check.
    const fake = fakeClient({
      errors: {
        read_state: { message: "Could not find the table 'public.read_state'", code: "PGRST205" },
      },
    });
    await expect(hydrateWorkspace(asClient(fake))).rejects.toThrow(/PGRST205/);
  });

  it("rejects when there is no signed-in user instead of hydrating an anonymous shell", async () => {
    const fake = fakeClient({ userId: null });
    await expect(hydrateWorkspace(asClient(fake))).rejects.toThrow(/no signed-in user/);
  });

  it("resolves normally when nothing is wrong", async () => {
    // Positive control for the three rejections above.
    const state = await hydrateWorkspace(asClient(fakeClient()));
    expect(state.currentUserId).toBe(ME);
    expect(state.users).toEqual([]);
  });
});

describe("SupabaseBackend — the operations Tasks 7-8 still owe", () => {
  // Typed as `Backend`, not as the class: lib/backend/types.ts is where the
  // contract's parameters are named, and the implementations deliberately
  // declare none (same style as LocalBackend).
  const backend: Backend = new SupabaseBackend(asClient(fakeClient()));

  /** Tasks 5 and 6 moved their own out of this list when they were
   *  implemented. They keep the second property below — never a synchronous
   *  throw — because `commit()` calls `op()` outside a try/catch either way. */
  const implemented: Array<[string, () => Promise<unknown>]> = [
    ["sendMessage", () => backend.sendMessage({ attachments: [] } as never)],
    ["sendToUser", () => backend.sendToUser({ memberIds: ["a", "b"] } as never, true, { attachments: [] } as never)],
    ["editMessage", () => backend.editMessage("m", "hi", 0)],
    ["deleteMessage", () => backend.deleteMessage("m")],
    ["toggleReaction", () => backend.toggleReaction("m", "👍")],
    ["markChannelRead", () => backend.markChannelRead("c", 0)],
    ["openDm", () => backend.openDm({ memberIds: ["a", "b"] } as never)],
    ["createChannel", () => backend.createChannel({ members: [], createdAt: 0 } as never)],
    ["deleteChannel", () => backend.deleteChannel("c")],
    ["setChannelAccess", () => backend.setChannelAccess("c", { isPrivate: false, members: [] })],
    ["createProject", () => backend.createProject({ attachments: [], members: [], createdAt: 0 } as never)],
    ["updateProject", () => backend.updateProject("p", { name: "n" })],
    ["deleteProject", () => backend.deleteProject("p")],
    ["setProjectAccess", () => backend.setProjectAccess("p", { restricted: false, members: [] })],
    ["putActivity", () => backend.putActivity({ id: "a", ts: 0, actorId: "u", text: "x", kind: "member" } as never)],
  ];

  const writes: Array<[string, () => Promise<unknown>]> = [
    ["setUserRole", () => backend.setUserRole("u", "r")],
    ["createRole", () => backend.createRole({} as never)],
    ["updateRole", () => backend.updateRole("r", {})],
    ["setRolePermission", () => backend.setRolePermission("r", "task.edit", true)],
    ["deleteRole", () => backend.deleteRole("r")],
    ["createTask", () => backend.createTask({} as never)],
    ["updateTask", () => backend.updateTask("t", {})],
    ["moveTask", () => backend.moveTask("t", "todo", 0)],
    ["deleteTask", () => backend.deleteTask("t")],
    ["putAttachment", () => backend.putAttachment({} as never, {} as never)],
    ["deleteAttachment", () => backend.deleteAttachment({} as never, "a")],
  ];

  it.each(writes)("%s rejects rather than pretending to succeed", async (name, call) => {
    // A resolving no-op would leave the store's optimistic patch on screen
    // with nothing written behind it — a write that looks like it worked.
    await expect(call()).rejects.toThrow(new RegExp(`${name}\\(\\) is not implemented yet`));
  });

  it.each([...writes, ...implemented])("%s rejects asynchronously, never throwing synchronously", async (name, call) => {
    // `commit()` in lib/store.tsx calls `op()` outside a try/catch, so a
    // synchronous throw would escape past the rollback with the optimistic
    // patch still applied. Every one of these must return a promise.
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = call();
    }).not.toThrow();
    expect(promise).toBeInstanceOf(Promise);
    await promise!.catch(() => undefined);
  });
});

describe("SupabaseBackend — a write RLS filtered away is not a success", () => {
  // PostgREST resolves an UPDATE or DELETE that matched zero rows with
  // `error: null` — the request was well-formed, it just found nothing. That
  // is what an RLS policy filtering the row away looks like from here, and
  // taking it as success would leave the store's optimistic patch on screen
  // with nothing written behind it. The fake client returns an empty `data`
  // for every table, which is precisely that case.
  const backend = new SupabaseBackend(asClient(fakeClient()));

  it("editMessage rejects when no row came back", async () => {
    await expect(backend.editMessage("m_someone_elses", "vandalised", 0)).rejects.toThrow(
      /your own messages/i
    );
  });

  it("deleteMessage rejects when no row came back", async () => {
    await expect(backend.deleteMessage("m_someone_elses")).rejects.toThrow(/not yours/i);
  });

  it("sendMessage refuses a message carrying files rather than dropping them", async () => {
    // Storage is Task 10. Posting the text and silently losing the files
    // would be a write that looked like it worked.
    const message = {
      id: "m1", channelId: "c1", authorId: ME, content: "here you go",
      createdAt: 0, reactions: [],
      attachments: [{ id: "a1", name: "notes.md", size: 1, type: "text/markdown",
        dataUrl: "data:,", uploadedBy: ME, uploadedAt: 0 }],
    };
    await expect(backend.sendMessage(message as never)).rejects.toThrow(/task 10|storage/i);
  });

  it("openDm rejects when the RPC hands back no thread", async () => {
    // Not "carry on with the id the client invented": there would be no such
    // conversation, and every message posted into it would be orphaned.
    const dm = { id: "d_optimistic", memberIds: [ME, "u_other"], createdAt: 0 };
    await expect(backend.openDm(dm as never)).rejects.toThrow(/no thread was returned/);
  });

  // Task 6's four filtered-away shapes. Each of these is an UPDATE or DELETE
  // whose USING clause can filter the row away — "you don't manage this
  // project", "that isn't your channel to delete" — and PostgREST reports every
  // one of them as `error: null` with an empty body.
  it("deleteChannel rejects when no row came back", async () => {
    await expect(backend.deleteChannel("c_someone_elses")).rejects.toThrow(/not yours/i);
  });

  it("deleteProject rejects when no row came back", async () => {
    await expect(backend.deleteProject("p_locked")).rejects.toThrow(/permission/i);
  });

  it("updateProject rejects when no row came back", async () => {
    await expect(backend.updateProject("p_locked", { name: "Seized" })).rejects.toThrow(
      /permission/i
    );
  });

  it("setChannelAccess rejects when no row came back", async () => {
    await expect(
      backend.setChannelAccess("c_locked", { isPrivate: true, members: [] })
    ).rejects.toThrow(/permission/i);
  });

  it("setProjectAccess rejects when no row came back — before touching membership", async () => {
    // The order matters: if the projects UPDATE is filtered away the caller
    // does not manage this project, and the member writes that follow must
    // never be attempted. `project_members` is absent from `issued` precisely
    // because the rejection came first.
    const client = fakeClient();
    const denied = new SupabaseBackend(asClient(client));
    await expect(
      denied.setProjectAccess("p_locked", { restricted: true, members: [] })
    ).rejects.toThrow(/permission/i);
    expect(client.issued).not.toContain("project_members");
  });

  it("updateProject refuses a patch carrying files rather than saving everything else", async () => {
    // Same rule as sendMessage above: Storage is Task 10, so a project whose
    // attachments changed cannot be persisted, and saving the name while
    // dropping the file would look like it worked.
    await expect(
      backend.updateProject("p1", { name: "Renamed", attachments: [{ id: "a1" } as never] })
    ).rejects.toThrow(/task 10|storage/i);
  });

  it("updateProject writes nothing at all for a patch with no persistable field", async () => {
    // An empty UPDATE is rejected by PostgREST outright, so "no fields" has to
    // be a no-op rather than a statement — and it must not report a failure
    // either, since nothing was asked for.
    const client = fakeClient();
    const quiet = new SupabaseBackend(asClient(client));
    await expect(quiet.updateProject("p1", {})).resolves.toBeUndefined();
    expect(client.issued).not.toContain("projects");
  });

  it("createChannel inserts the conversation before the channel", async () => {
    // Positive control for the five rejections above, and an ordering
    // assertion: `channels.id` references `conversations(id)`, so the reverse
    // order is a foreign-key violation every time.
    const client = fakeClient();
    const ok = new SupabaseBackend(asClient(client));
    const channel = {
      id: "c_new", name: "design", description: "", isPrivate: true, isTeam: false,
      members: [{ userId: ME, level: "editor" }], createdBy: ME, createdAt: 0,
    };

    await expect(ok.createChannel(channel as never)).resolves.toMatchObject({ id: "c_new" });
    expect(client.issued.filter((t) => t !== "auth.getSession")).toEqual([
      "conversations", "channels", "channel_members",
    ]);
  });

  it("createChannel sweeps its conversation row when the channel insert fails", async () => {
    // Otherwise a failed create leaves an unreferenced parent behind: invisible
    // (nothing reads `conversations` on its own) but real, and never cleaned up.
    const client = fakeClient({ errors: { channels: { message: "denied", code: "42501" } } });
    const failing = new SupabaseBackend(asClient(client));

    await expect(
      failing.createChannel({ id: "c_bad", members: [], createdAt: 0 } as never)
    ).rejects.toThrow(/42501/);
    // conversations twice: the insert, then the sweep.
    expect(client.issued.filter((t) => t === "conversations")).toHaveLength(2);
  });

  it("openDm adopts the id the RPC chose", async () => {
    // Positive control for all four rejections above: the same code path
    // resolves when the database answers properly.
    const client = fakeClient({ rpcData: { find_or_create_dm: "d_from_the_server" } });
    const ok = new SupabaseBackend(asClient(client));
    const dm = { id: "d_optimistic", memberIds: [ME, "u_other"], createdAt: 0 };

    await expect(ok.openDm(dm as never)).resolves.toMatchObject({
      id: "d_from_the_server",
      memberIds: [ME, "u_other"],
    });
    // Through the RPC, never a client-side find-then-create.
    expect(client.issued).toContain("rpc.find_or_create_dm");
  });
});

describe("SupabaseBackend — session-bound identity", () => {
  it("accepts the signed-in user's own id", async () => {
    const backend = new SupabaseBackend(asClient(fakeClient({ userId: ME })));
    await expect(backend.switchUser(ME)).resolves.toBeUndefined();
  });

  it("refuses to act as anybody else", async () => {
    // There is no impersonation on a real backend: RLS would keep filtering
    // as the real user while every label and permission check used the other
    // identity. Rejecting makes `commit` undo the optimistic switch.
    const backend = new SupabaseBackend(asClient(fakeClient({ userId: ME })));
    await expect(backend.switchUser("22222222-2222-4222-8222-222222222222")).rejects.toThrow(
      /only act as the signed-in user/
    );
  });
});

describe("SupabaseBackend — sign-out", () => {
  it("resets to a workspace holding none of the previous user's rows", async () => {
    const backend = new SupabaseBackend(asClient(fakeClient()));
    const state = await backend.reset();
    expect(state.currentUserId).toBe("");
    expect(state.messages).toEqual([]);
    expect(state.projects).toEqual([]);
    expect(state.channels).toEqual([]);
    // But still renderable: see signedOutState's note about SessionBridge.
    expect(state.users).toHaveLength(1);
  });

  it("has nothing to do in persist() — each write owns its own rows", () => {
    const backend = new SupabaseBackend(asClient(fakeClient()));
    expect(() => backend.persist()).not.toThrow();
  });
});
