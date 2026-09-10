# Lumina QA findings — 2026-09-10 (code-level pass)

> **Numbering.** A browser pass ran the same day and numbered its findings from QA-101 too.
> This document keeps **QA-101 … QA-127**; that one was renumbered to QA-128 … QA-130. See
> [`2026-09-10-qa-findings.md`](2026-09-10-qa-findings.md), which also records what neither
> pass covered.
>
> **Three of the findings below were afterwards settled against the running database**, which
> changes what two of them are worth. Each says so in place. The instrument, in both cases, was
> a throwaway account and a control that had to fire first — the first run of the QA-117 probe
> came back *inconclusive* because its own control never arrived, which is the property the six
> tests in "Judging the tests" lacked.
>
> **What has been fixed:** QA-101, QA-103 and QA-105 in `6b8fecc`; QA-116 and QA-117 in
> `755eb31`. QA-102 and QA-104 were in progress when this note was written.

A **read-only, code-level** QA pass over `feat/realtime` (merged to main), run entirely by
reading. Nothing was modified, nothing committed, no browser was driven and the app was not
started — another process holds the shared dev database. The only commands run were
`npm run typecheck` (clean) and `npm run lint` (0 errors, 11 warnings — the same 11 the
realtime ledger records). `npm run test:rls` and `npm run probes` were deliberately **not** run.

**Model:** `docs/superpowers/qa/2026-09-07-qa-findings.md`. Same severity scale:
*Critical* — data loss, or one user reaching another's private data.
*High* — a core flow broken, or a permission not enforced at the action layer.
*Medium* — misbehaves, workaround exists. *Low* — cosmetic, copy, polish.

**Ledgers read first**, and the accepted limitations they pin are **not** re-filed here:
DELETE events are not RLS-filtered (pinned by `realtime_probe.mjs`); orphaned attachments need
the manual sweep; an admin cannot remove another person's second factor from the client;
`setRolePermission` is last-writer-wins; `updateTask` / `setProjectAccess` / `updateProject` are
multi-statement without a transaction; ten tables carry `replica identity full` for nothing.
Where a finding below is a *consequence* of one of those, it says so explicitly.

**Verified vs. suspected.** Every finding states which. "Verified" here means *established by
reading the code on every side of the claim* — it does **not** mean reproduced in a running app,
because this pass could not run one. Anything that would need a browser or the database to
settle is labelled **SUSPECTED** and says what would settle it.

---

## Index

**1 Critical · 5 High · 13 Medium · 8 Low**, plus **6 tests** that would not fail if the
behaviour they protect regressed (2 wholly vacuous, 3 with a vacuous assertion, 1 suspected).

| # | Sev | One line |
|---|---|---|
| QA-101 | Critical | A stale attachment list deletes another person's file — bytes and row — permanently |
| QA-102 | High | `commit`'s rollback re-hydrate skips both rules every other whole-state adopt obeys |
| QA-103 | High | A .docx that fails to parse opens as an empty document that can be saved over the original |
| QA-104 | High | A realtime "connected" transition fetches the whole workspace behind the unanswered 2FA step |
| QA-105 | High | "Your change has been undone" after the file's bytes have already been replaced |
| QA-116 | High | A message whose author is unknown is rendered as a real, named, wrong colleague |
| QA-106 | Medium | Download is a dead anchor while a signed URL is pending or unobtainable |
| QA-107 | Medium | A signed URL is never re-minted, so Download breaks in a tab left open past the hour |
| QA-108 | Medium | A colleague's save to the same document is invisible and silently overwritten |
| QA-109 | Medium | Every reload re-fetches every message ever sent, unbounded |
| QA-110 | Medium | Sending a message costs the sender their own full workspace re-fetch |
| QA-111 | Medium | A channel that errors is never re-joined by this module (suspected consequence) |
| QA-117 | Medium | `profiles`/`roles` are not published: a new teammate and every role change never arrive |
| QA-118 | Medium | Every hover during a drag issues its own unordered `moveTask` |
| QA-119 | Medium | The two-factor admin controls toast success before the write is attempted |
| QA-120 | Medium | A failed 2FA enrolment leaves an empty dialog with a permanently disabled button |
| QA-121 | Medium | "Open in Lumina" leads a recipient to "this project is restricted" |
| QA-122 | Medium | Three toasts announce a write the store may have refused or rolled back |
| QA-123 | Medium | A rejected message edit silently discards what the user typed |
| QA-112 | Low | Editing a document logs an activity locally and never on Supabase |
| QA-113 | Low | Presence dots stay lit while the socket is down and across a sign-out |
| QA-114 | Low | `resetDemo` adopts without bumping `writeSeq` |
| QA-115 | Low | `currentUser` is `undefined` if a hydrate ever returns no users (suspected) |
| QA-124 | Low | Three empty states missing or saying the wrong thing |
| QA-125 | Low | The People page advertises demo-only "View as" on the real backend |
| QA-126 | Low | No in-flight guard on dialog submits: a double-click creates two |
| QA-127 | Low | Two more local/Supabase divergences (unreachable tombstone; `.xls` saved as xlsx) |

**If only three things are fixed:** QA-101 (the only irrecoverable data loss), QA-116 (the only
finding that never self-corrects), and QA-102 (the store's central guarantee failing inside the
function that implements it).

---

## Findings

### QA-101 — Critical — a stale attachment list permanently destroys another person's file, bytes and row

**Area:** attachments / concurrency · **Verified by reading**
**Location:** `lib/backend/supabase/storage.ts:276-323` (`syncAttachmentLinks`), reached from
`lib/backend/supabase/workspace.ts:352` and `lib/backend/supabase/tasks.ts` (`updateTask`).
Callers that hand it a stale list: `components/task-dialog.tsx:158,305,671`,
`app/projects/page.tsx:399-406`, `components/documents/document-page.tsx:127-139`.

**What happens.** `syncAttachmentLinks` treats the array it is given as the *complete, current*
attachment set. Anything present on the server but absent from that array is computed as
`removedIds` and passed to `deleteAttachments`, which **deletes the object from the bucket and
then the `attachments` row** — not an unlink, a destruction. The code comment at
`storage.ts:270-275` says this is deliberate ("an unlinked row falls back to
`can_see_attachment`'s uploader branch"), and for a genuine removal it is right.

The problem is that no caller sends a *current* list. Every one of them sends a snapshot:

- **`components/task-dialog.tsx` — the worst window.** `form.attachments` is seeded once from
  `editing.attachments` when the dialog opens (`:158`) and lives in local form state until Save
  (`:305`). Any file a colleague attaches to that task while the dialog is open is absent from
  `form.attachments`, so saving the dialog — even to change only the title — deletes their file.
  The window is the entire time the dialog is open.
- **`app/projects/page.tsx:399-406`.** `onAdd`/`onRemove` close over `project.attachments` from
  the render in which the file input fired. `AttachmentsField.handleFiles`
  (`components/attachments.tsx:184-195`) awaits the upload *before* calling `onAdd`, so on the
  Supabase path the closure is stale by the whole duration of a 10 MB upload. A `stale` reload
  landing in that window (which is exactly what a colleague's upload produces) makes the two
  uploads mutually destructive.
- **`components/documents/document-page.tsx:127`.** Same shape: `project.attachments.map(...)`
  captured before the `saveAttachmentBytes` upload is awaited.

**Both outcomes are bad, and which one you get depends on the actor's role.** If the actor holds
`project.delete` (any admin), `deleteAttachments` succeeds and the colleague's file is gone —
bytes and row — with no error and no toast anywhere. If the actor does not,
`deleteAttachments` throws its "only the person who uploaded it…" error (`storage.ts:189`), the
whole `updateProject` rejects, `commit` rolls back and the actor is told "We couldn't save
"<project>". Your change has been undone." — a message that names the wrong thing entirely and
gives them no way to succeed.

**Why it matters.** This is the only place in the codebase where one user's routine action can
irrecoverably delete another user's data, and it needs no permission mistake, no unusual
sequence, and no malice — two people working on the same project or task at the same time is the
normal case the branch was built for. It is invisible to the unit suites because they have one
writer.

**How established.** Read end to end: the three call sites, `AttachmentsField.handleFiles`,
`store.updateProject`'s pass-through of `patch.attachments`, `workspace.updateProject:352`,
`syncAttachmentLinks`'s `removedIds` computation, and `deleteAttachments`' object-then-row
deletion. The local backend loses the file too (it vanishes from the one JSON blob), but only
one person can be editing a localStorage workspace, so the defect is Supabase-only in practice.

**Not the accepted orphan item.** The recorded limitation is that *unreferenced* uploads
accumulate and need a sweep. This is the opposite: a *referenced, live* file being deleted.

---

### QA-102 — High — the rollback's re-hydrate breaks both rules every other whole-state adopt obeys, and can be erased by the next failing write

**Area:** store / apply core · **Verified by reading**
**Location:** `lib/store.tsx:925-940` (`commit`'s failure branch)

**What happens.** There are four places that adopt a whole fresh `AppState`. Three of them bump
`writeSeq`:

| site | bumps `writeSeq`? | waits for `writeInFlight`? |
|---|---|---|
| hydration effect, `:601-602` | **yes** | **yes** (`:593`) |
| `stale` reload, `:686-687` | **yes** | **yes** (`:677`) |
| `commit` rollback re-hydrate, `:931` | **no** | **no** |

The rollback re-hydrate is the one that does neither. This is precisely the defect the final
review found on the hydration effect and fixed there ("the reconnect/sign-in reload adopts a
fresh `AppState` without bumping `writeSeq` or honouring `writeInFlight`… a write failing during
a reconnect rolls back to its pre-reload snapshot and silently erases everything the reload just
recovered"). The same hole is still open one function away, in the code that *contains* the
rollback rule.

**The sequence.** Two writes W1 and W2 are in flight (two quick reactions, a drag plus a message,
a dialog save plus an autosave — the store never serialises writes). A live event bumps
`writeSeq`, so when W1 fails it takes the `writeSeq.current !== seq` branch and re-hydrates,
adopting a whole fresh state — **without bumping `writeSeq`**. W2 then fails. W2 reads
`writeSeq.current === seq2` (nothing bumped since it took its number), concludes nothing landed
while it was in flight, and calls `adopt(snapshot2)` — a snapshot taken *before* the re-hydrate.
Everything the re-hydrate recovered is silently discarded, with no toast beyond W2's own.

If W2 *succeeds* instead, its optimistic patch was already wiped by the un-gated re-hydrate
landing over an in-flight write, and nothing puts it back until the next reload.

**Why it matters.** It is the store's central guarantee failing inside the function that
implements it, on the recovery path, and it is untested — `commit`'s failure branch is exercised
by `FailingBackend`, but always with a single write in flight.

**How established.** `grep -n "writeSeq.current"` gives exactly six hits (`:602, :660, :687,
:725, :902, :921`); the adopt at `:931` is not among them. The `writeInFlight` decrement at
`:917` happens *before* the re-hydrate is issued, and the re-hydrate itself never reads
`writeInFlight`.

**Not covered by any test.** `tests/qa/realtime-apply.test.ts:388` ("keeps what the reload
recovered when a write then fails on top of it") is the closest, and it exercises the
*reconnect* reload — the path the final review fixed — not `commit`'s own re-hydrate.
`tests/qa/optimistic-rollback.test.ts:291` and `:321` each drive exactly one failing write.
Nothing in the suite has two writes in flight at once, which is the only shape that shows this.

**Four smaller instances of the same omission**, listed together because a fix should sweep them
all: `logActivities`' removal of a refused feed line (`:851`), `adoptDmId` (`:1234`),
`createTask`'s adoption of the server's position (`:1729`), and `resetDemo` (`:1138`) all mutate
state through `update`/`adopt` without bumping `writeSeq`. They are targeted patches rather than
whole-state landings, so a rollback restoring a snapshot that predates them is a smaller loss —
but it is the same rule being skipped, and the refused-activity removal in particular would be
silently undone, putting a feed line back that the server rejected.

---

### QA-103 — High — a .docx that fails to parse opens as an empty document, and one keystroke lets it be saved over the original

**Area:** documents / data loss · **Verified by reading**
**Location:** `components/documents/word-editor.tsx:59-80` (the mammoth load effect)

**What happens.** The load effect is:

```js
} catch (err) {
  if (!cancelled) setWarnings([`Couldn't read this document: ${String(err)}`]);
} finally {
  if (!cancelled) setLoaded(true);            // <- runs on the failure path too
}
```

If `mammoth.convertToHtml` throws — a corrupt or truncated .docx, an unexpected byte stream, a
file that is not really a .docx — the editor is nonetheless marked `loaded` and renders with its
initial `content: ""`. The user is shown a **blank page that looks like an empty document**. The
only signal is a small amber link in the toolbar reading *"Some content couldn't be imported
(1)"* — which describes a **total** failure as a **partial** one, and which has to be clicked to
reveal the real message.

The user's natural response to a blank document is to type in it. That fires `onDirty`, which
enables Save, and `DocumentPage.save` then calls `getDataUrl()` → `tiptapJsonToDocx` on an
essentially empty ProseMirror document and **overwrites the real file in Storage in place**
(`overwriteAttachment`, `upsert: true`, same path). The original content is gone with no version
history, and the app toasts `Saved <name>`.

**Why it matters.** `DocumentPage` was built with a deliberate three-state load guard
(`:89-105`, `:299-307`) whose stated purpose is "an error can never be mistaken for an empty
document and saved over the file". That guard covers the **download**. It does not cover the
**parse**, and the parse is where the Word editor's failure lives. The guarantee has a hole in
exactly the shape it was written to close.

**How established.** Read the effect, the `finally` block, the `loaded` render branch at `:168`,
the `content: ""` editor construction at `:52`, and the save path in `document-page.tsx:107-153`.
Not reproduced against a real corrupt file — that would need the app running — so the *trigger*
is inferred from mammoth's contract while the *consequence* is read directly from the code.

**Related, and not a bug:** the Markdown editor throws out of the render if
`dataUrlToText` gets a malformed data URL (`lib/documents.ts:104-113`, `atob` on a non-base64
payload), which surfaces the error boundary — loud, and therefore correct. The spreadsheet
editor's `XLSX.read` throws during render too. Only the Word editor swallows.

---

### QA-104 — High — the second-factor step is a client-side gate, and a realtime "connected" transition fetches the whole workspace behind it

**Area:** auth / realtime lifecycle · **Verified by reading; the security consequence is SUSPECTED**
**Location:** `lib/auth.tsx:525` (`gated`), `:590-594` (the auth listener),
`lib/backend/supabase/realtime.ts:414-430`, `lib/store.tsx:728-759` (the `connection` case)

**What happens.** `signInWithPassword` succeeds *before* the TOTP step. Supabase issues a real
aal1 session at that moment. `lib/auth.tsx` holds it back from React (`gated.current = true`, so
`publish()` returns early), so `AuthGate` correctly keeps showing the login screen.

But `lib/backend/supabase/realtime.ts` subscribes to `client.auth.onAuthStateChange`
**directly**, by design ("so the socket is repaired even in a build where no component ever
renders"). It knows nothing about `gated`. So:

1. `SIGNED_IN` (aal1) fires → the listener sees `uid !== joinedAs` → `schedule(join)`.
2. `join()` emits `{ connection, online: false }`, tears down the anonymous channel, re-joins
   with the aal1 token.
3. `SUBSCRIBED` → the identity check passes (`sessionUserId` *is* that user) →
   `{ connection, online: true }`.
4. `lib/store.tsx:756-758`: `wasOnline` is `false` (the signed-out channel emitted `false` at
   `realtime.ts:340`), so this is a transition → `setHydrateAttempt(n => n + 1)`.
5. The hydration effect runs `backend.hydrate()` — **19 parallel selects for the entire
   workspace** — with the unverified aal1 session.

No policy in `supabase/migrations/` references `aal` or `auth.jwt()->>'aal'` (checked:
`grep -rn "aal\|mfa" supabase/migrations` returns only the `mfa_required` column and its guard
trigger). So RLS grants an aal1 session everything an aal2 session gets, and the fetch returns
the real workspace: every message, project, task and DM the account may see.

Nothing is *rendered* — `AuthGate` is still showing the login screen — but the data is in the
tab's heap and in its network log. And if the user then presses "Back to sign in"
(`cancelPendingLogin`, `:684-706`), `SessionBridge` does **not** clear the store, because its
`wasSignedIn` ref was never set (the session was never published). The half-authenticated
account's workspace stays in memory until something else replaces it.

**Why it matters.** It makes the second factor decorative at the data layer: someone with a
stolen password and no authenticator gets the workspace fetched for them automatically. Note
that the underlying property — RLS not distinguishing aal1 from aal2 — predates this branch and
is reachable by anyone willing to call PostgREST with the aal1 token by hand. What the realtime
work added is that the app now does it for them, unprompted, on the normal path.

**Verified vs. suspected — SETTLED, and it is not suspected any more.** The mechanism was
verified by reading. The severity has since been established directly against lumina-dev: a
throwaway account was created, a real TOTP factor enrolled and **verified**, and the account
then signed in with the password alone.

```
STATE  password-only session: current=aal1 next=aal2
READS  behind the unanswered second factor:
         profiles    3 rows
         projects    2 rows
         channels    3 rows
         messages    0 rows
         tasks       1 rows
         activities  5 rows
```

Five of six tables returned real rows. (`messages` was empty because that throwaway account was
a member of nothing — not because anything refused it.) There is no Supabase-side aal
enforcement standing in for the missing policy predicate: RLS genuinely cannot tell the two
sessions apart, so the second factor is decorative at the data layer and the app fetches the
workspace for someone who has not answered it. **The severity stands as High.**

---

### QA-105 — High — "Your change has been undone" after the file's bytes have already been replaced

**Area:** documents / honesty of failure · **Verified by reading**
**Location:** `components/documents/document-page.tsx:120-147`,
`lib/backend/supabase/storage.ts:123-155` (`overwriteAttachment`)

**What happens.** `save()` is two writes that are not one:

1. `saveAttachmentBytes(...)` — overwrites the Storage object **in place** (`upsert: true`,
   same path) and updates the `attachments` row's size/`edited_by`/`edited_at`.
2. `updateProject(project.id, { attachments: [...] })` — records the new size and editor stamp
   on the project's copy of the attachment.

If (1) succeeds and (2) fails — a network drop between the two calls, access revoked mid-edit,
or the `attachments` array being refused for the reason in QA-101 — the user sees `commit`'s
toast: **"We couldn't save "<project>". Your change has been undone."** Nothing has been undone.
The file's previous contents were destroyed by step (1) and there is no version history to
recover them from. `dirty` also stays `true`, so the header keeps saying "Unsaved changes" about
edits that are, in fact, the only copy that now exists on the server.

**Why it matters.** It is a UI claiming the *opposite* of what happened, on the one operation
where the previous state is unrecoverable — the same class as QA-003b, inverted. The code at
`:140-147` was written carefully to avoid claiming success it does not have; the failure
message does not get the same care.

**Relationship to an accepted item, stated so it is not confused with one.** The ledger accepts
that `updateProject` / `updateTask` / `setProjectAccess` each span several statements without a
transaction, on the grounds that "the screen self-corrects and nothing is shown that a reload
would not". That reasoning does not extend here, and this is the *consequence* nobody recorded:
this pair spans a **Storage overwrite**, which no reload corrects and no rollback can reverse.
The recorded item is about a transient inconsistency; this is a permanent one, announced as its
opposite.

**How established.** Read `save()`'s two awaits, `overwriteAttachment`'s bytes-first ordering
(and the comment at `storage.ts:117-121` that deliberately chooses it), and `commit`'s failure
toast at `lib/store.tsx:918-920`. Reachable in more than one way, which is why it is High rather
than Medium: the QA-101 path makes step (2) fail on the ordinary two-people-in-one-project case,
not only on a network blip.

---

### QA-106 — Medium — Download is a dead anchor whenever a signed URL is pending or unobtainable

**Area:** attachments / silent failure · **Verified by reading**
**Location:** `components/attachment-url.ts:42-79` returns `string | undefined`; consumed by
`components/chat/message-attachments.tsx:56,115,126`,
`components/documents/viewer.tsx:16,50`, `components/documents/document-page.tsx:72,251`

**What happens.** On the Supabase path the download URL has to be minted asynchronously, so
`useAttachmentUrl` returns `undefined` on the first render and again, permanently, if signing
fails. Every consumer puts it straight into `href`:

```jsx
<a href={downloadHref} download={file.name} aria-label="Download">
```

React omits a `undefined` href entirely. An `<a>` with no `href` is not a link: it is not
focusable, gets no pointer cursor, and clicking it does nothing at all. So the Download control
on a chat file card, on the document page header, and in the read-only viewer is **inert for the
first few hundred milliseconds of every render, and inert forever if signing fails** — with no
spinner, no disabled state, no message. `useAttachmentUrl`'s own comment (`:64-67`) explicitly
declines to toast, which is a reasonable call for a thumbnail and the wrong one for a button the
user just pressed.

The `<iframe src={undefined}>` in `viewer.tsx:20` is the same shape: a PDF whose URL cannot be
signed renders as a permanently blank frame with no explanation.

The image case at `message-attachments.tsx:58` is *not* part of this finding — a broken image
with alt text is the honest rendering, and the code says so.

**Why it matters.** "The button does nothing when you click it" is the project's own stated
defining bug class, arrived at from the other direction. It is Medium and not High because the
common case resolves in a few hundred milliseconds and the file is not damaged.

**How established.** Read the hook's return type and every consumer of it.

---

### QA-107 — Medium — a signed URL is minted once and never re-minted, so Download breaks in a tab left open past the hour

**Area:** attachments / signed-link expiry · **Verified by reading**
**Location:** `components/attachment-url.ts:35-79`

**What happens.** The hook resolves a URL in an effect keyed on `[ref, downloadName, key]` and
stores it in component state. `SIGNED_URL_TTL_SECONDS` is 3600 (`storage.ts:46`) and the module
cache drops entries at 50 minutes (`TTL_MS`) so a *newly requested* link is never handed out
with seconds left on it. But nothing re-runs the effect for a component that is already mounted:

- at t=0 the URL is minted and stored in `url`;
- at t=50 min the module cache entry is considered stale, but `fresh` is only read in the
  `useState` **initialiser**, so the already-mounted component is unaffected;
- at t=60 min the URL is expired, and `url` still holds it;
- clicking Download at t=61 min sends the browser to an expired signed URL. Supabase answers
  with a JSON error body, so the user gets a downloaded/opened error blob or a blank tab,
  with nothing in the app acknowledging it.

An open document page is exactly the tab most likely to sit for over an hour — the TTL comment
at `storage.ts:43-45` names that scenario ("long enough that a document a user opens and edits
for an hour still downloads") but the client never renews.

The **editors** are safe: they load bytes through `attachmentBytes` → `storage.download`, which
does not use a signed URL at all.

**Consequence of an accepted item, recorded per instruction:** the ledger accepts that "signed
URLs are capability URLs with a 1h TTL: revocation stops MINTING a link but does not invalidate
one already issued". The *client-side* half of that was not recorded: the module-level `cache` in
`attachment-url.ts` is never pruned and never cleared on sign-out, so after a user's access is
revoked their still-open tab keeps re-serving working links from that cache for up to 50 minutes
without asking the server again. The app is not merely failing to invalidate a link someone
saved — it is actively handing the link out.

**How established.** Read the hook's state initialisation, its effect dependencies, the module
cache's lifetime, and `SIGNED_URL_TTL_SECONDS`. The 60-minute failure mode itself was not
observed (that needs a running app and an hour).

---

### QA-108 — Medium — a colleague's save to the same document is invisible, and the next save silently overwrites it

**Area:** documents / concurrency · **Verified by reading**
**Location:** `components/documents/document-page.tsx:87-105` (the bytes effect),
`components/documents/spreadsheet-editor.tsx:22-29`, `components/documents/word-editor.tsx:80`

**What happens.** The bytes effect is keyed on `[ref, mime, editable]`, where `ref` is
`file.dataUrl`. On the Supabase path an in-place overwrite **deliberately keeps the same storage
path** (`storage.ts:111-121`, `index.ts:350-352`) so that every link stays valid. The
consequence is that `ref` never changes when the file's contents change, so:

- a `stale` reload brings in the colleague's new `size` / `editedBy` / `editedAt` — the header
  visibly updates to "edited by Dana a few seconds ago";
- the bytes effect does **not** re-run, so `bytes` still holds the version downloaded on open;
- the editors compound it: `SpreadsheetEditor` reads the workbook once into `wbRef` on first
  render (`:22-29`) and `WordEditor`'s load effect is keyed on `attachment.id` (`:80`), so
  neither would re-read even if the bytes changed;
- the next Save serialises the stale in-memory document over the colleague's version.

There is no conflict detection, no warning, and no indication in the editor that the file
changed underneath it — only the timestamp in the header, which a person editing a document is
not watching.

**Why it matters.** Last-writer-wins on a shared document is a defensible product decision, but
it has to be *told to the user*, and the header actively suggests the opposite by showing a
fresh edit stamp over stale content. On the local backend this cannot happen (one writer), so
it is a Supabase-only defect and invisible to every unit suite.

**How established.** Read the effect's dependency array, the two editors' initialisation, and
`SupabaseBackend.saveAttachment`'s "reference is unchanged" contract.

---

### QA-109 — Medium — every reload re-fetches every message ever sent, unbounded

**Area:** realtime / read path · **Verified by reading**
**Location:** `lib/backend/supabase/hydrate.ts:56-98` (the 19 parallel selects)

**What happens.** `hydrateWorkspace` issues `client.from("messages").select("*").order("created_at")`
with **no limit**, and the same for `reactions`, `tasks`, `attachments`, `read_state` and the
rest. Only `activities` is capped (`MAX_ACTIVITIES`, and it is capped because the store's feed
is). Before this branch that ran on mount and after a failed write. It now also runs on:

- every coalesced `stale` event (`lib/store.tsx:681`) — i.e. most workspace changes anywhere;
- every reconnect and every sign-in (`:597`, via `hydrateAttempt`);
- every failed write with a concurrent change (`:925`).

So the cost of one live update is a full re-read of the whole workspace by every connected
client that can see the changed row. On a demo workspace this is invisible. On a team with a
year of chat it is tens of thousands of rows per event.

**Why it matters.** It is a correctness-adjacent scaling defect that the local demo cannot
show, on the newest and least-exercised path. It is Medium, not High, because the app stays
correct — it just does far more work than it needs to, and does it more often the busier the
workspace is.

**How established.** Read every select in `hydrateWorkspace` and every call site of
`backend.hydrate()` in `lib/store.tsx`. Not measured.

---

### QA-110 — Medium — sending a message, and opening a conversation with unread messages, each cost the sender their own full workspace re-fetch

**Area:** realtime / read path · **Verified by reading**
**Location:** `supabase/migrations/20260909001100_realtime.sql:11` (`read_state` is published),
`lib/backend/supabase/chat.ts:109-155` (`writeReadState`, called from `postMessage`),
`lib/backend/supabase/realtime.ts:150-160`, `lib/store.tsx:663-698`

**What happens.** `read_state` is in the `supabase_realtime` publication. Its RLS policy is
`user_id = auth.uid()`, so *other* people never see your marker move — good, and it means this
is not a cross-user storm. But **you** do. Every `read_state` upsert echoes back to the client
that wrote it, and `toRealtimeEvent` maps everything that is not a `messages` INSERT to
`{ kind: "stale" }`, which costs a coalesced whole-workspace hydrate 250 ms later.

`postMessage` upserts `read_state` on **every message sent** (`chat.ts:149`). So each message
you post triggers your own client to re-fetch the entire workspace — on top of the
`message-insert` echo, which the dedup rule correctly makes free. Opening any conversation with
unread messages does the same (`markChannelRead`; it does short-circuit when there is nothing new
— `lib/store.tsx:1376-1378` — so an already-read channel is free).

**Why it matters.** In an active channel this is one full hydrate per message typed, per
participant, compounding QA-109. It is also pure waste: the client already applied its own
optimistic `lastRead` patch, so the reload can only tell it what it already knows. Filtering
`read_state` out of the published set, or mapping it to a no-op event, would close it.

**How established.** Read the publication list, `writeReadState`'s call from `postMessage`,
`toRealtimeEvent`'s catch-all, and the `stale` reload. There is **no infinite loop** — checked
specifically: `MessageList`'s effect is keyed on `[conversationId, messages.length]`
(`components/chat/conversation.tsx:50-53`) and `markChannelRead` short-circuits, so the cycle
terminates after one hydrate.

---

### QA-111 — Medium — a channel that errors is never re-joined by this module; recovery is delegated entirely to a library timer this code neither verifies nor bounds

**Area:** realtime / connection lifecycle · **SUSPECTED** (mechanism verified; consequence not)
**Location:** `lib/backend/supabase/realtime.ts:290-303` (the `!up` branch), `:364` (join's
idempotence check)

**What happens.** On `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` the status callback emits
`{ connection, online: false }` and **returns**. It does not `schedule(join)`. Meanwhile
`channel` is still non-null and `joinedAs` still holds the current uid, so `join()`'s guard
(`if (channel && uid === joinedAs) return;`) and the auth listener's guard
(`if (uid === joinedAs && channel) return;`) both refuse to re-join for the same identity. The
module's only self-repair paths are an identity *change* and the blindness check — neither of
which fires here.

Recovery therefore depends entirely on supabase-js's internal rejoin timer producing a fresh
`SUBSCRIBED` through the same `subscribe` callback. If it does, everything is fine and
`{ online: true }` triggers the recovery reload. If it does not — a wedged socket, a channel the
server closed and will not re-authorize — the app sits on "Reconnecting…" indefinitely, never
reloads, and has no way back short of the user reloading the page.

**Why it is only suspected.** Whether supabase-js's rejoin reliably re-fires this callback is a
property of the library and the server, not of this file, and settling it needs a real socket
that is forced to error (offline the network mid-session; let a token expire). Everything on
*this* side of the boundary is verified: the `!up` branch really does return without scheduling,
and both guards really do block a same-identity re-join while a dead channel object is still
held.

**Why it is worth filing anyway.** It is the same shape as the headline bug this branch already
found — a socket whose health this module *asserts* rather than *knows*. The file goes to
considerable length to stop reporting `online: true` for a socket that is receiving nothing; it
does not close the mirror-image case, where `online: false` is reported and then nothing ever
tries to fix it. A `schedule(join)` on the `!up` branch, with a backoff, would make the recovery
this module's own rather than a library's.

---

### QA-112 — Low — editing a document logs an activity on the local backend and never on Supabase

**Area:** activity feed / backend divergence · **Verified by reading**
**Location:** `lib/store.tsx:1555-1567`

**What happens.** The "a file was edited" feed line is detected by comparing references:

```js
const edited = patch.attachments?.find((a) => {
  const before = prev.attachments.find((b) => b.id === a.id);
  return before !== undefined && before.dataUrl !== a.dataUrl;
});
```

On the local backend `dataUrl` *is* the bytes, so it changes on every save and the line
`updated "X" in "Y"` appears. On Supabase the object is overwritten **in place and the path is
deliberately unchanged** (`index.ts:350-352`), so `before.dataUrl === a.dataUrl` always, `edited`
is always `undefined`, and no activity is ever logged for a document edit. The other two
attachment notes (attached / removed) are length comparisons and work on both.

**Why it matters.** Small, but it is exactly the "code path that assumes one backend" class: a
feature that works in the demo and silently does not on the product, with no test able to see
the difference because the local backend is what the suites run. `editedAt` / `editedBy` are
already in the patch and would be a correct discriminator on both backends.

---

### QA-113 — Low — presence dots stay lit for the whole time the socket is down, and are carried across a sign-out

**Area:** presence · **Verified by reading**
**Location:** `lib/store.tsx:559` (`livePresence`), `:700-726`, `:72-81` (`withLivePresence`)

**What happens.** `livePresence` is set only by a `presence` event and is **never cleared** — not
on `{ connection, online: false }`, not on sign-out. So:

- while the socket is down, every dot keeps showing the last set the channel reported, however
  old. The "Reconnecting…" strip is the only hint, and it is a thin line at the top of the
  screen.
- after a sign-out, `livePresence` survives into the next session: the next hydrate runs
  `withLivePresence(next, livePresence.current)` and lights dots from the *previous* session's
  set before the new channel has said anything. It self-corrects within a second, when the new
  channel's first `sync` arrives.

**Why it matters.** Low, because both windows are short or accompanied by an explicit
"reconnecting" signal, and the brief's stale-dot failure mode (a dot surviving someone closing
their tab *while connected*) is correctly handled. Recorded because presence has now been wrong
three times on this branch in ways the suites could not see, and "the set is never invalidated"
is the remaining unexamined edge.

---

### QA-114 — Low — `resetDemo` adopts a whole new state without bumping `writeSeq`

**Area:** store / apply core · **Verified by reading**
**Location:** `lib/store.tsx:1136-1138`

Same omission as QA-102, in a fifth adopt site. A write in flight when the user signs out (or
presses "Reset demo data") will, on failure, restore its pre-reset snapshot over the reset
state. Low rather than High because both triggers are deliberate user actions with no
expectation of concurrent work, and because the next hydrate corrects it — but it is one more
instance of the same class, and if QA-102 is fixed this should be fixed in the same pass.

---

### QA-115 — Low — `currentUser` is `undefined`, and the app crashes, if a hydrate ever returns zero users

**Area:** store / empty state · **SUSPECTED**
**Location:** `lib/store.tsx:1984-1985`

```js
const currentUser =
  state.users.find((u) => u.id === state.currentUserId) ?? state.users[0];
```

With `state.users === []` this is `undefined`, and `userRole`, `can`, `canDeleteMessage` and
`SessionBridge` (`components/auth/session-bridge.tsx:37`) all dereference `currentUser.id`
immediately — a hard crash on the first render, from a state the store accepted as valid. This
is QA-007's shape (a state the app itself accepted, crashing on first use).

**Why only suspected:** the one path that produces an empty-ish workspace, `signedOutState()`
(`mapping.ts:468-492`), carefully includes a single placeholder user with `id: ""`, so the
documented path is safe — this appears to be exactly why that placeholder exists. What is not
established is whether a *real* hydrate can return zero profiles (a `profiles_read` policy
change, a workspace mid-bootstrap before the first profile row exists, a transient RLS
misconfiguration). If it can, there is no fallback. A `?? null` with an explicit "this workspace
has no members" screen would make it impossible; establishing it would need a probe that reads
`profiles` as a session with no profile rows visible.

---

### QA-116 — High — a message whose author the client does not know is rendered as a real, named, wrong colleague

**Area:** chat / identity · **Verified by reading**
**Location:** `components/chat/conversation.tsx:100-103`

```jsx
author={
  state.users.find((u) => u.id === row.message.authorId) ??
  state.users[0]
}
```

**What happens.** When the author cannot be resolved, the message is rendered as **the first user
in `state.users`** — their real name, their avatar, their colour, their `UserCard` popover, and
their identity for `canDeleteMessage`. `hydrate` orders profiles by name
(`hydrate.ts:78`), so that is whoever is alphabetically first in the workspace. The message is
not marked unknown in any way; it is confidently attributed to a specific colleague who did not
write it.

**Two ways to reach it, and the second is routine.**

1. `messages.author_id` is `on delete set null`, and `mapping.ts:144-146` (`owner()`) and
   `realtime.ts:142` both turn a null owner into `""`. The mapping's own comment calls this
   "mismatch 9" and says the result "renders as unknown". It does not. So every message written
   by someone whose profile is later removed is re-attributed to the alphabetically-first member
   of the workspace, permanently.
2. **`profiles` is not in the realtime publication** (see QA-117). So when a new teammate posts
   their first message, the `message-insert` event arrives at every open tab carrying an
   `author_id` those tabs have never seen — and nothing brings the new profile in, because no
   published table changed. Every already-open browser attributes the new person's messages to
   the alphabetically-first user **until that tab is reloaded by hand**.

**Why it matters.** Putting one colleague's name and face on another colleague's words is a
different and worse thing than a missing name, and case (2) needs nothing unusual at all — one
person joining a team is enough. It is also the only finding in this pass with no window: it
does not self-correct.

**The codebase already knows the right answer.** `app/page.tsx:318` writes
`actor?.name ?? "Someone"` and `components/chat/message-item.tsx:171` does the same for reaction
tooltips. This one line is the outlier.

**How established.** Read the fallback, both producers of `authorId: ""`, the `order("name")` on
the profiles select, and the publication list in `20260909001100_realtime.sql`. Independently
found by the UI audit and by me; not reproduced in a browser.

**One claim above is wrong, corrected here rather than quietly dropped.** The fallback did *not*
hand the impersonated colleague's identity to `canDeleteMessage`: that function takes the
message and reads `message.authorId`, not the `author` prop
(`components/chat/message-item.tsx:69`). The impersonation was real — name, avatar, colour and
profile card — but it conferred no delete rights. **Fixed** in `755eb31`: `author` is now
optional and an unresolved author renders as "Someone", with the publication change above
supplying the profile so the *right* name arrives in the first place.

---

### QA-117 — Medium — `profiles` and `roles` are not published, so a new teammate and every role change are invisible to an open tab

**Area:** realtime / coverage · **Verified by reading**
**Location:** `supabase/migrations/20260909001100_realtime.sql:4-15`

**What happens.** Twelve tables are added to `supabase_realtime`. `profiles` and `roles` are
not. Nothing else generates an event for them either — `setUserRole` writes `profiles`,
`setRolePermission` and `updateRole`/`createRole`/`deleteRole` write `roles`, and none of those
touch a published table. So in a browser that is already open:

- a person added to the workspace never appears in the sidebar, the People page, the DM picker,
  the assignee list or the access dialogs — and their messages are misattributed (QA-116);
- a role rename, a colour change, a permission granted or revoked, and a member moved between
  roles all fail to arrive. An admin who revokes someone's `project.create` sees it applied on
  their own screen and not on the target's, for as long as that tab stays open.

Server-side enforcement is unaffected — RLS and the triggers are absolute, so the revoked user's
writes are *refused*, loudly, by `commit`. The failure is that their UI keeps offering buttons
that now fail, and that the admin has no way to know the revocation has not landed anywhere.

**Not the accepted revocation item.** Task 6 proved *resource* revocation propagates while
connected, and it does: `project_members` and `channel_members` are both published. Role and
membership-of-the-workspace changes are the gap.

**How established.** Read the publication list against `lib/backend/supabase/roles.ts`'s five
writes and `hydrate.ts`'s `profiles` / `roles` selects. Adding both tables to the publication
would route them through the existing `stale` path with no client change.

**CONFIRMED against lumina-dev afterwards**, because the migration file alone cannot rule out a
table having been published by hand from the dashboard. A throwaway account subscribed to
`postgres_changes` and two writes were made — one to a published table as the control, one to
`profiles`:

```
control  read_state events: 1
subject  profiles   events: 0
```

The control matters: the probe's **first** run reported `read_state: 0` as well and printed
*INCONCLUSIVE* rather than a verdict, because a socket that hears nothing at all cannot tell you
anything about `profiles`. (The cause was a per-table binding; a schema-wide one, the shape
`tests/probes/realtime_probe.mjs` already proves works, fixed it.) **Fixed** in `755eb31` by
`20260910003000_publish_identity.sql`; re-running the same probe afterwards gave
`control 1 / subject 1`.

---

### QA-118 — Medium — every hover during a drag issues its own `moveTask`, and the calls are not ordered

**Area:** kanban / concurrency · **Verified by reading**
**Location:** `components/kanban/use-task-dnd.ts:52-70` (`onDragOver`)

**What happens.** `onDragOver` fires on every transition into a different column and calls
`void moveTask(...)` immediately — no debounce, no cancellation of the previous call, no
serialisation. Dragging a card across three columns issues three `move_task` RPCs; hesitating
over a boundary issues one per crossing. They are independent HTTP requests, so they can arrive
at the server out of order, and the last one to *arrive* wins. The board then shows whatever the
next `stale` reload pulls back — which may be a position the user passed through rather than the
one they dropped on.

Each RPC also publishes `tasks` changes to every connected client, so one drag costs every other
browser several coalesced whole-workspace reloads (compounding QA-109/QA-110).

**Why it matters.** Optimistically the card follows the cursor and looks right; the divergence
only appears after the reload lands, which is the pattern that gets reported as "it jumped back
on its own". `commit`'s `writeSeq` orders the store's *snapshots*, not the network.

**How established.** Read `onDragOver`, `store.moveTask`, and `tasks.moveTask`'s single RPC
call. Not reproduced — settling how often the reordering actually bites needs a real drag against
a real database.

---

### QA-119 — Medium — the two-factor admin controls toast success before the write is attempted

**Area:** auth / false success · **Verified by reading**
**Location:** `app/people/page.tsx:334-356`; the actions themselves at `lib/auth.tsx:730-742`,
`:782-791`

All four handlers are the same shape:

```jsx
onRequire={() => {
  requireTwoFactor(user.id);
  toast.success(`Two-factor required for ${user.name}`, { ... });
}}
```

`requireTwoFactor` returns `void` and runs the `profiles` update in a detached async IIFE, which
fires **its own** `toast.error("Couldn't change the two-factor requirement")` on failure. So a
refused write produces a green "Two-factor required for Dana" followed a moment later by a red
contradiction, and the switch stays where the optimistic render put it. The success is claimed
before anything is known.

Every other admin control on this page checks its return value first (`app/people/page.tsx:230-249`
for role changes); these four are the exception.

---

### QA-120 — Medium — a failed two-factor enrolment leaves an empty dialog with a permanently disabled button

**Area:** auth / empty failure branch · **Verified by reading**
**Location:** `components/auth/two-factor-dialogs.tsx:124-131` and `:174`

`startEnrollment` (`lib/auth.tsx:441-471`) swallows every error and resolves `null`, as does
`beginSelfEnrollment` when there is no client (`:794`). The dialog then does
`setDraft(null)` and renders `draft && (...)` — i.e. **nothing**. The user is left with a title,
a description, a Cancel button and a disabled "Enable", with no QR, no secret, no field, no
error and no retry. The comment at `:120-121` says "the dialog shows its skeleton until it does";
there is no skeleton in this component, and no terminal failure state either.

Supabase-only in practice — the local path's `draftFor` (`lib/auth.tsx:263`) resolves
synchronously and never null.

**Same shape, smaller:** `components/auth/two-factor-qr.tsx:33-35` catches a QR-generation
failure with `setGenerated(null)`, and `:66` then renders a 200×200 `Skeleton` forever. Mitigated
because the base32 secret below it is still shown, but nothing says the QR is not coming.

---

### QA-121 — Medium — "Open in Lumina" and the "from <project>" breadcrumb lead somewhere the recipient cannot go

**Area:** chat / attachments · **Verified by reading**
**Location:** `components/chat/message-attachments.tsx:28-38` and `:81-82`

Both links are built from `att.sourceProjectId` with no visibility check for the *reader*.
Sharing a file out of a restricted project into a channel is a supported flow and is meant to
work — `lib/attachments.ts:222-227` says so explicitly. But `app/projects/page.tsx:110-118`
gates the destination on `canSeeProject`, so following either link lands the recipient on **"This
project is restricted — Ask an admin to invite you if you need access."** The file they were
shared is right there in the message; the app tells them they are not allowed to see something
they *are* allowed to see. True on both backends.

---

### QA-122 — Medium — three toasts announce a write that the store may have refused or rolled back

**Area:** false success · **Verified by reading**
**Location:** `components/chat/message-item.tsx:233-236`,
`components/kanban/board.tsx:129-134`, `components/kanban/list-view.tsx:271-276`

```jsx
void moveTask(taskId, toStatus, Number.MAX_SAFE_INTEGER);
toast(toStatus === "done" ? `“${task.title}” marked as done` : `“${task.title}” reopened`);
```

`moveTask` and `deleteMessage` are declared `Promise<void>` (`lib/store.tsx:187, 229`), so unlike
every other write action they hand the caller no value to check — but the store still refuses
(`:1826-1835`) and `commit` still rolls back and toasts "Couldn't save … Your change has been
undone" (`:916-940`). The user sees "marked as done", then the contradiction, and the card snaps
back. The guard-refusal paths are largely unreachable behind the UI gates; the *backend-failure*
path is not, and it only exists on Supabase.

`app/page.tsx:229-240` does the same action correctly — because it goes through `updateTask`,
which returns a boolean. Widening the two `Promise<void>` signatures would let these three do the
same.

---

### QA-123 — Medium — a rejected message edit silently discards what the user typed

**Area:** chat · **Verified by reading**
**Location:** `components/chat/message-item.tsx:71-76`

```jsx
const saveEdit = () => {
  const content = draft.trim();
  if (!content) return;
  void editMessage(message.id, content);
  setEditing(false);
};
```

The edit box closes immediately. If the write fails, `commit` restores the original text and
toasts "Couldn't save"; the user's rewrite is gone, with no way to recover it — they must retype
it from memory. The composer one file over (`components/chat/conversation.tsx:157-161`) already
solves exactly this: it restores `draft` and `pending` when the send resolves falsy.

---

### QA-124 — Low — three empty states that are missing or say the wrong thing

**Area:** empty states · **Verified by reading**

- **`components/kanban/list-view.tsx:299-303`** — "No tasks match the current filters." renders
  whenever `tasks.length === 0`, including a brand-new project with no tasks and no filter set
  (`app/projects/page.tsx:161-168` passes an unfiltered list through when both selects are
  "all"). It tells the user to clear filters they never applied.
- **`components/app-shell.tsx:418-477`** — the Channels section has no empty state at all, while
  Direct messages (`:512-519`) and Projects (`:573-577`) both do. A user who can see no
  non-team channels gets a bare "CHANNELS" heading with nothing under it.
- **`app/chat/page.tsx:26-38`** — `/chat` with no `?id=` falls back to the team channel; where
  there is none, the user is told "Channel not found — It may have been deleted, or the link is
  stale", which is wrong on both counts since they followed no link. Reachable on Supabase, where
  a workspace need not have a team channel and the user need not be able to see it.

Noted so it is not re-flagged: `app/projects/page.tsx:365`'s "No files yet" being gated on
`canManageFiles` is **fine** — `components/attachments.tsx:242-247` covers the read-only case.

---

### QA-125 — Low — the People page tells Supabase users to use a demo-only feature

**Area:** backend divergence / copy · **Verified by reading**
**Location:** `app/people/page.tsx:558-562`

> Tip: ⌘K → "View as" to experience Lumina as any role.

Rendered unconditionally. "View as" is gated behind `isDemo` in the command palette
(`components/command-palette.tsx:45, 212-237`) and behind `backendKind` in the shell
(`components/app-shell.tsx:224, 598-627`), so under the Supabase flag this instructs the user to
use something that does not exist. Everything else on the page checks `backendKind` correctly
(`:332`).

---

### QA-126 — Low — no in-flight guard on dialog submits, so a double-click creates two

**Area:** write actions · **Verified as a code shape; the real double-fire window not measured**
**Location:** `components/project-dialog.tsx:203` (and `:132`, `:142` for Enter),
`components/channel-dialog.tsx:131`, `:92`; `components/task-dialog.tsx:696`, `:366`;
`components/role-dialog.tsx:191`, `:124`

Each `save`/`create` handler is async with no `busy`/`disabled` state while the write is in
flight. On the local backend the round trip is a resolved promise and the window is
sub-millisecond; on Supabase it is a real network call, so a double-click or a held Enter creates
two projects, two channels, two tasks or two roles. `NewFileDialog`
(`app/projects/page.tsx:426-441`) is the one dialog that guards this, so the pattern to copy is
already in the tree. `SelfEnrollDialog` also has a `busy` flag (`two-factor-dialogs.tsx:118`).

---

### QA-127 — Low — two more local/Supabase divergences worth recording

**Verified by reading**

- **The "file no longer available" tombstone is unreachable on Supabase.**
  `components/chat/message-attachments.tsx:40-51` renders its struck-through "removed from the
  project" card only when `resolveMessageAttachment` returns `null`, which
  (`lib/attachments.ts:231-239`) happens only for the local share representation
  (`dataUrl === ""`). On Supabase a shared file always carries a Storage path, so a file whose
  bytes are gone renders as an ordinary card with a broken thumbnail and a dead download link
  (QA-106) and nothing explaining why.
- **A legacy `.xls` is saved as xlsx bytes under its `.xls` name.** `lib/documents.ts:35` maps
  `xls` to the spreadsheet editor, and `components/documents/spreadsheet-editor.tsx:43` writes
  `bookType: "xlsx"` for anything that is not `.csv`. Nothing claims success falsely, but the
  file that comes back out is not the format its name says it is.

---

## Judging the tests

The whole unit suite under `tests/` (41 files, 647 tests) was audited specifically for tests
that **would not fail if the behaviour they protect regressed**. Two are wholly vacuous; three
more carry an assertion that cannot fail while the test as a whole still can; one is suspect.

### T-01 — a test that cannot catch the bug it was written for

`tests/qa/task-dialog.test.ts:91` — *"a save the store denies leaves the dialog open, preserves
the typed title, and shows no success toast"*. **Shape (a). Verified — I re-read it myself.**

This is the fix-b001 regression test, and it cannot catch fix-b001. `TaskDialog.save()` is:

```ts
const ok = await updateTask(editing.id, payload);
if (!ok) return;
toast.success("Task updated");
… closeTaskDialog();
```

The test does `fireEvent.click(Save)` at `:119` and then asserts **synchronously** at `:126`,
`:132` and `:133` — no `await`, no `waitFor`, no `act(async …)`. `save()` yields at
`await updateTask(...)`, so deleting `if (!ok) return;` would fire `toast.success` and
`closeTaskDialog()` one microtask *later*, after all three negatives have already run and passed.
`fireEvent` flushes React's queue, not a native promise continuation.

The only assertions here that can go red are the store's own **synchronous** `deny()` toast
(`:122`) and the store-level title check (`:135`) — neither of which is about the dialog's
honesty, which is what the test is named for. The same file's *other* test knows the timing and
says so ("the success toast lands a tick after the click") and correctly uses `waitFor`.
**Fix:** `await waitFor(() => expect(toastMock.error).toHaveBeenCalled())` before the three
negatives.

### T-02 — a test that re-states the source's own ternary

`tests/qa/attachments.test.ts:258` — *"keeps the cap at 3 MB locally and raises it to 10 MB on
the real backend"*. **Shape (d). Verified — I re-read it myself.**

```ts
expect(MAX_ATTACHMENT_BYTES).toBe(
  backendKind === "supabase" ? 10 * 1024 * 1024 : 3 * 1024 * 1024
);
```

`lib/attachments.ts:26-27` *is* that ternary, on the same `backendKind`. In the unit environment
`backendKind` is always `"local"` (proved by this repo's own
`tests/qa/supabase-backend.test.ts`), so the comparison actually evaluated is `3 MB === 3 MB`.
The half of the claim in the test's own title — the 10 MB Supabase cap, which is the deliberate
deviation Task 10 recorded and therefore the half most worth pinning — **cannot fail**. Change
the source's supabase branch to 50 MB and this stays green. **Fix:** assert the two literals
directly, without reading them back through the flag the source branches on.

### T-03 — an assertion that resolves before the window it claims to wait out

`tests/qa/realtime-apply.test.ts:100` — *"coalesces a burst of stale events into exactly one
reload"*. **Shape (b)/(a). Verified.**

The second `await waitFor(() => expect(backend.hydrateCalls).toBe(before + 1))`, commented "And
it stays one: no trailing reload per event", is already true the instant it runs — `waitFor`
invokes its callback immediately, so it resolves without ever waiting out another
`STALE_RELOAD_MS`. A trailing or re-armed reload would not be caught by it. The headline claim
does survive, via the *first* `waitFor` (five uncoalesced timers all fire in one tick →
`before + 5`, never `before + 1` → timeout), and the sibling test at `:117` correctly guards
against a latched coalescer. So the test is not worthless — one of its two stated claims is.
**Fix:** advance fake timers past the window, then assert.

### T-04 — a control that cannot fail

`tests/qa/realtime-apply.test.ts:518` — *"keeps the dots the channel lit, because rows cannot
know who is here"*. **Shape (c)/(d). Verified.**

`expect(presenceOf("u_sam")).toBe("offline")` is the control, and it cannot fail: the test's
`RowsOnlyBackend.hydrate()` maps *every* user to `"offline"`, and u_sam is in no presence set,
so he reads offline even with `withLivePresence` deleted outright. The primary assertion (u_maya
still online after the reload) is sound. **Fix:** put a second user in the first presence set and
assert he goes dark after the reload *because the channel dropped him*, which is the only thing
that distinguishes a carry from a latch.

### T-05 — a negative about DOM semantics, not about the code

`tests/providers.test.ts` — *"does not toast for events other than unhandledrejection"*.
**Shape (b). Verified.** Dispatching `new Event("some-other-event")` can never reach an
`"unhandledrejection"` listener; this asserts that `addEventListener` works, not anything about
`useUnhandledRejectionToast`. No plausible regression in the hook turns it red. Low-harm rather
than dangerous — but it is a line of coverage that buys nothing.

### T-06 — SUSPECTED

`tests/qa/reminders-collaborators.test.ts` — *"does not fire for a user who is neither the
assignee nor a collaborator"*. **Shape (b)/(a).** `render(...)` is not awaited or wrapped and the
only barrier is `await new Promise(r => setTimeout(r, 0))`. `StoreProvider` renders its loading
screen — no children, so no `<Reminders/>`, so no `tick()` — until `hydrate()` resolves *and*
React commits *and* passive effects flush. Nothing in the test proves the component ever mounted,
while its sibling positive test needs `waitFor` to see its toast. Tracing the scheduling suggests
it does mount in time (React's scheduler uses MessageChannel, which drains before a 1 ms-clamped
timer), which is why this is **suspected** and not confirmed — but it is one scheduling change
away from asserting nothing. **Fix:** use `renderHydrated()` from `_support.ts`, or assert a
positive first.

### Gaps in the doubles

- **`FailingBackend` is complete against its own `FailingOp` union** — all 30 members checked
  individually, every one has an override. The vacuous-double trap that bit this project five
  times is currently closed.
- **The one `Backend` method with no `FailingBackend` override is `reset()`**, and it has no
  `FailingOp` entry either, so `resetDemo()`'s failure path cannot be driven from a test at all.
  Nothing is silently passing today because no test names it — it is a latent hole of exactly
  the shape that has already cost this branch five findings, and worth closing before somebody
  writes the test that would need it. (`resetDemo` also has **no rejection handler** at
  `lib/store.tsx:1137`, so a failing reset becomes an unhandled rejection caught only by the
  generic net in `providers.tsx`.)
- `FailingBackend.sendToUser(dm)` ignores the seam's `isNewDm` and `message` parameters, so no
  test can assert what that operation was handed. Harmless today; unassertable.

### Not vacuous, though they look it — recorded so nobody "fixes" them

- `tests/qa/document-save.test.ts` — *"Ctrl+S with no changes is a no-op"*. The
  `await waitFor(() => Promise.resolve())` reads like a no-op but buys a real macrotask through
  RTL's `asyncWrapper` drain, and the save chain on `LocalBackend` is microtask-only, so the
  missing-`dirty`-guard regression really would be caught.
- `tests/qa/presence.test.ts` is **not** seed-vacuous: checked against `lib/seed.ts`
  (vlad/maya online, jonas/elena away, priya online, sam offline), every test flips at least two
  users away from their seeded value.
- `tests/qa/optimistic-rollback.test.ts` guards its "restored, not re-hydrated" claims with
  `expect(backend.hydrateCalls).toBe(1)`; `tests/qa/accessible-names.test.ts` guards every
  `for…of` with a non-empty length assertion; the `.every()` at
  `tests/qa/activity-persist.test.ts:158` is preceded by `expect(texts).toHaveLength(2)`.
- `createFakeClient` in `tests/qa/supabase-realtime.test.ts` deliberately does *not* auto-repair
  auth on sign-in — that is what keeps the Task 7 blind-socket regressions real, and it must
  stay that way.

### The shape of what the suite still cannot see

Three of the findings above are invisible to every unit test for the same structural reason, and
it is worth naming because it will recur:

1. **Nothing in the suite runs two writes concurrently.** Every rollback test drives exactly one
   failing write. QA-102 (and QA-118) need two in flight at once.
2. **Nothing in the suite has a second human.** QA-101, QA-108 and QA-116's second trigger are
   all "somebody else changed this while you were holding a snapshot of it".
3. **The suite runs on `backendKind === "local"`, always.** Every Supabase-only divergence —
   QA-106, QA-112, QA-116, QA-117, QA-120, QA-127 — is structurally out of its reach, and T-02
   is that fact leaking into an assertion. The realtime ledger's own carry-forward ("the unit
   suites cannot see it because they hydrate from local storage" is now true of presence three
   times) is the same observation from a third direction.

---

## What was checked and found sound

Recorded so a later pass does not re-walk it:

- **`typecheck` clean; `lint` 0 errors / 11 warnings**, matching the realtime ledger's baseline
  exactly — no drift since the merge.
- **The blindness repair itself (`realtime.ts`).** The `SUBSCRIBED`-then-verify-identity
  sequence, the generation counter guarding superseded callbacks, the serialised join queue, and
  `removeChannel` rather than `unsubscribe()` are all correct as written and correctly reasoned
  in the comments. QA-111 is about the *other* direction (never repairing after an error), not
  about this.
- **`message-insert` dedup by id** (`store.tsx:650`) genuinely covers both the echo of one's own
  send and a duplicate delivery.
- **`stale` never reloads over a write in flight** (`:677`) and the hydration effect obeys the
  same rule (`:593`) — the final review's fix is really there. QA-102 is the one call site it
  did not reach.
- **`markChannelRead` cannot loop.** Checked specifically, because a published `read_state` plus
  a reload plus a read-marker effect is exactly the shape that loops. It does not:
  `MessageList`'s effect is keyed on `[conversationId, messages.length]` and the store
  short-circuits when `lastRead >= latest`.
- **`chat.ts`'s false-success discipline.** Every UPDATE and DELETE asks for its rows back and
  rejects on zero. `toggle_reaction` and `find_or_create_dm` are server-side RPCs, so neither
  read-modify-writes from the client.
- **The `Number.MAX_SAFE_INTEGER` position Task 7 found is genuinely closed.** `board.tsx:129`
  and `list-view.tsx` still pass it and `lib/store.tsx:1875` still forwards the *raw* `toIndex`
  to the backend (only the optimistic patch clamps), but `tasks.ts:380` clamps to `INT4_MAX`
  before the RPC and the RPC clamps to the real column length. Checked specifically, because the
  un-clamped forward in the store looks like the bug and is not.
- **`refuseFrozen` in `tasks.ts`** refuses `projectId`/`order`/`createdAt`/`createdBy` loudly
  rather than dropping them — the right answer to a silent partial write.
- **`storage.ts`'s statement ordering** (row-then-bytes on the way in, bytes-then-row on the way
  out) is correct and the reasoning for it holds; `deleteAttachments` correctly treats
  `data: []` from `remove()` as a possible refusal and distinguishes it from an already-absent
  object.
- **`hydrate.ts` adds no client-side `WHERE` that restates a policy** — the one narrowing is the
  activity cap, which is a display budget. That discipline is intact.
- **The Markdown editor's remote-resource hook** covers `srcset`, `poster`, `background`,
  `ping`, `action`, `formaction` and `style: url(...)` across all elements, not just `<img>` —
  QA-002 is properly closed and then some.
