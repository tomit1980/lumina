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

Live updates are timing-dependent, arrive from outside any user action, and fail silently when
they fail. That combination defeats the ordinary reflexes, so this section is specific about what
each layer can and cannot prove.

### Rules that apply to every layer

- **Every negative assertion needs a positive control.** "The outsider received no event" passes
  just as happily when the subscription is broken and nobody receives anything. Each negative is
  paired with the same subscriber receiving something they are entitled to. This project has
  produced vacuous tests three times; twice they were caught only by mutating the source.
- **Verify each new test fails without the change**, and say so in the task report. For live
  updates the cheap mutation is to drop the event on the floor: every test that claims to prove an
  event arrived must go red.
- **Run both gates.** `npm test` does not typecheck, and a suite has passed here while types were
  broken.
- **No `setTimeout` sleeps to "wait for the event".** Wait on the assertion — Testing Library's
  `waitFor`, or the probe's own polling with a deadline. A sleep tuned to a fast machine becomes a
  flake on a slow one, and this project has already had to de-flake two suites.

### Unit, with a fake event source

The subscription seam takes a `Backend`, and the tests inject a double that emits events on
command. No network, no timing races.

- A message event appends the message.
- **An echo of your own message does not duplicate it** — the id is client-generated, so the store
  already holds it.
- A burst of unrelated events results in **exactly one** reload, not one per event.
- **A live apply during an in-flight write that then fails causes a reload, not a rewind.** This is
  the second-writer hazard; it is the single most important unit test in the plan. Assert the live
  data survives the failed write.
- A live apply is deferred while a write is in flight, not interleaved with it.
- The activity feed stays capped at 60 after a live append.
- `LocalBackend` and the failing double expose an inert subscription — **29 suites mount
  `StoreProvider` and will not compile without one.**

### Access layer, against lumina-dev

- The outsider probe described above, as `tests/probes/realtime_probe.mjs`: subscribed as a real
  outsider, receives no event for a message in a private channel, another pair's direct message, a
  task in a restricted project, or an activity scoped to a project they cannot see — each with its
  positive control. It counts its checks and **fails if zero ran**, per `tests/probes/README.md`.
- **Revocation while connected.** Someone removed from a restricted project must lose it from an
  already-open browser, not keep showing something the server would now refuse. This is the case
  where a live feed could actively *preserve* stale access, so it is proven, not assumed.
- Presence carries no row data, but assert what a subscriber can see: presence of people they share
  no channel with should not become an inventory of the whole workspace.

### Two browsers, two real accounts

The layer that catches what the others structurally cannot — the end-to-end pass on Plan 2 found
two bugs while 592 unit and 221 access tests were green.

- Post in a channel; it arrives in the other browser without a reload, and the sender sees it once.
- React; the count updates both sides.
- Move a task on one board; the other follows, and the column ordering is not left with gaps.
- Revoke a project; it disappears from the other screen.
- Close a tab; the dot clears for the other viewer within seconds.
- **Drop the connection** (offline, then online): the app says it is disconnected, then recovers
  and shows what it missed. Recovery-after-disconnect is the claim most likely to be wrong and the
  least likely to be covered anywhere else.

### What is deliberately not tested

Exact delivery latency, and behaviour under many concurrent users — neither is meaningful against
one small team on a free tier, and a test asserting a timing figure would measure the network
rather than the code.

## Out of scope

Typing indicators. Email notifications and invites, deferred by the parent spec. The cutover
itself. Message pagination — worth revisiting before real load, since a live feed grows an already
unbounded list.
