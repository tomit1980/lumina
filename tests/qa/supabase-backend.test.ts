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

describe("SupabaseBackend — the operations Tasks 5-8 still owe", () => {
  // Typed as `Backend`, not as the class: lib/backend/types.ts is where the
  // contract's parameters are named, and the implementations deliberately
  // declare none (same style as LocalBackend).
  const backend: Backend = new SupabaseBackend(asClient(fakeClient()));

  const writes: Array<[string, () => Promise<unknown>]> = [
    ["setUserRole", () => backend.setUserRole("u", "r")],
    ["createRole", () => backend.createRole({} as never)],
    ["updateRole", () => backend.updateRole("r", {})],
    ["setRolePermission", () => backend.setRolePermission("r", "task.edit", true)],
    ["deleteRole", () => backend.deleteRole("r")],
    ["sendMessage", () => backend.sendMessage({} as never)],
    ["sendToUser", () => backend.sendToUser({} as never, true, {} as never)],
    ["editMessage", () => backend.editMessage("m", "hi", 0)],
    ["deleteMessage", () => backend.deleteMessage("m")],
    ["toggleReaction", () => backend.toggleReaction("m", "👍")],
    ["markChannelRead", () => backend.markChannelRead("c", 0)],
    ["openDm", () => backend.openDm({} as never)],
    ["createChannel", () => backend.createChannel({} as never)],
    ["deleteChannel", () => backend.deleteChannel("c")],
    ["setChannelAccess", () => backend.setChannelAccess("c", {} as never)],
    ["createProject", () => backend.createProject({} as never)],
    ["updateProject", () => backend.updateProject("p", {})],
    ["deleteProject", () => backend.deleteProject("p")],
    ["setProjectAccess", () => backend.setProjectAccess("p", {} as never)],
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

  it.each(writes)("%s rejects asynchronously, never throwing synchronously", async (name, call) => {
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
