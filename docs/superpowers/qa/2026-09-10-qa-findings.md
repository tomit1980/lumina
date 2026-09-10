# QA — September 10, 2026 (browser pass)

> **Two documents, one pass, and a numbering collision that had to be resolved.**
> This file is the *browser* half: what a running app actually did. Its sibling,
> [`2026-09-10-code-findings.md`](2026-09-10-code-findings.md), is the *code-reading*
> half, and it independently numbered its findings from QA-101 as well. Both are kept,
> because they were established by different means and the distinction is worth
> preserving — but the identifiers had to stop colliding.
>
> **The code pass keeps QA-101 … QA-127. This file's three findings were renumbered to
> QA-128 … QA-130.** The mapping, since the earlier numbers are already cited elsewhere:
>
> | was | is now | and elsewhere |
> |---|---|---|
> | QA-101 | **QA-128** | — |
> | QA-102 | **QA-129** | — |
> | QA-103 | **QA-130** | `20260910002000_attachment_overwrite.sql` and commit `6b8fecc` call it QA-103 / QA-103a |
>
> Where a finding here and one there are the same bug, it says so.

The second full pass. The [first](2026-09-07-qa-findings.md) tested a browser-only demo; since
then Lumina gained a real backend, file storage, live updates and presence. This pass covers both
paths — `NEXT_PUBLIC_BACKEND=local`, which the public site still ships, and `supabase`, which the
team will use — with the newest surfaces given the most attention.

**Known-accepted limitations are not re-filed here.** Deletion events are not filtered by the
access rules (accepted deliberately, pinned by a probe); orphaned files need a manual sweep; an
admin cannot remove another person's second factor from the client; one role write is
last-writer-wins; three writes span statements without a transaction. Those are recorded decisions,
not discoveries.

**A note on evidence.** Five tests were caught proving nothing during the live-updates work alone.
This pass treats a passing suite as weak evidence and prefers what a browser actually did.

---

## QA-128 — Medium — the app can be offline and still look live

**Where:** `lib/store.tsx`, `lib/backend/supabase/realtime.ts` — nothing anywhere listens to
browser connectivity.

**What happens.** Close a laptop, walk into a tunnel, lose wifi. The browser knows immediately and
fires an `offline` event. Lumina ignores it. The app only discovers it is disconnected when the
socket's own heartbeat times out, and until that happens the interface shows no indicator, the
connection is reported healthy, and messages simply stop arriving with nothing to say so.

**Verified**, not suspected: dispatching a browser `offline` event produced no indicator, and a
search of the codebase finds no `navigator.onLine` or `online`/`offline` listener.

**Why it matters.** This branch exists to make "connected" mean "receiving". A window where the
app is demonstrably not receiving and still claims health is the same class of defect the branch
spent four fixes removing — and this one is reachable by closing a lid.

**Not severe** because it self-corrects: the socket eventually times out, the indicator appears,
and reconnecting reloads what was missed. The gap is the silent window, whose length is decided by
the socket's timeout rather than by anything the app controls.

---

## QA-129 — Low — deleting a person anonymises everything they ever did

**Where:** `activities.actor_id`, `on delete set null`.

**What happens.** Remove someone from the workspace and every activity entry they created becomes
"Someone created the Board Only project". The history survives; the attribution does not.

**Verified** against the development database: four activity rows whose author had been deleted all
carry a null actor and render as "Someone".

**This is correct behaviour, not a bug** — the person is genuinely gone, and inventing a name would
be worse. It is filed as a product question: for a team tool, "Moshe created this project" losing
its author when Moshe leaves the company may not be what you want. Keeping a denormalised name, or
retiring people rather than deleting them, are the alternatives. Worth a decision before a real
workspace accumulates history.

---

## QA-130 — High — you can only save a document you uploaded yourself  
**FIXED** in `6b8fecc` (migration `20260910002000_attachment_overwrite.sql`).

**Where:** `attachment_objects_insert` in `supabase/migrations/20260910001000_storage.sql:130`,
reached through `saveAttachment` in `lib/backend/supabase/index.ts:336`.

**What happens.** Open a shared document someone else uploaded, edit it, press Save:

> Couldn't save — saving e2e-upload.txt failed: new row violates row-level security policy

The file is untouched. In-app editing of Markdown, spreadsheets and Word documents — a headline
feature — works only for whoever created the file.

**Verified three ways.** Moshe saving his *own* new document succeeds ("Saved qa-owner-test.md").
Moshe saving a document whose uploader had left fails as above. And Dana, signed in as a second
real user, attempting to overwrite Moshe's file is **REFUSED** with the same message. The last of
those settles it: this is about who uploaded the file, not about the uploader having been deleted.

**Why it happens.** Saving overwrites the object in place, deliberately, so every link and message
referring to it stays valid. But Storage's upsert is an *insert* with a conflict clause, so
Postgres evaluates the **insert** rule — `is_attachment_uploader`, which permits only the original
uploader — and never reaches the update rule, which is correct and would have allowed it (anyone
who can see the file and holds `project.create`).

**Why it matters.** A team tool whose documents only their creator can edit is not a team tool. It
also gets worse over time: when someone leaves, the uploader link is nulled, and their documents
become permanently unsaveable by anyone.

**The fix is small.** Take the update path for an object that already exists rather than an upsert,
so the correct rule is the one that applies. The update rule already says exactly what it should.

---

## QA-131 — Medium — a workspace made by a newer build is silently destroyed  
**FIXED** in the same pass — see the commit that adds this section.

**Where:** `readPersisted` and `persist` in `lib/backend/local.ts`. **The path the public
site ships**, and the one area no browser had driven until this pass closed it.

**What happens.** `readPersisted` accepts a stored `version` between 1 and `SEED_VERSION`
and migrates it forward. A version *above* `SEED_VERSION` — a workspace written by a newer
build — matches nothing, so it falls through to `createSeed()`. That much is right: this
build genuinely cannot know what changed.

What was not right is what came next. The seed was then **persisted straight over the newer
workspace** by the next change, destroying it permanently. The user was told nothing, and
the app looked completely normal.

**Verified in a browser against the static build, with a control.** A marker message was
posted through the app, then the page reloaded:

| | stored version | messages | marker |
|---|---|---|---|
| control — plain reload | 13 | 29 | present |
| stored version bumped to 14 | **13** | **28** | **gone** |

The stored version coming back as 13 is the damage: the newer blob had already been
overwritten, so even loading the correct build afterwards would not bring it back.

**How it is reached** — not by anything exotic: a stale cached bundle, a tab held open
across a deploy, or a rollback of the site. On a static export served from a CDN, a browser
running older JavaScript than the data in its own localStorage is an ordinary Tuesday.

**The fix is not to read the unreadable state** — this build has no way to. It is to refuse
to *write over* it, which turns permanent loss into a wait: the bytes stay on disk for the
build that understands them, and the user is told, once, the first time a change of theirs
is not kept.

**A note on the first attempt, because it is the pass's own recurring bug class.** The
message was first raised from `hydrate()`. The data half worked and the message appeared
nowhere — `hydrate()` resolves before anything has rendered, so the toast was dropped. It
had to be driven in a browser to see that; the test only covered the bytes. It now fires
from `persist`, edge-triggered like the quota message beside it, which is also the moment
it actually matters to the user.

---

## What this pass covered, and what it did not

**Covered here:** sign-in and the second factor, chat, the document editors, file storage
and its access rules, presence, and the two-browser cases that need a second real person.

**Covered by the code pass instead**, and not re-walked in a browser: the store's apply
core, the realtime connection lifecycle, the empty states, and every Supabase-only
divergence the unit suites structurally cannot see. That document says which of its
findings are verified by reading and which are suspected; three of them have since been
settled against the running database, and it now records those results.

**Still not covered by either pass, and worth saying plainly rather than leaving implied:**

- **The local demo path is now covered** — it was the last gap, and driving it found and
  fixed QA-131 above. What reading had surfaced as a maybe turned out to be real, and worse
  than reading suggested: not merely a silent reset, but a permanent overwrite.
- **Concurrent editing of the same document.** QA-108 describes it from the code; nobody
  has had two browsers on one spreadsheet.
- **The attachment cap on the local path is not a finding.** A 3 MB file base64s to roughly
  4 MB of a ~5 MB localStorage budget, which looks like a cap the app cannot honour — but
  `lib/attachments.ts:15-27` already reasons this through and puts the quota toast in
  `LocalBackend.persist` as the backstop. Recorded so it is not re-filed.

## What has been fixed since

| finding | where | commit |
|---|---|---|
| QA-101 (Critical) — a stale list destroyed another person's file | code pass | `6b8fecc` |
| QA-130 / QA-103 (High) — only the uploader could save a document | here | `6b8fecc` |
| QA-103 (High) — an unreadable .docx opened blank and could overwrite | code pass | `6b8fecc` |
| QA-105 (High) — "undone" after the bytes were already replaced | code pass | `6b8fecc` |
| QA-116 (High) — a message attributed to a real, wrong colleague | code pass | `755eb31` |
| QA-117 (Medium) — `profiles`/`roles` never reached an open tab | code pass | `755eb31` |

QA-102 and QA-104 are in progress. QA-128 and QA-129 are open: QA-128 is a real gap with a
self-correcting window, and QA-129 is a product question rather than a defect.
