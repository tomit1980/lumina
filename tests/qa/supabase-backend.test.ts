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
  /** Tables that answer with `rows` for their FIRST statement and with an
   *  empty body for every one after it. Task 8 needs this: `readRole` and the
   *  write it precedes both hit `roles`, and the shape under test is "the
   *  caller could read the row (roles_read is `using (true)`) and the write was
   *  then filtered away by roles_write" — which a single per-table fixture
   *  cannot express. */
  emptyAfterFirst?: string[];
} = {}) {
  const issued: string[] = [];
  /** Every write this client was handed, so a test can assert what a backend
   *  actually sent — Task 7 needs it for the two columns whose *absence* is the
   *  behaviour under test (`tasks.position`, and `assignee_id` on an unchanged
   *  owner). PostgREST discards nothing, so neither does the double. */
  const payloads: Array<{ table: string; op: string; value: unknown }> = [];
  /** The arguments each RPC was called with, by name. */
  const rpcArgs: Record<string, unknown> = {};

  /** How many statements each table has taken, for `emptyAfterFirst`. */
  const seen: Record<string, number> = {};

  const builder = (table: string): PromiseLike<QueryResult> & Record<string, unknown> => {
    const nth = (seen[table] = (seen[table] ?? 0) + 1);
    const settle = (): Promise<QueryResult> =>
      Promise.resolve().then(() => {
        const error = opts.errors?.[table];
        if (error) return { data: null, error };
        const drained = nth > 1 && (opts.emptyAfterFirst ?? []).includes(table);
        return { data: drained ? [] : opts.rows?.[table] ?? [], error: null };
      });
    const record = (op: string) => (value: unknown) => {
      payloads.push({ table, op, value });
      return self;
    };
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
      insert: record("insert"),
      update: record("update"),
      delete: () => self,
      upsert: record("upsert"),
      single: () => self,
      // The first row, not an unconditional null: `.maybeSingle()` is how a
      // backend reads one row back, and a double that always answered "no such
      // row" could only ever exercise the refusal path. Tables with no `rows`
      // entry still answer null, which is what the Task 6 assertions below
      // depend on.
      maybeSingle: () => settle().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })),
      then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return self as PromiseLike<QueryResult> & Record<string, unknown>;
  };

  /**
   * Task 10's half of the double. Every Storage call this client was handed,
   * so a test can assert not just that bytes moved but in WHICH ORDER against
   * the rows — the upload/delete ordering is a correctness rule
   * (supabase/migrations/20260910001000_storage.sql), not a style choice, and
   * `issued` alone cannot see it because Storage is not a table.
   *
   * `remove` answers with the paths it removed. That matters: storage-api
   * reports a delete its policy filtered away as `error: null` with an EMPTY
   * array, the same false-success shape `requireRows` exists for, and
   * `errors["storage.<bucket>.empty"]` is how a test asks for it.
   */
  const storageOps: Array<{ bucket: string; op: string; path: string }> = [];
  const storage = {
    from: (bucket: string) => ({
      upload: (path: string, _body: Blob, options?: { upsert?: boolean }) => {
        issued.push(`storage.${bucket}`);
        storageOps.push({ bucket, op: options?.upsert ? "overwrite" : "upload", path });
        const error = opts.errors?.[`storage.${bucket}`];
        return Promise.resolve(error ? { data: null, error } : { data: { path }, error: null });
      },
      remove: (paths: string[]) => {
        issued.push(`storage.${bucket}`);
        for (const path of paths) storageOps.push({ bucket, op: "remove", path });
        const error = opts.errors?.[`storage.${bucket}`];
        if (error) return Promise.resolve({ data: null, error });
        const filtered = (opts.errors?.[`storage.${bucket}.empty`] ?? null) !== null;
        return Promise.resolve({
          data: filtered ? [] : paths.map((name) => ({ name })),
          error: null,
        });
      },
      createSignedUrl: (path: string) => {
        issued.push(`storage.${bucket}`);
        storageOps.push({ bucket, op: "sign", path });
        const error = opts.errors?.[`storage.${bucket}`];
        return Promise.resolve(
          error
            ? { data: null, error }
            : { data: { signedUrl: `https://signed.test/${bucket}/${path}` }, error: null }
        );
      },
      download: (path: string) => {
        issued.push(`storage.${bucket}`);
        storageOps.push({ bucket, op: "download", path });
        const error = opts.errors?.[`storage.${bucket}`];
        return Promise.resolve(
          error ? { data: null, error } : { data: new Blob(["hi"], { type: "text/plain" }), error: null }
        );
      },
    }),
  };

  const client = {
    issued,
    payloads,
    storageOps,
    storage,
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
    rpcArgs,
    rpc: (name: string, args?: unknown) => {
      issued.push(`rpc.${name}`);
      rpcArgs[name] = args;
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

describe("SupabaseBackend — every operation reaches the server", () => {
  // Typed as `Backend`, not as the class: lib/backend/types.ts is where the
  // contract's parameters are named, and the implementations deliberately
  // declare none (same style as LocalBackend).
  const backend: Backend = new SupabaseBackend(asClient(fakeClient()));

  /** Tasks 5–8 moved their own out of the "not implemented" list as they
   *  landed, and Task 10 emptied it: the two attachment operations were the
   *  last two owed, and Storage now backs both. Everything keeps the property
   *  below — never a synchronous throw — because `commit()` calls `op()`
   *  outside a try/catch either way. */
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
    ["createTask", () => backend.createTask({ attachments: [], collaboratorIds: [], labels: [], createdAt: 0 } as never)],
    ["updateTask", () => backend.updateTask("t", { title: "n" })],
    ["moveTask", () => backend.moveTask("t", "todo", 0)],
    ["deleteTask", () => backend.deleteTask("t")],
    ["setUserRole", () => backend.setUserRole("u", "r")],
    ["createRole", () => backend.createRole({ permissions: [] } as never)],
    ["updateRole", () => backend.updateRole("r", { name: "n" })],
    ["setRolePermission", () => backend.setRolePermission("r", "task.edit", true)],
    ["deleteRole", () => backend.deleteRole("r")],
  ];

  const writes: Array<[string, () => Promise<unknown>]> = [
    ["putAttachment", () => backend.putAttachment("project", { id: "a", name: "f" } as never, new Blob(["x"]))],
    ["saveAttachment", () => backend.saveAttachment({ id: "a", name: "f", dataUrl: "" } as never, new Blob(["x"]), "u", 0)],
    ["deleteAttachment", () => backend.deleteAttachment({ id: "a", name: "f", dataUrl: "" } as never)],
    ["attachmentUrl", () => backend.attachmentUrl("project-files/a")],
    ["readAttachment", () => backend.readAttachment("project-files/a", "text/plain")],
  ];

  it("no operation on the seam answers \"not implemented\" any more", async () => {
    // Task 10 was the last one owed. If a future task parks an operation
    // behind a typed placeholder again, this is where it gets noticed.
    const outcomes = await Promise.allSettled(
      [...writes, ...implemented].map(([, call]) => call())
    );
    const parked = outcomes.filter(
      (o) => o.status === "rejected" && /is not implemented yet/.test(String(o.reason))
    );
    expect(parked).toEqual([]);
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

  it("sendMessage LINKS a message's files instead of refusing them (Task 10)", async () => {
    // Until Task 10 this rejected: the bytes had nowhere to live, and posting
    // the text while losing the files would be a write that looked like it
    // worked. Now the bytes are already in Storage and what is written here is
    // the link - after the message row, because `message_attachments_insert`
    // asks whether the caller authored the message it is being attached to.
    const client = fakeClient();
    const sender = new SupabaseBackend(asClient(client));
    const message = {
      id: "m1", channelId: "c1", authorId: ME, content: "here you go",
      createdAt: 0, reactions: [],
      attachments: [{ id: "a1", name: "notes.md", size: 1, type: "text/markdown",
        dataUrl: "message-files/a1", uploadedBy: ME, uploadedAt: 0,
        sourceProjectId: "p_design" }],
    };
    await expect(sender.sendMessage(message as never)).resolves.toBeTruthy();
    expect(client.issued.indexOf("messages")).toBeLessThan(
      client.issued.indexOf("message_attachments")
    );
    expect(
      client.payloads.find((entry) => entry.table === "message_attachments")?.value
    ).toEqual([{ message_id: "m1", attachment_id: "a1", source_project_id: "p_design" }]);
  });

  it("sendMessage sweeps the message row back out when the file link is refused", async () => {
    // The alternative is a posted message whose files are missing - the
    // "looks like it worked" write, one door along.
    const client = fakeClient({
      errors: {
        message_attachments: {
          message: "new row violates row-level security policy",
          code: "42501",
        },
      },
    });
    const sender = new SupabaseBackend(asClient(client));
    const message = {
      id: "m2", channelId: "c1", authorId: ME, content: "", createdAt: 0, reactions: [],
      attachments: [{ id: "a2", name: "x.md", size: 1, type: "text/markdown",
        dataUrl: "message-files/a2", uploadedBy: ME, uploadedAt: 0 }],
    };
    await expect(sender.sendMessage(message as never)).rejects.toThrow(/42501/);
    expect(client.issued.filter((table) => table === "messages")).toHaveLength(2);
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

  it("updateProject LINKS the files a patch adds, after the scalar update", async () => {
    // Until Task 10 this rejected. The ORDER is the assertion: the scalar
    // UPDATE first, the attachment sync last, so the link is never evaluated
    // against a half-written project row.
    const client = fakeClient({ rows: { projects: [{ id: "p1" }] } });
    const editor = new SupabaseBackend(asClient(client));
    await editor.updateProject("p1", {
      name: "Renamed",
      attachments: [{ id: "a1", name: "spec.md", dataUrl: "project-files/a1" } as never],
    });
    expect(client.issued.indexOf("projects")).toBeLessThan(
      client.issued.indexOf("project_attachments")
    );
    expect(
      client.payloads.find((entry) => entry.table === "project_attachments")?.value
    ).toEqual([{ project_id: "p1", attachment_id: "a1" }]);
  });

  it("updateProject deletes the BYTES BEFORE the row for a file that was removed", async () => {
    // A correctness rule, not tidiness: both delete predicates are answered
    // from the `attachments` row, so removing the row first would strand the
    // object in the bucket with nobody able to reach it ever again.
    const client = fakeClient({
      rows: {
        projects: [{ id: "p1" }],
        project_attachments: [{ attachment_id: "a_old" }],
        attachments: [{ id: "a_old", name: "old.md", storage_path: "project-files/a_old" }],
      },
    });
    const editor = new SupabaseBackend(asClient(client));
    await editor.updateProject("p1", { attachments: [] });
    expect(client.storageOps).toEqual([
      { bucket: "project-files", op: "remove", path: "a_old" },
    ]);
    expect(client.issued.indexOf("storage.project-files")).toBeLessThan(
      client.issued.lastIndexOf("attachments")
    );
  });

  it("updateProject reports a refused byte-delete instead of reading the empty array as success", async () => {
    // storage-api answers a delete its policy filtered away with `error: null`
    // and an EMPTY array - the same false-success shape `requireRows` exists
    // for. Verified live against lumina-dev: a member without `project.delete`
    // who is not the uploader gets exactly that.
    const client = fakeClient({
      rows: {
        projects: [{ id: "p1" }],
        project_attachments: [{ attachment_id: "a_old" }],
        attachments: [{ id: "a_old", name: "old.md", storage_path: "project-files/a_old" }],
      },
      errors: { "storage.project-files.empty": { message: "filtered" } },
    });
    const editor = new SupabaseBackend(asClient(client));
    await expect(editor.updateProject("p1", { attachments: [] })).rejects.toThrow(
      /only the person who uploaded it/i
    );
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

// ---------------------------------------------------------------------------
// Task 7 — the four task writes. What is asserted here is what the backend
// SENDS, because for two of these columns the behaviour under test is an
// absence: `tasks.position` must not be on an insert (the trigger appends), and
// `assignee_id` must not be in an UPDATE that does not change the owner (the
// trigger would re-validate a person who was already there). A test that only
// checked the resolved value would pass with both columns present.
// ---------------------------------------------------------------------------
describe("SupabaseBackend — createTask", () => {
  const task = {
    id: "t_new", projectId: "p1", title: "Ship it", description: "",
    status: "todo", priority: "medium", assigneeId: null, dueDate: null,
    startTime: null, durationMinutes: null, reminderMinutes: null, labels: [],
    attachments: [], order: 3, createdAt: 1_700_000_000_000, createdBy: ME,
    collaboratorIds: [],
  };

  it("sends NO position, and adopts the one the trigger chose", async () => {
    const client = fakeClient({ rows: { tasks: [{ id: "t_new", position: 9 }] } });
    const backend = new SupabaseBackend(asClient(client));

    // 9, not the 3 the store guessed from its own column length.
    await expect(backend.createTask(task as never)).resolves.toMatchObject({ order: 9 });

    const insert = client.payloads.find((p) => p.table === "tasks" && p.op === "insert");
    expect(insert).toBeDefined();
    expect(Object.keys(insert!.value as object)).not.toContain("position");
  });

  it("writes the task before its collaborators", async () => {
    // `check_task_collaborator` reads the task's own row to find the owner, and
    // the foreign key needs it to exist. The reverse order fails every time.
    const client = fakeClient({ rows: { tasks: [{ id: "t_new", position: 0 }] } });
    const backend = new SupabaseBackend(asClient(client));

    await backend.createTask({ ...task, collaboratorIds: ["u_a", "u_b"] } as never);

    expect(client.issued).toEqual(["tasks", "task_collaborators"]);
    expect(client.payloads.at(-1)!.value).toEqual([
      { task_id: "t_new", user_id: "u_a" },
      { task_id: "t_new", user_id: "u_b" },
    ]);
  });

  it("sweeps the task row when the collaborator insert is refused", async () => {
    // Otherwise the board keeps a task the dialog said had two people on it and
    // the database has none — a create that half worked.
    const client = fakeClient({
      rows: { tasks: [{ id: "t_new", position: 0 }] },
      errors: { task_collaborators: { message: "cannot see this project", code: "P0001" } },
    });
    const backend = new SupabaseBackend(asClient(client));

    await expect(
      backend.createTask({ ...task, collaboratorIds: ["u_blocked"] } as never)
    ).rejects.toThrow(/P0001/);
    expect(client.issued).toEqual(["tasks", "task_collaborators", "tasks"]);
  });

  it("rejects when the insert came back empty — the filtered-away shape", async () => {
    const backend = new SupabaseBackend(asClient(fakeClient()));
    await expect(backend.createTask(task as never)).rejects.toThrow(/permission/i);
  });

  it("links a new task's files, and sweeps the task back out if that is refused", async () => {
    const ok = fakeClient({ rows: { tasks: [{ id: "t1", position: 3 }] } });
    await new SupabaseBackend(asClient(ok)).createTask({
      ...task,
      attachments: [{ id: "a1", name: "brief.md", dataUrl: "task-files/a1" }],
    } as never);
    expect(ok.payloads.find((entry) => entry.table === "task_attachments")?.value).toEqual([
      { task_id: "t_new", attachment_id: "a1" },
    ]);

    // `task_attachments_insert` requires `task.edit` while the store guards
    // `task.create` - a real mismatch, recorded in task-10-report.md. It fails
    // LOUDLY, which is the point: the card comes back off the board rather
    // than sitting there without the files the dialog showed.
    const refused = fakeClient({
      rows: { tasks: [{ id: "t1", position: 3 }] },
      errors: {
        task_attachments: {
          message: "new row violates row-level security policy",
          code: "42501",
        },
      },
    });
    await expect(
      new SupabaseBackend(asClient(refused)).createTask({
        ...task,
        attachments: [{ id: "a1", name: "brief.md", dataUrl: "task-files/a1" }],
      } as never)
    ).rejects.toThrow(/42501/);
    expect(refused.issued.filter((table) => table === "tasks")).toHaveLength(2);
  });
});

describe("SupabaseBackend — updateTask keeps 'only what is newly assigned'", () => {
  const withOwner = (assignee: string | null, collaborators: string[] = []) =>
    fakeClient({
      rows: {
        tasks: [{ id: "t1", assignee_id: assignee }],
        task_collaborators: collaborators.map((user_id) => ({ user_id })),
      },
    });
  const sent = (client: ReturnType<typeof fakeClient>, table: string, op: string) =>
    client.payloads.filter((p) => p.table === table && p.op === op).map((p) => p.value);

  it("OMITS assignee_id when the patch does not change the owner", async () => {
    // The rule the whole file turns on. `tasks_check_assignee` fires on
    // `update of assignee_id` — the SET list, not a changed value — and refuses
    // an owner who cannot see the project. The task dialog sends `assigneeId`
    // on every save, so including it unchanged would make a task whose owner
    // has since lost access uneditable by everybody.
    const client = withOwner("u_stale");
    const backend = new SupabaseBackend(asClient(client));

    await expect(
      backend.updateTask("t1", { title: "Renamed", assigneeId: "u_stale" })
    ).resolves.toBeUndefined();

    expect(sent(client, "tasks", "update")).toEqual([{ title: "Renamed" }]);
  });

  it("INCLUDES assignee_id when the patch really reassigns — the positive control", async () => {
    // Without this, an updateTask that never wrote the owner at all would pass
    // the test above.
    const client = withOwner("u_stale");
    const backend = new SupabaseBackend(asClient(client));

    await backend.updateTask("t1", { assigneeId: "u_new" });

    expect(sent(client, "tasks", "update")).toEqual([{ assignee_id: "u_new" }]);
  });

  it("inserts only the collaborators that are NEW, leaving a stale one untouched", async () => {
    // Same rule, other slot: `check_task_collaborator` refuses an insert naming
    // somebody who cannot see the project, so re-inserting a collaborator who
    // was already there would fail an edit that has nothing to do with them.
    const client = withOwner(null, ["u_stale", "u_going"]);
    const backend = new SupabaseBackend(asClient(client));

    await backend.updateTask("t1", { collaboratorIds: ["u_stale", "u_fresh"] });

    expect(sent(client, "task_collaborators", "insert")).toEqual([
      [{ task_id: "t1", user_id: "u_fresh" }],
    ]);
  });

  it("reads the collaborator rows AFTER the task update, never before", async () => {
    // `drop_collaborator_on_assign` deletes the new owner's collaborator row
    // when `assignee_id` changes. Diffing against a list read beforehand would
    // count that row as one this function failed to delete.
    const client = withOwner("u_old", ["u_new"]);
    const backend = new SupabaseBackend(asClient(client));

    await backend.updateTask("t1", { assigneeId: "u_new", collaboratorIds: [] });

    expect(client.issued).toEqual(["tasks", "tasks", "task_collaborators", "task_collaborators"]);
  });

  it("writes nothing at all for a patch naming no persistable column", async () => {
    const client = withOwner("u_stale");
    const backend = new SupabaseBackend(asClient(client));

    await expect(backend.updateTask("t1", { assigneeId: "u_stale" })).resolves.toBeUndefined();
    expect(sent(client, "tasks", "update")).toEqual([]);
  });

  it("rejects a task it cannot even read", async () => {
    const backend = new SupabaseBackend(asClient(fakeClient()));
    await expect(backend.updateTask("t1", { title: "x" })).rejects.toThrow(/permission/i);
  });

  it("refuses to write `order` — that is what moving a task is for", async () => {
    const backend = new SupabaseBackend(asClient(withOwner(null)));
    await expect(backend.updateTask("t1", { order: 2 })).rejects.toThrow(/moving it/i);
  });

  it("syncs a patch's files last, against task.edit - which is what the store guards", async () => {
    const client = withOwner(null);
    const backend = new SupabaseBackend(asClient(client));
    await backend.updateTask("t1", {
      attachments: [{ id: "a1", name: "brief.md", dataUrl: "task-files/a1" } as never],
    });
    expect(client.payloads.find((entry) => entry.table === "task_attachments")?.value).toEqual([
      { task_id: "t1", attachment_id: "a1" },
    ]);
    expect(client.issued.lastIndexOf("task_attachments")).toBeGreaterThan(
      client.issued.indexOf("tasks")
    );
  });
});

describe("SupabaseBackend — moveTask", () => {
  it("goes through the RPC and clamps an out-of-range index to int4", async () => {
    // board.tsx drops at the end of a column with Number.MAX_SAFE_INTEGER,
    // which `move_task(p_index integer)` cannot hold — unclamped this is a
    // 22003 on every "move to done" button, not an append.
    const client = fakeClient({ rpcData: { has_permission: true } });
    const backend = new SupabaseBackend(asClient(client));

    await expect(
      backend.moveTask("t1", "done", Number.MAX_SAFE_INTEGER)
    ).resolves.toBeUndefined();

    expect(client.issued).toContain("rpc.move_task");
    expect(client.rpcArgs["move_task"]).toEqual({
      p_task_id: "t1", p_status: "done", p_index: 2147483647,
    });
  });

  it("rejects a role that can move but not edit, instead of silently doing nothing", async () => {
    // `move_task` is security invoker, so its UPDATEs run under `tasks_update`,
    // which demands task.edit. Without that permission every statement inside
    // is filtered to zero rows and the RPC returns void, cleanly, having moved
    // nothing.
    const client = fakeClient({ rpcData: { has_permission: false } });
    const backend = new SupabaseBackend(asClient(client));

    await expect(backend.moveTask("t1", "done", 0)).rejects.toThrow(/can't edit tasks/);
  });

  it("surfaces the RPC's own error for a task it cannot see", async () => {
    const client = fakeClient({
      rpcData: { has_permission: true },
      errors: { "rpc.move_task": { message: "Task t1 not found or not visible", code: "P0001" } },
    });
    const backend = new SupabaseBackend(asClient(client));

    await expect(backend.moveTask("t1", "done", 0)).rejects.toThrow(/not found or not visible/);
  });
});

describe("SupabaseBackend — deleteTask", () => {
  it("rejects when no row came back", async () => {
    // The boolean this becomes is what stops task-dialog.tsx toasting "Task
    // deleted" and closing over a task that is still on the board.
    const backend = new SupabaseBackend(asClient(fakeClient()));
    await expect(backend.deleteTask("t_theirs")).rejects.toThrow(/permission/i);
  });

  it("resolves when the row really went — the positive control", async () => {
    const backend = new SupabaseBackend(asClient(fakeClient({ rows: { tasks: [{ id: "t1" }] } })));
    await expect(backend.deleteTask("t1")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 8 — the five writes that decide what everybody else may do. As with
// Task 7 above, what is asserted here is what the backend SENDS: the
// interesting behaviours are a column that must be forced (`is_system`), a
// statement count that must be exactly one (`updateRole`), and an array that
// must be computed from the stored row rather than the client's copy.
//
// The server-side half — the triggers, and the policies these run under —
// is in tests/rls/role-writes.test.ts, against the real database.
// ---------------------------------------------------------------------------
describe("SupabaseBackend — setUserRole", () => {
  const withPermission = (allowed: boolean, found = true) =>
    fakeClient({
      rpcData: { has_permission: allowed },
      rows: found ? { profiles: [{ id: "u_them" }] } : {},
    });

  it("asks for members.manage explicitly, because profiles_update_self does not", async () => {
    // `profiles` has TWO permissive UPDATE policies and Postgres OR-s them, so
    // `id = auth.uid()` alone reaches this UPDATE. A caller with no permissions
    // setting their OWN role to the one they already have changes nothing and
    // would otherwise resolve — `setUserRole` resolving means "the role was
    // set", and for someone who may not set roles it must not resolve at all.
    const backend = new SupabaseBackend(asClient(withPermission(false)));
    await expect(backend.setUserRole("u_them", "admin")).rejects.toThrow(
      /can't manage members/
    );
  });

  it("resolves for a caller who does hold it — the positive control", async () => {
    const client = withPermission(true);
    const backend = new SupabaseBackend(asClient(client));

    await expect(backend.setUserRole("u_them", "guest")).resolves.toBeUndefined();

    expect(client.payloads.filter((p) => p.table === "profiles")).toEqual([
      { table: "profiles", op: "update", value: { role_id: "guest" } },
    ]);
    // Concurrently, not in sequence: both were issued before either resolved.
    expect(client.issued).toContain("rpc.has_permission");
  });

  it("rejects when no row came back — the filtered-away shape", async () => {
    const backend = new SupabaseBackend(asClient(withPermission(true, false)));
    await expect(backend.setUserRole("u_them", "guest")).rejects.toThrow(/permission/i);
  });
});

describe("SupabaseBackend — createRole", () => {
  const stored = {
    id: "r_new", name: "Auditor", description: "Reads everything", color: "#111",
    permissions: ["message.send"], is_system: false, locked: false,
  };

  it("forces is_system and locked to false, whatever it was handed", async () => {
    // `Backend.createRole` takes a whole `RoleDef` and both fields are
    // optional on it. A role created with `is_system: true` would be
    // permanently undeletable — `block_role_delete_with_members` refuses
    // built-ins outright — with no way back short of the secret key.
    const client = fakeClient({ rows: { roles: [stored] } });
    const backend = new SupabaseBackend(asClient(client));

    await backend.createRole({
      id: "r_new", name: "Auditor", description: "", color: "#111",
      permissions: ["message.send"], isSystem: true, locked: true,
    });

    expect(client.payloads.at(-1)!.value).toMatchObject({ is_system: false, locked: false });
  });

  it("adopts the stored row rather than the one the store drew", async () => {
    const client = fakeClient({ rows: { roles: [{ ...stored, name: "Auditor (stored)" }] } });
    const backend = new SupabaseBackend(asClient(client));

    await expect(
      backend.createRole({
        id: "r_new", name: "Auditor", description: "", color: "#111", permissions: [],
      })
    ).resolves.toMatchObject({ name: "Auditor (stored)", permissions: ["message.send"] });
  });

  it("rejects when the insert came back empty", async () => {
    const backend = new SupabaseBackend(asClient(fakeClient()));
    await expect(
      backend.createRole({ id: "r", name: "N", description: "", color: "#1", permissions: [] })
    ).rejects.toThrow(/permission/i);
  });
});

describe("SupabaseBackend — updateRole", () => {
  const role = (over: Record<string, unknown> = {}) =>
    fakeClient({
      rows: {
        roles: [{
          id: "r1", name: "Auditor", permissions: ["message.send"],
          is_system: false, locked: false, ...over,
        }],
      },
    });
  const updates = (client: ReturnType<typeof fakeClient>) =>
    client.payloads.filter((p) => p.table === "roles" && p.op === "update").map((p) => p.value);

  it("sends the whole patch as ONE update, permissions included", async () => {
    // The row being updated can be the CALLER'S OWN role, and `roles_write`'s
    // USING is `has_permission('members.manage')`. Split into two statements,
    // a permissions write that revoked members.manage would leave the second
    // statement filtered to zero rows: half-applied, and reported as a
    // permission error rather than as the lockout it actually is.
    const client = role();
    const backend = new SupabaseBackend(asClient(client));

    await backend.updateRole("r1", {
      name: "Reviewer", description: "Reads", color: "#222", permissions: ["task.edit"],
    });

    expect(updates(client)).toEqual([
      { name: "Reviewer", description: "Reads", color: "#222", permissions: ["task.edit"] },
    ]);
  });

  it("refuses a locked role, which the database does not", async () => {
    // `roles_write` has no opinion on `locked` and no trigger covers UPDATE.
    // Revoking members.manage from Admin is a one-way lockout.
    const backend = new SupabaseBackend(asClient(role({ locked: true, name: "Admin" })));
    await expect(backend.updateRole("r1", { name: "Seized" })).rejects.toThrow(/locked/i);
  });

  it("refuses a role that is no longer there", async () => {
    // `roles_read` is `using (true)`, so RLS cannot be hiding it — absent
    // really does mean deleted, and an UPDATE matching nothing says less.
    const backend = new SupabaseBackend(asClient(fakeClient()));
    await expect(backend.updateRole("r_gone", { name: "x" })).rejects.toThrow(/no longer exists/);
  });

  it("writes nothing at all for an empty patch", async () => {
    const client = role();
    const backend = new SupabaseBackend(asClient(client));
    await expect(backend.updateRole("r1", {})).resolves.toBeUndefined();
    expect(updates(client)).toEqual([]);
  });
});

describe("SupabaseBackend — setRolePermission", () => {
  const role = (permissions: string[], over: Record<string, unknown> = {}) =>
    fakeClient({
      rows: {
        roles: [{ id: "r1", name: "Auditor", permissions, is_system: false, locked: false, ...over }],
      },
    });
  const written = (client: ReturnType<typeof fakeClient>) =>
    (client.payloads.find((p) => p.table === "roles" && p.op === "update")!
      .value as { permissions: string[] }).permissions;

  it("computes the new array from the STORED row, not the client's copy", async () => {
    // The store's optimistic array can be a hydrate behind; writing it back
    // would silently reinstate whatever somebody else has changed since.
    const client = role(["message.send", "task.create"]);
    const backend = new SupabaseBackend(asClient(client));

    await backend.setRolePermission("r1", "task.edit", true);

    expect(written(client)).toEqual(["message.send", "task.create", "task.edit"]);
  });

  it("removes the permission when disabling — the other direction", async () => {
    const client = role(["message.send", "task.edit"]);
    const backend = new SupabaseBackend(asClient(client));

    await backend.setRolePermission("r1", "task.edit", false);

    expect(written(client)).toEqual(["message.send"]);
  });

  it("is idempotent: enabling one that is already there does not duplicate it", async () => {
    // `enabled` names the state wanted, not a flip, so re-sending after a
    // concurrent identical change is a no-op rather than an inversion.
    const client = role(["task.edit"]);
    const backend = new SupabaseBackend(asClient(client));

    await backend.setRolePermission("r1", "task.edit", true);

    expect(written(client)).toEqual(["task.edit"]);
  });

  it("refuses a locked role", async () => {
    const backend = new SupabaseBackend(asClient(role([], { locked: true, name: "Admin" })));
    await expect(backend.setRolePermission("r1", "task.edit", false)).rejects.toThrow(/locked/i);
  });
});

describe("SupabaseBackend — deleteRole", () => {
  const role = (over: Record<string, unknown> = {}, emptyAfterFirst?: string[]) =>
    fakeClient({
      rows: {
        roles: [{ id: "r1", name: "Auditor", permissions: [], is_system: false, locked: false, ...over }],
      },
      emptyAfterFirst,
    });

  it("deletes a custom role — the positive control", async () => {
    await expect(new SupabaseBackend(asClient(role())).deleteRole("r1")).resolves.toBeUndefined();
  });

  it("refuses a built-in role", async () => {
    // `block_role_delete_with_members` says so too; this is the instant answer,
    // in the store's own words.
    const backend = new SupabaseBackend(asClient(role({ is_system: true, name: "Member" })));
    await expect(backend.deleteRole("r1")).rejects.toThrow(/built-in/i);
  });

  it("refuses a locked role", async () => {
    const backend = new SupabaseBackend(asClient(role({ locked: true, name: "Admin" })));
    await expect(backend.deleteRole("r1")).rejects.toThrow(/locked/i);
  });

  it("rejects when the DELETE came back empty — the filtered-away shape", async () => {
    // The pre-read finds the role (`roles_read` is `using (true)`, so everyone
    // can see every role); the DELETE then matches nothing, which is exactly
    // what `roles_write` filtering away a caller without members.manage looks
    // like from here. The boolean this becomes is what stops
    // app/people/page.tsx reporting a role gone that is still there.
    const client = role({}, ["roles"]);
    const backend = new SupabaseBackend(asClient(client));
    await expect(backend.deleteRole("r1")).rejects.toThrow(/permission/i);
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
