# Live Updates and Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lumina update itself when the server changes — messages, boards, membership and the activity feed — and replace the fake presence dots with real ones.

**Architecture:** A subscription on the `Backend` interface yields change events. A brand-new message applies directly (it is the one self-contained row, and the one where latency is felt); every other event marks the workspace stale and schedules a single coalesced `hydrate()`. Live applies bump the store's existing write counter so a failing write reloads instead of rewinding past them. Presence is a Realtime Presence channel, not a table.

**Tech Stack:** Next.js 15 static export, React 19, Supabase (`@supabase/supabase-js` Realtime), Vitest + Testing Library, Postgres row-level security.

**Spec:** `docs/superpowers/specs/2026-09-09-lumina-realtime-design.md` (parent: `docs/superpowers/specs/2026-09-06-lumina-production-design.md`)

## Global Constraints

- Branch `feat/realtime` from `main`. Never `npm run build` while a preview server is running.
- Dev project is `nsioivydefazicxnozqw`. **Never `db push` to prod (`eshstdmgceohizbevwll`)** — verify the target before every push.
- Every task ends green on `npm run typecheck && npm run lint && npm test && npm run test:rls`, then `npm run probes`. **Both of the first two: `npm test` does not typecheck.**
- Baselines entering this plan: **598 unit, 233 RLS, 10 probes.** None may break.
- **Every negative assertion needs a positive control.** A subscriber receiving nothing passes a naive negative test just as happily when the subscription is broken.
- **Verify each new test fails without the change** and say so in the task report. For live updates the cheap mutation is dropping the event on the floor.
- **No `setTimeout` sleeps to wait for an event.** Use `waitFor`, or polling with a deadline.
- `LocalBackend` must keep behaving exactly as today — the public site still builds with it (`NEXT_PUBLIC_BACKEND` defaults to `local`).
- On a transient `fetch failed` in a probe: pause, re-run, then `node tests/probes/sweep.mjs`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260909001100_realtime.sql` | Publish tables for change events; set replica identity |
| `tests/probes/realtime_probe.mjs` | Prove an outsider receives nothing they could not query |
| `lib/backend/types.ts` | `RealtimeEvent`, `Unsubscribe`, `Backend.subscribe` |
| `lib/backend/local.ts` | Inert subscription (returns a no-op teardown) |
| `lib/backend/supabase/realtime.ts` | **New.** Channel setup, event normalisation, teardown |
| `lib/backend/supabase/index.ts` | Wire `subscribe` to `realtime.ts` |
| `lib/store.tsx` | The apply core: direct message append, coalesced reload, `writeSeq` bump, in-flight deferral |
| `lib/presence.ts` | **New.** The single presence dot/label mapping |
| `components/user-avatar.tsx`, `user-card.tsx`, `chat/dm-view.tsx` | Consume `lib/presence.ts` instead of three local copies |
| `components/connection-status.tsx` | **New.** The quiet "reconnecting" indicator |
| `tests/qa/_support.ts` | `EventBackend` double that emits events on command |

---

## Task 1: Publish tables and prove the boundary holds

**This task gates the plan.** If events leak, stop and report — nothing is built on a broken boundary.

**Files:**
- Create: `supabase/migrations/20260909001100_realtime.sql`
- Create: `tests/probes/realtime_probe.mjs`
- Modify: `package.json` (add the probe to the `probes` script)

**Interfaces:**
- Consumes: nothing.
- Produces: published tables `messages`, `reactions`, `tasks`, `projects`, `channels`, `activities`, `project_members`, `channel_members`, `task_collaborators`, `read_state`, `dms`, `dm_members`.

- [ ] **Step 1: Write the migration**

Realtime delivers nothing until a table joins the publication. `replica identity full` is what makes a DELETE payload carry the row rather than only its primary key — needed because a deleted task must be found in `AppState` by id.

```sql
-- Live updates: a table delivers change events only once it is in this
-- publication. Row-level security still applies to every subscriber; Task 1's
-- probe proves that rather than assuming it.
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.reactions;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.channels;
alter publication supabase_realtime add table public.activities;
alter publication supabase_realtime add table public.project_members;
alter publication supabase_realtime add table public.channel_members;
alter publication supabase_realtime add table public.task_collaborators;
alter publication supabase_realtime add table public.read_state;
alter publication supabase_realtime add table public.dms;
alter publication supabase_realtime add table public.dm_members;

-- Without this a DELETE arrives carrying only the primary key, and a row
-- removed from a join table cannot be matched to what the client holds.
alter table public.messages replica identity full;
alter table public.reactions replica identity full;
alter table public.tasks replica identity full;
alter table public.projects replica identity full;
alter table public.channels replica identity full;
alter table public.project_members replica identity full;
alter table public.channel_members replica identity full;
alter table public.task_collaborators replica identity full;
alter table public.read_state replica identity full;
alter table public.dm_members replica identity full;
```

- [ ] **Step 2: Apply to dev and confirm the target**

```bash
grep SUPABASE_URL .env.test.local   # must contain nsioivydefazicxnozqw
npm run db:push
```
Expected: applied to lumina-dev. If the URL shows `eshstdmgceohizbevwll`, stop.

- [ ] **Step 3: Write the probe**

Model it on `tests/probes/storage_probe.mjs`. Read `tests/probes/README.md` first — a probe must count its checks and fail if zero ran.

Structure, with the assertions spelled out:

```js
// Outsider subscribes; owner then writes four things the outsider must not
// receive, and one they must. Waits on a deadline, never a fixed sleep.
const received = [];
const channel = outsider
  .channel("probe")
  .on("postgres_changes", { event: "*", schema: "public" }, (p) => received.push(p));
await new Promise((res, rej) => {
  channel.subscribe((status) => (status === "SUBSCRIBED" ? res() : null));
  setTimeout(() => rej(new Error("never subscribed")), 10_000);
});

// ... owner inserts: a message in a private channel the outsider is not in;
// a message in the owner's DM with a third person; a task in a restricted
// project; an activity scoped to that project. Then ONE the outsider may
// see: a message in the open `general` channel.

await settle(); // poll `received` until the positive control arrives, deadline 10s

check("outsider receives the message they ARE entitled to (positive control)",
  received.some((p) => p.new?.id === openMessageId));
check("outsider receives NO message from a private channel",
  !received.some((p) => p.new?.id === privateMessageId));
check("outsider receives NO message from another pair's DM",
  !received.some((p) => p.new?.id === dmMessageId));
check("outsider receives NO task from a restricted project",
  !received.some((p) => p.new?.id === restrictedTaskId));
check("outsider receives NO activity scoped to a project they cannot see",
  !received.some((p) => p.new?.id === restrictedActivityId));
```

The positive control is not optional: without it, a subscription that silently failed to connect passes all four negatives.

- [ ] **Step 4: Run the probe**

```bash
node tests/probes/realtime_probe.mjs
```
Expected: all checks PASS, non-zero check count, cleanup leaves 0 users.
**If any negative fails, STOP and report — do not continue the plan.**

- [ ] **Step 5: Add it to the probe script and commit**

```bash
git add supabase/migrations/20260909001100_realtime.sql tests/probes/realtime_probe.mjs package.json
git commit -m "feat(db): publish tables for live updates, and prove the boundary holds"
```

---

## Task 2: The subscription seam and the apply core

**Files:**
- Modify: `lib/backend/types.ts`, `lib/backend/local.ts`, `lib/backend/supabase/index.ts`
- Create: `lib/backend/supabase/realtime.ts`
- Modify: `lib/store.tsx`
- Modify: `tests/qa/_support.ts`
- Test: `tests/qa/realtime-apply.test.ts`

**Interfaces:**
- Consumes: the published tables from Task 1.
- Produces:
  ```ts
  export type RealtimeEvent =
    | { kind: "message-insert"; message: Message }
    | { kind: "stale" };
  export type Unsubscribe = () => void;
  // on Backend:
  subscribe(onEvent: (event: RealtimeEvent) => void): Unsubscribe;
  ```
  `LocalBackend.subscribe` returns `() => {}` and never emits. `EventBackend` (test double) exposes `emit(event: RealtimeEvent): void`.

- [ ] **Step 1: Write the failing tests**

`tests/qa/realtime-apply.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { EventBackend, FailingBackend, adminState, mount, run } from "./_support";

afterEach(() => { cleanup(); localStorage.clear(); });

describe("live updates reach the screen", () => {
  it("appends a message that arrives from the server", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const before = result.current.state.messages.length;

    backend.emit({ kind: "message-insert", message: {
      id: "m_from_server", channelId: "c_general", authorId: "u_maya",
      content: "sent from another browser", createdAt: Date.now(),
      reactions: [], attachments: [],
    }});

    await waitFor(() =>
      expect(result.current.state.messages).toHaveLength(before + 1));
    expect(result.current.state.messages.at(-1)!.content)
      .toBe("sent from another browser");
  });

  it("does not duplicate the echo of a message this client already holds", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const sent = await run(() =>
      result.current.sendMessage("c_general", "mine"));
    expect(sent).toBe(true);
    const mine = result.current.state.messages.at(-1)!;
    const count = result.current.state.messages.length;

    backend.emit({ kind: "message-insert", message: mine });

    // Give the apply path a chance to be wrong before asserting it is not.
    await waitFor(() => expect(backend.emitted).toBe(1));
    expect(result.current.state.messages).toHaveLength(count);
  });

  it("coalesces a burst of stale events into exactly one reload", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);
    const before = backend.hydrateCalls;

    for (let i = 0; i < 5; i++) backend.emit({ kind: "stale" });

    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));
    // And it stays one: no trailing reload per event.
    await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));
  });

  it("a failed write after a live update reloads instead of rewinding past it", async () => {
    // The second-writer hazard, and the most important test in this plan.
    const backend = new FailingBackend("updateProject");
    const { result } = await mount(adminState(), backend);
    const project = result.current.state.projects[0];

    const pending = run(() =>
      result.current.updateProject(project.id, { name: "renamed" }));
    backend.emit({ kind: "message-insert", message: {
      id: "m_during", channelId: "c_general", authorId: "u_maya",
      content: "arrived mid-write", createdAt: Date.now(),
      reactions: [], attachments: [],
    }});
    await pending;

    // The write was refused and undone, but the live message must survive:
    // rewinding to the pre-write snapshot would erase it silently.
    expect(result.current.state.projects.find((p) => p.id === project.id)!.name)
      .toBe(project.name);
    await waitFor(() =>
      expect(result.current.state.messages.some((m) => m.id === "m_during"))
        .toBe(true));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npx vitest run tests/qa/realtime-apply.test.ts
```
Expected: FAIL — `EventBackend` is not exported from `./_support`.

- [ ] **Step 3: Add the seam to the interface and both implementations**

In `lib/backend/types.ts`, after `reset()`:

```ts
/** A change the server pushed. `message-insert` is the one event applied
 *  directly — a brand-new message has no reactions or attachments yet, so
 *  its row is self-contained, and it is the case where latency is felt.
 *  Everything else is `stale`: the row-to-model functions build from
 *  lookups grouped per load, so a lone row cannot rebuild a task, project
 *  or DM (see the spec's "Why not per-row patching"). */
export type RealtimeEvent =
  | { kind: "message-insert"; message: Message }
  | { kind: "stale" };

export type Unsubscribe = () => void;
```
and on `Backend`:
```ts
  /** Live changes from the server. Returns a teardown. `LocalBackend`
   *  returns an inert one: the demo has no server to hear from. */
  subscribe(onEvent: (event: RealtimeEvent) => void): Unsubscribe;
```

In `lib/backend/local.ts`:
```ts
  subscribe(): Unsubscribe {
    // The demo workspace is the only writer of itself. Nothing to hear.
    return () => {};
  }
```

- [ ] **Step 4: Add `EventBackend` to the test double**

In `tests/qa/_support.ts`, beside `FailingBackend`. Also add `subscribe` support to `FailingBackend` so the fourth test can emit through it — it extends `LocalBackend`, so give the base class a settable listener:

```ts
/** A LocalBackend that can also push events, for the apply path. */
export class EventBackend extends LocalBackend {
  private listener: ((event: RealtimeEvent) => void) | null = null;
  /** How many events this double has pushed — lets a test wait on the
   *  apply path having had its chance, rather than sleeping. */
  emitted = 0;
  hydrateCalls = 0;

  override subscribe(onEvent: (event: RealtimeEvent) => void): Unsubscribe {
    this.listener = onEvent;
    return () => { this.listener = null; };
  }

  override hydrate(): Promise<AppState> {
    this.hydrateCalls += 1;
    return super.hydrate();
  }

  emit(event: RealtimeEvent): void {
    this.emitted += 1;
    this.listener?.(event);
  }
}
```
Give `FailingBackend` the same `subscribe`/`emit` pair (or have it extend `EventBackend`) so the second-writer test can drive both.

- [ ] **Step 5: Implement the apply core in `lib/store.tsx`**

Add beside the hydrate effect. The three rules from the spec are all here:

```tsx
  /** Coalesces `stale` events: a burst costs one reload, not one each. */
  const staleTimer = React.useRef<number | null>(null);
  /** Set while a write is in flight, so a live apply waits rather than
   *  interleaving with an optimistic patch. */
  const writeInFlight = React.useRef(0);

  React.useEffect(() => {
    const unsubscribe = backend.subscribe((event) => {
      // The client library holds an internal lock across this callback;
      // calling back into it from inside can deadlock. lib/auth.tsx defers
      // onAuthStateChange for exactly this reason.
      setTimeout(() => applyEvent(event), 0);
    });
    return unsubscribe;
  }, [backend, applyEvent]);
```
`applyEvent` (a `useCallback`):
- `message-insert`: if `stateRef.current.messages` already has that id, return. Otherwise `update(s => ({...s, messages: [...s.messages, message]}))` **and `writeSeq.current += 1`** so a failing write sees it landed.
- `stale`: if `writeInFlight.current > 0`, re-arm the timer instead of reloading. Otherwise debounce 250 ms, then `backend.hydrate().then(adopt)`, bumping `writeSeq` on adopt.

In `commit(...)`, increment `writeInFlight.current` before `op()` and decrement in both branches.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run tests/qa/realtime-apply.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 7: Confirm they fail without the implementation**

Comment out the body of `applyEvent` so events are dropped, re-run, confirm 3 of 4 fail (the echo test is the negative and will still pass — that is why the other three exist), then restore.

- [ ] **Step 8: Full gates and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run test:rls
git add lib/backend tests/qa/_support.ts tests/qa/realtime-apply.test.ts lib/store.tsx
git commit -m "feat(realtime): subscription seam and the apply core"
```

---

## Task 3: The Supabase channel

**Files:**
- Create: `lib/backend/supabase/realtime.ts`
- Modify: `lib/backend/supabase/index.ts`
- Test: `tests/qa/supabase-realtime.test.ts`

**Interfaces:**
- Consumes: `RealtimeEvent`, `Unsubscribe` from Task 2.
- Produces: `subscribeToWorkspace(client: SupabaseClient<Database>, onEvent: (e: RealtimeEvent) => void): Unsubscribe`.

- [ ] **Step 1: Write the failing test**

Drive it with a fake client — no network:

```ts
it("turns a messages INSERT into a message-insert event", () => {
  const handlers: Array<(p: unknown) => void> = [];
  const fake = { channel: () => ({
    on: (_e: string, _f: unknown, cb: (p: unknown) => void) => {
      handlers.push(cb); return this;
    },
    subscribe: () => ({}), unsubscribe: () => {},
  })} as unknown as SupabaseClient<Database>;

  const events: RealtimeEvent[] = [];
  subscribeToWorkspace(fake, (e) => events.push(e));
  handlers[0]({ table: "messages", eventType: "INSERT", new: {
    id: "m_1", conversation_id: "c_general", author_id: "u_maya",
    content: "hi", created_at: new Date().toISOString(), edited_at: null,
  }});

  expect(events).toEqual([{ kind: "message-insert", message: expect.objectContaining({
    id: "m_1", channelId: "c_general", content: "hi",
  })}]);
});

it("turns anything else into a single stale event", () => {
  // ... same fake; push a tasks UPDATE
  expect(events).toEqual([{ kind: "stale" }]);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/qa/supabase-realtime.test.ts
```
Expected: FAIL — `subscribeToWorkspace` is not defined.

- [ ] **Step 3: Implement**

One channel, `postgres_changes` on `schema: "public"`. A `messages` INSERT builds the message inline — a new message has no reactions or attachments, so the fields are `[]`; **do not** call the grouped mapping functions, which need join rows. Everything else emits `{ kind: "stale" }`.

- [ ] **Step 4: Run to verify it passes, then wire it up**

`SupabaseBackend.subscribe` delegates to `subscribeToWorkspace(this.client, onEvent)`.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run test:rls && npm run probes
git commit -am "feat(realtime): the Supabase channel"
```

---

## Task 4: Presence

**Files:**
- Create: `lib/presence.ts`
- Modify: `components/user-avatar.tsx:14`, `components/user-card.tsx:17,23`, `components/chat/dm-view.tsx:10,16`
- Modify: `lib/backend/supabase/realtime.ts`, `lib/backend/supabase/mapping.ts:209`
- Test: `tests/qa/presence.test.ts`

**Interfaces:**
- Consumes: the channel from Task 3.
- Produces: `PRESENCE_DOT: Record<Presence, string>`, `PRESENCE_LABEL: Record<Presence, string>` in `lib/presence.ts`; `RealtimeEvent` gains `{ kind: "presence"; onlineUserIds: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
it("marks users in the presence set online and everyone else offline", async () => {
  const backend = new EventBackend();
  const { result } = await mount(adminState(), backend);

  backend.emit({ kind: "presence", onlineUserIds: ["u_maya"] });

  await waitFor(() => {
    const maya = result.current.state.users.find((u) => u.id === "u_maya")!;
    const sam = result.current.state.users.find((u) => u.id === "u_sam")!;
    expect(maya.presence).toBe("online");
    expect(sam.presence).toBe("offline");
  });
});

it("clears a dot when someone leaves", async () => {
  // emit ["u_maya"], then emit [] — maya must go offline, not stay online
});
```

- [ ] **Step 2: Run to verify it fails**, then implement.

`lib/presence.ts` holds the one copy of the dot and label maps, moved from `user-avatar.tsx`. The other two components import it; delete their local copies. Track presence on the same channel with `channel.track({ user_id })` on subscribe and `presenceState()` on sync, emitting `{ kind: "presence", onlineUserIds }`. In `mapping.ts:209`, `toUser`'s hardcoded `row.id === currentUserId ? "online" : "offline"` becomes `"offline"` — presence now comes from events, not from the row.

- [ ] **Step 3: Verify the dots render from one source**

```bash
grep -rn "PRESENCE_DOT\|PRESENCE_LABEL" components/ lib/
```
Expected: definitions only in `lib/presence.ts`; the three components import them.

- [ ] **Step 4: Gates and commit**

```bash
npm run typecheck && npm run lint && npm test
git commit -am "feat(realtime): real presence, from one dot mapping instead of three"
```

---

## Task 5: Connection lifecycle

**Files:**
- Create: `components/connection-status.tsx`
- Modify: `lib/backend/supabase/realtime.ts`, `lib/store.tsx`, `components/providers.tsx`
- Test: `tests/qa/connection-status.test.ts`

**Interfaces:**
- Consumes: the channel from Task 3.
- Produces: `RealtimeEvent` gains `{ kind: "connection"; online: boolean }`; `StoreValue` gains `connected: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
it("reloads on reconnect, because events missed while offline are gone", async () => {
  const backend = new EventBackend();
  const { result } = await mount(adminState(), backend);
  const before = backend.hydrateCalls;

  backend.emit({ kind: "connection", online: false });
  await waitFor(() => expect(result.current.connected).toBe(false));
  backend.emit({ kind: "connection", online: true });

  await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1));
  expect(result.current.connected).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**, then implement.

Map the channel's `SUBSCRIBED` / `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` states to `{ kind: "connection", online }`. On a transition back to online, reload — that is the only way to recover what was missed. `ConnectionStatus` renders a quiet line when `connected` is false; it renders nothing when true, so the normal case is unchanged.

- [ ] **Step 3: Gates and commit**

```bash
npm run typecheck && npm run lint && npm test
git commit -am "feat(realtime): reconnect, and reload what was missed"
```

---

## Task 6: Revocation while connected, at the access layer

**Files:**
- Test: `tests/rls/realtime.test.ts`
- Modify: `tests/probes/realtime_probe.mjs`

**Interfaces:** consumes everything above; produces no new API.

- [ ] **Step 1: Write the failing test**

Against lumina-dev with two real users. A live feed could actively *preserve* stale access, so this is proven rather than assumed:

```ts
it("a member removed from a restricted project loses it on the next reload", async () => {
  // member hydrates and CAN see the project (positive control)
  // owner deletes their project_members row
  // member hydrates again — the project is gone, and so are its tasks
});
```

- [ ] **Step 2: Extend the probe** with the same case from an anonymous client, then run everything:

```bash
npm run test:rls && npm run probes
```

- [ ] **Step 3: Commit**

```bash
git commit -am "test: revocation reaches a connected client"
```

---

## Task 7: Two browsers, end to end

**Files:** none committed except the report.

- [ ] **Step 1: Create two real accounts**

```bash
node tests/probes/e2e_users.mjs
NEXT_PUBLIC_BACKEND=supabase npm run build
```

- [ ] **Step 2: Drive two browser contexts** and record what was observed for each:

Post in a channel → arrives in the other without a reload, once. React → count updates both sides. Move a task → the other board follows, no gaps in the column. Revoke a project → it disappears from the other screen. Close a tab → the dot clears within seconds. Go offline then online → the app says so, then recovers and shows what it missed.

- [ ] **Step 3: Clean up and run everything**

```bash
node tests/probes/e2e_users.mjs --clean
node tests/probes/sweep.mjs
npm run typecheck && npm run lint && npm test && npm run test:rls && npm run probes
```

- [ ] **Step 4: Write the go/no-go note** for the cutover into `.superpowers/sdd/2026-09-09-realtime/progress.md`.

---

## Self-Review

**Spec coverage.** Direct message append → Task 2. Coalesced reload → Task 2. `writeSeq` bump and in-flight deferral → Task 2. Deferred callback body → Task 2 Step 5. Activity cap → **gap, folded into Task 2 Step 5** (the `stale` path reloads, which re-applies the cap; the direct path touches only `messages`, so the cap cannot be breached — noted rather than coded). Presence, three duplicate maps consolidated → Task 4. Reconnect and reload → Task 5. Disconnected indicator → Task 5. Outsider probe → Task 1. Revocation → Task 6. Two browsers → Task 7. Inert subscription for 29 suites → Task 2 Steps 3-4.

**Placeholders.** None: every code step carries real code, and the two prose-only steps (Task 7's browser pass) are observations, not implementation.

**Type consistency.** `RealtimeEvent` is defined once in Task 2 and extended in Tasks 4 and 5 — each extension names the exact new variant. `EventBackend.emit`/`emitted`/`hydrateCalls` are used with those names in Tasks 2, 4 and 5. `subscribe` has one signature everywhere.
