# Lumina — live updates and presence

**Status:** approved 2026-09-09. Implements Phase 2 (Realtime, Presence) of
`2026-09-06-lumina-production-design.md`. Storage, the third item in that phase, shipped early
in Plan 2.

**Amends the parent spec.** Phase 2 says to "patch the cache on change". That is not available —
see *Why not per-row patching* below — so this document replaces that sentence.

## The problem

Lumina keeps everything on the server now, but nothing tells a browser the server changed. Two
people in one channel each reload to see the other's messages. Unread badges move only on refresh.
A task dragged on one screen stays put on another. For a tool whose main surface is chat, that is
the feature not working rather than a rough edge.

Presence is worse than missing. `User.presence` is seed data, so the dots confidently show
colleagues as available who have not opened the app in a week. Real data behind a fake
availability indicator is the dishonesty this project has spent days removing elsewhere.

## Decisions

- **Online means a tab is open.** No idle or away state; a background tab counts. Simple, and what
  most tools mean.
- **Everything live** — chat, reactions, unread state, tasks, projects, channels, membership, the
  activity feed.
- **New messages apply directly; every other change triggers a coalesced reload.**

## Why not per-row patching

The parent spec assumed an incoming row could be converted and spliced in. The code says otherwise.
`lib/backend/supabase/mapping.ts` builds models from lookups grouped once per load, not per row:

| Model | Needs, beyond its own row |
|---|---|
| Task | `task_collaborators`, `task_attachments` → `attachments` |
| Project | `project_members`, `project_attachments` → `attachments` |
| Message | `reactions`, `message_attachments` → `attachments` |
| Direct message | `dm_members` (the participants are a tuple, not a column) |

A change event carries one bare row. It cannot build any of the four. Per-row patching therefore
means writing a second set of converters *and* maintaining in-memory caches of four join tables,
each one a place a live patch can fight an in-flight edit. That is a large amount of machinery to
serve a single small team.

A **brand-new message is the exception**: it has no reactions and no attachments yet, so it is
self-contained. It is also the one case where latency is felt. So it gets the direct path and
nothing else does.

## Design

### How a change reaches the screen

1. An event for a new message appends it, keyed by id. Ids are client-generated, so an echo of your
   own message carries an id already held and is skipped — no duplicate.
2. Any other event marks the workspace stale and schedules a debounced reload. A burst costs one
   fetch. Reload is the existing path: parallel, already proven to respect the access rules, and
   already what a failed write uses to recover.

Two ids the server chooses and the store already adopts — a direct message's id, and a task's
position — must not be re-fought by a live update. They are settled in the write's own success
handler.

### Not fighting the store's own writes

The rollback logic counts optimistic patches so a failed write knows whether to undo its own patch
or reload. **It assumes it is the only writer.** A live update is a second, invisible one: a write
failing after a live update landed would restore a snapshot from before it and erase it silently —
no error, no toast.

Two rules close it:

- **Every live apply increments the same counter.** A failing write then sees that something landed
  and reloads instead of rewinding. Reuses the existing mechanism rather than adding a second.
- **A live apply never runs while a write is in flight.** It waits for the burst to end.

### Presence

Realtime Presence is a channel, not a table, so no schema change. Online while a tab is open;
offline otherwise. `toUser` currently hardcodes the signed-in user online and everyone else
offline — that goes.

The dot colour and label mapping is **duplicated in three components** (`components/user-avatar.tsx`,
`components/user-card.tsx`, `components/chat/dm-view.tsx`). Consolidate to one rather than adding a
fourth copy.

The failure to avoid is a stale dot. Closing a tab must clear it for other viewers within seconds.

### When the connection drops

Missed events are gone; the client is then silently stale, which is worse than being visibly
offline. So:

- Reconnect automatically, and **reload on reconnect** — the only way to recover what was missed.
- Say so while disconnected. A quiet indicator is honest; an app pretending to be live is not.

### Errors and failure

- A failed reload leaves the existing retry affordance in place; it must never fall back to seed
  data in front of a real user.
- The subscription callback must **defer its body**. `lib/auth.tsx` already does this for
  `onAuthStateChange`, with a comment recording why: the client library holds an internal lock
  across the callback and calling back into it can deadlock. The same hazard applies here.
- The activity feed is capped at 60 entries in the client. A live feed must respect the same cap or
  it grows past what a reload would show.

## The gate before any of it

**No table is published for live updates**, so subscriptions deliver nothing today. Publishing them
opens a second path to the same rows that every leak fix has been about — and one that fails
silently, only for whoever happens to be connected.

So the first task is a probe that **subscribes as a real outsider** and proves they receive nothing
they could not already query: a message in a private channel, another pair's direct message, a task
in a restricted project, an activity scoped to a project they cannot see. Each paired with a
positive control proving the subscription delivers anything at all, since one that delivers nothing
would otherwise pass. **If events leak, stop and report. Nothing is built on a broken boundary.**

## Testing

- **Unit:** a fake event source. An event applies; an echo of your own message does not duplicate;
  a burst coalesces into one reload; a live apply during a failing write causes a reload rather
  than a stale rewind.
- **Access layer:** the outsider probe above, plus revocation — a person removed from a restricted
  project must **lose it from an open browser**, not keep showing something the server would refuse.
- **Two browsers, two real accounts:** post and watch it arrive; react; move a task; revoke a
  project; close a tab and watch the dot clear; drop the connection and confirm recovery.
- Adding a subscription to the backend interface touches **every implementation**, including the
  local one and the failing double used by 29 suites. They need an inert subscription or nothing
  compiles.

## Out of scope

Typing indicators. Email notifications and invites, deferred by the parent spec. The cutover
itself. Message pagination — worth revisiting before real load, since a live feed grows an already
unbounded list.
