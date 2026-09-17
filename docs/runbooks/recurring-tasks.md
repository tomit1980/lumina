# Recurring tasks

Work that comes back — a weekly client report, a monthly reconciliation, a
chase every ten days. Set **Repeats** on a task and finishing it creates the
next one, so the card you just closed stays in Done as a record of that
occurrence and a fresh one appears in To Do.

## Setting one

Open a task, give it a **due date**, then in the Schedule box set
**Repeats every** and the unit: Day, Week or Month. "Every 1 Week" and
"Every 3 Days" both read the way they sound.

**A repeat needs a due date.** There is nothing to count from without one, so
the controls stay disabled until you give it one, and clearing the due date
clears the repeat.

**"Never" is how you turn it off.** There is no separate switch.

## When the next one falls due

**Dated from the due date, not from the day you finish.** A weekly task due
every Monday stays due on Mondays even when you actually finish it on
Wednesday. Slipping once does not move the schedule permanently.

**A late task does not hand you another late one.** The next occurrence is
always the first date on the rule's own cadence that is still ahead of today.
Finish a three-week-old weekly task and you get next Monday, not the Monday
that has already gone.

**A daily task finished a day late skips today.** Due yesterday, finished
today, and the next one is tomorrow — today's occurrence never appears. That
follows from one completion making exactly one successor.

### Months keep the day you gave them

A monthly task due the **31st** lands on the **28th** in February and goes back
to the **31st** in March. The day you set is remembered separately from the
date of any one occurrence, so a short month does not drag the rest of the year
down with it.

Change the due date and the intended day changes with it — that is you saying
what you meant.

### Timezones

A series is computed in the timezone it was **created** in, and keeps it. If
you set up a weekly task in Sydney and later edit its due date from a hotel in
London, the series stays on Sydney's calendar; only an explicit new rule
(turn Repeats off, then on again) captures a new timezone.

This matters when more than one person completes the same recurring task from
different countries. Without it, every completion would shift the series by the
difference between them, and the shifts would accumulate.

## What carries over, and what does not

| Carried | Not carried |
|---|---|
| Title, description, priority | **Files** |
| Owner and collaborators | Comments and activity history |
| Start time, duration, reminder | The completed card's place in Done |
| The repeat rule itself | |

**Files do not come with it.** An attachment on a finished occurrence is
usually evidence *of* that occurrence — this month's signed form, last week's
statement — and copying it every cycle would duplicate the stored file for
ever.

**An owner who has lost access is dropped.** If the person the task was
assigned to can no longer see the project, the new occurrence arrives
unassigned rather than the completion failing over somebody else's access. The
same applies to collaborators.

## Reopening

**Reopening a finished occurrence does not bring its recurrence back.** The
rule moves off a card the moment it is completed and onto the new one, so a
finished card is a record of work rather than a schedule. Completing it a
second time creates nothing.

That is also what stops a drag that wobbles across the Done column from
creating two occurrences.

If you reopened something by mistake and want the series to continue, it
already is: look for the new occurrence in To Do.

## Permissions

**Anyone who can edit a task can complete a recurring one**, including people
whose role cannot create tasks at all. The recurrence was authorised once, when
somebody who *could* create tasks set the rule up; the person closing the card
today is not the one being asked for permission.

This is enforced by the database, not by the screen — the rules are in
`supabase/migrations/20260917000200_complete_task_with_next.sql` and are
asserted from real sign-ins in `tests/rls/task-recurrence.test.ts`.

## "Repeating is paused"

If you see this, recurrence has been switched off at the database and a
recurring task cannot be completed for the moment. **Nothing is lost**: the
task stays open with its rule intact, and it can be completed normally as soon
as recurrence is switched back on.

Completion is *blocked* rather than quietly downgraded on purpose. Letting it
finish without creating the next one would leave a completed task carrying a
rule that nothing would ever act on — a recurrence destroyed silently, which
nobody would notice until something was missed.

If you must finish the task before then, set **Repeats** to **Never** and
complete it normally. That ends the series, visibly, because you chose to.

### For whoever is doing the switching

```sql
-- Pause. Reversible, loses nothing.
revoke execute on function public.complete_task_with_next(text, integer, text) from authenticated;

-- Resume.
grant execute on function public.complete_task_with_next(text, integer, text) to authenticated;
```

Do **not** reach for `update public.tasks set repeat_unit = null` to pause the
feature. That **irreversibly deletes every rule every person has configured**,
with no record of what they were. It is only for when the rules themselves are
the problem.

## Troubleshooting

**"That task does not repeat."** The card has no rule — most often because it
has already been completed once and the rule moved to its successor. Look in
To Do.

**Two occurrences appeared.** They should not, and the database forbids it: at
most one task may name any completed occurrence as its parent
(`tasks_recurred_from_key`). If you genuinely have two, one of them was created
by hand.

**The new one is due at an odd time of day.** Check which timezone the series
was created in — see Timezones above.

**The new occurrence is unassigned.** The previous owner can no longer see the
project. See "What carries over".
