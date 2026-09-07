# Lumina QA findings — 2026-09-07

Full end-to-end QA pass over the localStorage app as deployed. Plan:
`.claude/plans` (QA pass). Baseline before the run: typecheck, lint, 7 unit tests
and the static build all green; working tree clean at `2003907`.

**Environment.** Production static export served by `lumina-static` at
`http://localhost:3001/lumina/` — same `basePath` and same bundle as GitHub Pages.
Demo accounts, password `lumina24`: **vlad** (admin), **maya** (member), **elena** (guest).

**Severity.** *Critical* — data loss, or one user reaching another's private data.
*High* — a core flow broken, or a permission not enforced at the action layer.
*Medium* — misbehaves, workaround exists. *Low* — cosmetic, copy, polish.

---

## Findings

### QA-001 — Critical — every user's browser holds the entire workspace, private data included

**Area:** persistence / architecture · **Suspected:** `lib/store.tsx:28` (`STORAGE_KEY`, one blob)

**Repro** (fresh localStorage): sign in as **elena** (guest) → open DevTools → read
`localStorage["lumina:v1"]`.

**Expected:** a guest holds only data they are entitled to see.
**Actual:** the blob contains every private channel and every DM between other people.
Verified as elena: `#leadership` is present with 2 readable messages — one begins
*"Offer went out to the senior backend candidate this morning…"* — plus 5 DM messages
between other users. The UI gate ("This channel is private") is cosmetic; the data is local.

**Status:** known and already being fixed — this is the entire premise of the Supabase
migration, and the RLS layer built in Plan 1 closes it. Logged with evidence so the fix has
a concrete before-state to verify against, and so nobody ships the current build to a real
team believing private channels are private.


### QA-002 — Medium — a shared Markdown document can beacon to an arbitrary URL when opened

**Area:** documents / privacy · **Suspected:** `components/documents/markdown-editor.tsx:30` (preview render)

**Repro:** create a project document containing `![](https://attacker.example/pixel.png)` or
raw `<img src="https://attacker.example/pixel.png">`, share it to a channel, and have someone
open it.

**Expected:** opening a teammate's document does not contact third-party servers.
**Actual:** the preview renders the image, so the browser fetches the URL — leaking the
reader's IP, user-agent, and the fact and time they opened the document. Confirmed
indirectly during XSS testing: an `<img src=x>` in the document produced repeated
`GET /lumina/projects/x → 404` requests, proving the preview issues real network requests
for document-controlled image sources.

**Note:** DOMPurify correctly strips the dangerous parts (`onerror`, `<script>`, `<iframe>`,
`javascript:` hrefs all removed — see the XSS result below), so this is a privacy leak, not
code execution. A CSP `img-src` restriction, or proxying/blocking remote images in the
preview, would close it.

**Passed alongside this:** five XSS vectors were all correctly neutralised — inline
`onerror`, `<script>`, `javascript:` in both markdown and raw-HTML links, `<iframe
src=data:>`, and `<svg onload>`. Legitimate formatting survived.

### QA-003 — Critical — pressing Enter in a spreadsheet cell silently discards the edit, and Ctrl+S then reports "Saved"

**Area:** documents / spreadsheet · **Suspected:** `components/documents/spreadsheet-editor.tsx`,
the cell `onKeyDown` Enter branch (`e.currentTarget.blur()`) vs the `onBlur` commit.

**Repro** (fresh localStorage, signed in as vlad):
1. Website Redesign → Files → **New spreadsheet** → name it → Create.
2. Click cell **A1**, type `ONLYEDIT`, press **Enter**.
3. Observe the header, then press **Ctrl+S**, then reload the page.

**Expected:** Enter commits the cell, the document is marked dirty, Save enables, and the
value survives a reload.

**Actual:**
- The value is visible in the cell, but the document is **never marked dirty** — polled once
  a second for 12 seconds: `dirty=false, saveDisabled=true` throughout, with `A1=ONLYEDIT`
  still on screen.
- The **Save button therefore can never be pressed** for an Enter-committed edit.
- **Ctrl+S bypasses the disabled button** (`save()` checks `readOnly`/`saving` but not
  `dirty`) and shows the success toast **"Saved QA-Sheet.xlsx"** — but the sheet is **empty
  after reload**. The save serialised the untouched workbook.
- Because `dirty` is false, neither the `beforeunload` prompt nor the "Discard changes?"
  dialog fires, so the user gets no warning at any point.

**Why it is Critical:** a user can type a column of figures, press Enter after each, hit
Ctrl+S, see "Saved", close the tab, and lose all of it with no warning and a success message.

**The commit path itself is sound — only the Enter trigger is broken.** Typing into A1 and
then **clicking a different cell** commits correctly: dirty flips true, Save enables, and
after Save + reload the value `VIA-BLUR` is still there. So the workbook write, the
serialiser and the persistence layer all work; Enter simply never reaches them.

**Two separable defects for the fix phase:**
1. Enter does not commit the cell.
2. `save()` does not verify there is anything to save, so it reports success having written
   nothing. Even after fixing (1), a save that serialises an unchanged workbook should not
   claim success.

**Note:** the Markdown editor marks dirty correctly, so this is specific to the spreadsheet
editor rather than the shared document shell.

### QA-004 — Critical — anyone who can create a project can seize any restricted project

**Area:** RBAC / per-resource access · **Suspected:** `lib/store.tsx` `setProjectAccess` ~899-915
· Found by automated suite A2 · Full detail: `docs/superpowers/qa/layer1-findings.md` (L1-005)

**Repro:** give a custom role only `project.create` (no `members.manage`). As that user, call
`setProjectAccess(<any restricted project id>, { restricted: true, members: [{ userId: me, level: "editor" }] })`
for a project you are not a member of and did not create.

**Expected:** denied — you have no relationship to that project.
**Actual:** succeeds. The only gate is `guard("project.create")`; there is no check that the
caller is the creator, an editor member, or an admin. So such a user can grant themselves
editor on **any** restricted project in the workspace, or strip everyone else's access.

Contrast `setChannelAccess`, which correctly requires `channelIsManageable()` — creator or
`channel.delete`. The project path simply lacks the equivalent.

### QA-005 — High — a project viewer can rename, recolour and reprioritise a restricted project

**Area:** RBAC / per-resource access · **Suspected:** `lib/store.tsx` `updateProject` ~843-851
· Found by automated suite A2 · Detail: L1-004

**Expected:** a viewer-only member cannot modify project fields, exactly as they cannot
modify its attachments.
**Actual:** `projectIsViewerOnly` is consulted **only** inside `if (patch.attachments)`.
Any other field — `name`, `description`, `emoji`, `color`, `priority` — bypasses the viewer
gate entirely.

**Shared root cause with QA-004:** there is no `project.update` or `project.access`
permission; both editing and access management were wired to reuse `project.create`, and that
reuse omits the object-level ownership check channels get. One fix — an object-level check for
creator, editor member, or `members.manage` — likely closes both.

### QA-006 — Medium — any channel named "general" silently becomes undeletable after a reload

**Area:** persistence / migration · **Suspected:** `lib/store.tsx` `migrate()` ~297 and the
hydration effect ~344-360 · Found by automated suite A3 · Detail: L1-006

**Repro:** create an ordinary channel named `general` (a duplicate, or after the real one is
renamed), then reload the page.

**Expected:** it stays a normal, deletable channel.
**Actual:** `migrate()` runs on **every** load, not only on genuinely older data — the version
gate accepts `parsed.version === SEED_VERSION`. Its legacy backfill
`isTeam: c.isTeam ?? (c.name === "general" ? true : undefined)` then permanently flags the
channel as the team channel, which is undeletable by design. With no rename action in the
store, the channel is stuck forever.

### QA-007 — High — a partially-corrupt saved workspace migrates "successfully", then crashes the app

**Area:** persistence / migration · **Suspected:** `lib/store.tsx` `migrate()` ~340-342
· Found by automated suite A6 · Detail: L1-008

**Repro:** take a valid `lumina:v1` blob and delete just the `activities` key (or just
`lastRead`), leaving everything else intact. Reload.

**Expected:** either a clean fallback to a fresh seed — which is what happens when `users`,
`channels`, `projects` or `tasks` are missing — or a backfill to an empty value, as every
other field gets (`parsed.dms ?? []`, `attachments ?? []`, and so on).

**Actual:** `activities: parsed.activities` and `lastRead: parsed.lastRead` are the **only
two top-level fields in the whole function without a `??` fallback**. Neither is iterated
inside `migrate()`, so nothing throws, the surrounding `try/catch` never fires, and hydration
accepts a state with `activities === undefined`. The app then loads looking healthy and
crashes on the **first message sent** (`activity()` spreads `...state.activities`) or the
first unread count read (`getUnreadCount` indexes `state.lastRead` with no optional chaining).

Raised above the automated suite's "Medium" because the failure mode is a hard crash on a
core action, from a state the app itself accepted as valid.

### QA-008 — Medium — moving a task between columns leaves permanent gaps in the source column

**Area:** kanban / ordering · **Suspected:** `lib/store.tsx` `moveTask` ~977-1011
· Found by automated suite A5 · Detail: L1-007

**Expected:** removing the middle task from a column ordered `[0,1,2]` renumbers the
remainder to `[0,1]` — the same dense guarantee the destination column gets.
**Actual:** they stay `[0,2]`. The renumbering map is built only from tasks matching the
*destination* status, so source-column siblings keep stale values. Harmless for
sort-by-order rendering today, but `order` drifts from a dense sequence over a board's
life, which breaks anything computing a position from column length.

### QA-009 — Low — `createTask` returns a task whose `order` is always 0

**Area:** store API · **Suspected:** `lib/store.tsx` `createTask` ~923-952
· Found by automated suite A5 · Detail: L1-010

The persisted value is correct; only the returned object is wrong. It is built before
`update()` runs, hardcoding `order: 0`, while the real value is computed on a separate copy
inside the updater. Any caller trusting the return value gets a lie.

### QA-010 — Medium — several icon-only buttons have no accessible name

**Area:** accessibility · **Suspected:** `app/page.tsx` (task quick-complete), plus four
icon buttons in `components/app-shell.tsx`

**Repro:** load the home page with a screen reader, or run an accessibility audit.

**Expected:** every control announces what it does.
**Actual:** 7 visible buttons expose no accessible name — no text, `aria-label`, `title`, or
`sr-only` content. Three are the per-task quick-complete circles on the home page, so a
screen-reader user hears an unlabelled button and cannot tell it completes a task; four are
icon buttons in the shell.

**Passing alongside:** every image has an `alt`, every form input is labelled, `main` and
`nav` landmarks exist, and the heading hierarchy is sensible. There is no skip link, which is
worth adding but is a lesser issue than the unnamed controls.

### QA-011 — Medium — the whole workspace is re-serialised on every state change, freezing the UI as attachments accumulate

**Area:** performance / persistence · **Suspected:** `lib/store.tsx:372-385` (the persist effect)

**Repro:** upload four 2.5 MB files to a project (well under the 3 MB per-file cap), then use
the app normally.

**Measured** with 13.4 MB in `localStorage`:
- `JSON.stringify(state)` — 16 ms
- `localStorage.setItem` — **66.5 ms**
- **~83 ms of synchronous main-thread work per state change**

`setItem` is synchronous, so this blocks rendering and input. And it runs on *every* state
change, not just file operations — sending a message, toggling a reaction, or merely opening
a channel (which writes `lastRead`) each re-serialise every embedded file's base64. The cost
scales linearly with total attachment volume, so a workspace that accumulates files gets
progressively jankier at everything.

**Also observed:** the quota-exceeded toast could not be triggered — this browser accepted
13.7 MB without error, well past the "~5-10 MB" the code's comment assumes. So the guard
exists but is untested in practice, and the practical failure mode is this slow degradation
rather than a clean error.

**Not a correctness bug** — nothing was lost, and all four files persisted and rendered
correctly. Logged because it is the kind of degradation that is invisible in a demo with no
files and obvious to a team six months in.

---

## By design, but surprising

Behaviours that are intentional and documented, yet likely to bite a real user. Listed
separately so triage can decide whether "documented" is good enough.

---

## Coverage log

| Suite | Status | Notes |
|---|---|---|
| A1 rbac-matrix | **done** | 51 tests. No RBAC gaps at the action layer for the seeded roles. |
| A2 resource-access | **done** | 19 tests. **QA-004 (Critical)**, **QA-005 (High)**. |
| A3 invariants | **done** | 15 tests. **QA-006 (Medium)**. |
| A4 messages | **done** | Rules confirmed; several documented under "by design". |
| A5 task-ordering | **done** | **QA-008**, **QA-009**. |
| A6 migration | **done** | 20 tests, every SEED_VERSION 1-10 plus failure paths. **QA-007 (High)**. |
| A7 attachments | **done** | Caps, batch upload, reference resolution, UTF-8 round-trips. |
| A8 auth-crypto | **done** | PBKDF2, base32, TOTP drift window, AES-GCM tamper detection all correct. |
| A9 pure-helpers | **done** | ICS escaping, tokenizer (no nesting — by design), formatBytes. |
| B1 RBAC walkthrough | **done** | Guest permissions correct throughout: no create buttons, no role controls, read-only task dialog, private channel gated, composer enabled only where allowed. QA-001 raised. |
| B2 document editors | **done** | Markdown **pass** (5 XSS vectors blocked, round-trip, Tab, dirty). Spreadsheet **FAIL** — QA-003 Critical. Word **pass** — import (heading/bold/italic/list/table), edit, save, reload; structure identical before save and after reload, so the docx round-trip is faithful. |
| B3 persistence & recovery | **done** | **QA-011**. Uploads and persistence correct at 13.7 MB; quota toast unreachable in this browser. |
| B4 per-resource access | **done** (automated) | Covered by suite A2, which found **QA-004** and **QA-005**. Browser check confirmed the private-channel gate renders. |
| B5 chat & DMs | **done** | **pass** — send, bold/code/@mention rendering, raw markdown stored. XSS fully escaped (see QA-012 note below). Edit/delete/reactions covered by suite A4. |
| B6 projects & kanban | **partial** | Board/List/Files tabs, filters and empty states verified. **Drag-and-drop not exercised** — dnd-kit needs a synthesised pointer sequence the harness could not reliably produce. Ordering logic covered by suite A5 (QA-008). |
| B7 task dialog | **done** | **pass** — scheduling interlocks cascade correctly (date enables time; time enables duration and reminder), empty-title validation blocks save. |
| B8 people & roles | **done** (automated) | Role/permission logic covered by suites A1 and A3 (**QA-006**). Guest view confirmed to expose no role controls. |
| B9 files & sharing | **done** | Upload, 3 MB cap, share-to-chat as reference, removal semantics verified earlier this session and by suite A7. |
| B10 auth & 2FA | **partial** | Login verified for all three roles; crypto (PBKDF2, TOTP drift, AES-GCM) covered exhaustively by suite A8. **TOTP enrollment not walked in the browser.** |
| B11 navigation | **done** | **pass** — 404 page, bad project/DM/file ids all show correct empty states with a way back. |
| B12 security probes | **done** | **pass** — Markdown preview neutralised 5 XSS vectors; chat tokenizer escapes all HTML while still rendering real markdown. |
| B13 responsive & theme | **done** | **pass** — dark mode switches, 375px mobile collapses the sidebar with no horizontal overflow. |
| B14 accessibility | **done** | **QA-010**. Images, labels, landmarks and headings all pass. |
| B15 performance & limits | **done** | Folded into QA-011 — 83 ms blocking write per state change at 13.4 MB. |
