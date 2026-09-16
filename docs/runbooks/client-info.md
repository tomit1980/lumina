# Client Info

Every project in Lumina is one client's case. The **Client Info** tab is where
that client's facts live: who they are, which super fund, what they were
diagnosed with, which documents have arrived, whether the contract is signed,
and — separately from everything else — the password to their fund's member
portal.

## Who can do what

| | Read the record | Edit it | Reveal the password |
|---|---|---|---|
| Admin or Owner | yes | yes | yes |
| Editor on the project | yes | yes | yes |
| Viewer on the project | yes | no | no |
| Not on the project | no | no | no |

"Editor on the project" means exactly what it means everywhere else in Lumina:
the project is unrestricted, or you are listed on it as an editor. It is **not**
the "manage projects" permission — somebody trusted to work a case can record
its facts, whether or not they are allowed to create projects.

This is enforced by the database, not by the screen. Hiding the tab would be
worth nothing: the app's public key is in every browser, so anyone signed in
can query the API directly. The rules are in
`supabase/migrations/20260914000200_client_info.sql` and are asserted from real
sign-ins in `tests/rls/client-info.test.ts`.

## Editing

There is **no Save button**. Every field saves when you leave it, or when you
press Enter. Escape puts the old value back. Checkboxes, the contract switch and
the two date fields save the moment you change them.

Each field tells you what happened: *Saving…*, then *Saved* for a couple of
seconds, or *Couldn't save* — which stays until you edit that field again. If a
save is refused the old value comes back on screen and a message says why.
Nothing is ever shown as saved before the database has agreed.

A project has no record at all until somebody types something into it. That is
why every project that existed before this shipped shows an empty form rather
than a row of blanks — the form is empty because the record does not exist yet,
and the first thing you type creates it.

### Updated contact details

The New phone and New email fields are separate from Phone and Email on purpose.
The originals are what went in on the application form and what the fund has on
file; a later number never overwrites them. Fill in both and you can always say
what was submitted and what is current.

### Dates

Type them **DD/MM/YYYY**: `02/03/1968` is the 2nd of March. Day first, always,
for everyone, whatever machine they are on. Slashes, dashes and dots all work,
and a leading zero is optional, so `2/3/1968` is the same date.

**A two-digit year is refused**, not completed. `15/03/68` could be 1968 or 2068,
and on a claim built around a date of birth a century is not worth guessing at.
So is any date the calendar does not have: `31/02/1968` gets a message rather
than a silent correction to the 2nd of March.

Leave it empty for "not known". That is a real answer and always allowed.

**Why this is typed rather than picked.** It used to be a native date picker,
which sounds safer and was not: that control renders in the **viewer's**
operating-system locale and cannot be told otherwise. The same date of birth
read day-first here and month-first on a US-configured laptop, with nothing on
screen to say which you were looking at. Owning the format is what makes
`02/03/1968` mean one thing. The case that proves it is "READS 02/03/1968 AS 2
MARCH, never 3 February" in `tests/qa/client-info-dates.test.ts`.

Dates are still **stored** as `YYYY-MM-DD` in a real `date` column. Only the
typing and the display changed; nothing in the database moved.

### Amount

Type digits. `12500`, `12500.50`, `$12,500` all work; anything else is refused
with a note rather than quietly rounded. Amounts are stored to the cent in
Australian dollars.

### Notes

Notes are a log, not a text box. Type what happened in **New note** and press
**Add note** (or Ctrl/Cmd+Enter); the entry appears with your name and the time,
both set by the database rather than typed. Enter is a new line.

**An entry cannot be edited or deleted once added — by anyone, through the app
or the API.** That is enforced by the database having no update and no delete
rule for notes at all, and it is what makes the log a record of what was known
when. Mistyped something? Add a correcting note.

Text that was in the old single Notes box became each client's first entry,
carrying the date it was last saved and who saved it.

Viewers see the log and have no box.

## The client's password

**Where it is.** Not in the project, not in the record, and not in your browser.
It is encrypted in Supabase Vault with a key held outside the database. The
record carries only a pointer to it.

**What that protects against.** A database backup, a copy of the table, an
export, or anybody who gains read access to the workspace's data — none of them
get the password. It is never returned by an ordinary query, never sent to the
browser on sign-in, never in a live-update message, and never written to
`localStorage`.

**What it does not protect against.** Anyone holding the Supabase service key or
dashboard access can decrypt it. That is true of every secret in every Supabase
project and is the ceiling of an app with no server of its own. Treat the
service key accordingly.

**Revealing it.** Click **Reveal**. The value appears for thirty seconds and
then hides itself; switching tabs or leaving the project hides it immediately.

**Every reveal is recorded.** Before the value is read, the database writes a
line into that project's activity feed saying who looked and when. It never
contains the password. The recording happens in the same transaction as the
read, so there is no way to see the password without leaving the record — not
through the app, and not by calling the API directly. Setting and clearing are
recorded the same way.

**Clearing it.** Click **Clear**. The encrypted value is deleted, not merely
unlinked. Replacing a password deletes the old one too.

**Deleting the project** deletes the record and the encrypted password with it.
That is the end of a case and it should be the end of the credential.

**The demo does not store passwords.** The public demo at
`tomit1980.github.io/lumina` keeps everything in one browser-local blob, so
there is nowhere secure to put a credential. Setting one there is refused with a
message rather than pretended.

## Documents

Five checkboxes, each its own record: Photo ID front, Photo ID back, Bank
statement, Certified ID, Certified bank statement. The heading counts them —
"3 / 5 received" — so you can see at a glance what is still outstanding.

To add a sixth document type, add one line to `CLIENT_DOCUMENT_TYPES` in
`lib/client-info.ts`. No migration is needed; the table accepts any type.
Do **not** change the `id` of a type that is already in use — that is the value
stored in the database, and changing it orphans every row that has it. The
`label` is only what people read and can be changed freely.

## Checking the encrypted store

`client_secret_ids()` lists every client-password secret in the vault and
whether a live record still points at it. It needs the service key and never
returns the decrypted value. Anything with `referenced = false` is ciphertext
that outlived the case it belonged to, which should never happen — the
replace/clear path and the delete trigger both exist to prevent it.

```sql
select * from public.client_secret_ids() where not referenced;
```

## A note for whoever tightens this next

`revoke all on function ... from public` does **not** revoke it from `anon`.
Supabase ships default privileges on the `public` schema that grant EXECUTE on
every new function to `anon`, `authenticated` and `service_role` by name;
revoking from PUBLIC removes only the implicit grant. So the familiar pair —
`revoke all from public; grant execute to authenticated` — leaves signed-out
callers able to enter the function body, where they are refused by its first
line rather than at the door.

This was found by `tests/probes/client_probe.mjs`, not by reading the code, and
closed for the client functions in `20260914000400_client_rpc_anon.sql`.
Nothing leaked: `auth.uid()` is null for an anonymous session and the guard
refuses it. But the defence should not rest on the order of lines inside a
function body.

**Every other `security definer` function in this schema still has the loose
form** — `find_or_create_dm`, `create_project_with_tasks`, `has_permission` and
the rest. Each refuses an anonymous caller on its own merits today. Tightening
them is a worthwhile separate change, and it deserves its own probe run rather
than being folded into a feature migration.

## Troubleshooting

**"Couldn't save" on every field.** The person is a viewer on this project, or
their project access was removed while the tab was open. Check the project's
access dialog.

**"The server refused that request" when revealing.** Same cause: the reveal
needs editor access. A viewer can read the rest of the record but not this.

**"Finish signing in first".** The session has not completed two-factor
authentication, or is still holding a password an admin issued and has not
replaced it. Both gates apply to the client record exactly as they apply to the
rest of the workspace.

**A date looks a month off.** See "Dates" above, and check whether the value was
inserted by something other than the app.
