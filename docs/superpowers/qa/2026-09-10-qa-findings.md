# QA — September 10, 2026

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

## QA-101 — Medium — the app can be offline and still look live

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

## QA-102 — Low — deleting a person anonymises everything they ever did

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

## QA-103 — High — you can only save a document you uploaded yourself

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

*Pass in progress — file storage, the document editors, the local demo path, error and empty
states, and concurrent editing still to come.*
