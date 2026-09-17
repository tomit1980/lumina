-- Recurring tasks: the columns. The function that uses them is 20260917000200.
--
-- A recurring task repeats by COMPLETION, not by schedule. Lumina is a static
-- export with no server of its own, so there is nothing to wake at midnight
-- and nothing here is driven by a clock. Finishing an occurrence is what
-- creates the next one. An occurrence nobody finishes simply stays overdue,
-- which is the honest behaviour rather than a pile of generated cards.
--
-- ONE RULE, FOUR PATTERNS. `repeat_unit` + `repeat_interval` expresses daily
-- (day/1), weekly (week/1), monthly (month/1) and every-N-days (day/N) — and
-- every-two-weeks and quarterly fall out for free. A four-way enum would have
-- carried a payload on one member and nothing on the other three, and every
-- reader would have had to switch on it.
--
-- WHY `repeat_anchor_day`. The next date is measured from the DUE date, not
-- from the completion date, so a weekly task due Monday stays due Mondays even
-- when it is finished on Wednesday. For months that needs the day the user
-- meant, kept separately: a task due the 31st has to land on the 28th in
-- February and then return to the 31st in March. Computing each occurrence
-- from the previous one's stored date instead would clamp to the 28th in
-- February and stay there for ever. The anchor is re-derived whenever a HUMAN
-- edits the due date, and copied unchanged when the function generates an
-- occurrence — those two rules are what separate an edit from a generated row.
--
-- WHY `repeat_tz`. `due_date` is a `timestamptz`: an instant, carrying no
-- timezone of its own. Recurrence has to ask "what calendar date is this, and
-- what is the next one" — questions with no answer until a zone is named.
-- Without one, each completion would re-anchor the series to whoever happened
-- to close the card, so a Sydney task completed from London would shift by
-- eleven hours and keep shifting. Storing the zone the series was defined in
-- makes every client and the database compute byte-identical dates, and it is
-- the smallest model that does: recording the intended local date instead
-- would still leave the next instant undefined until a zone was chosen.
--
-- It is captured ONCE, when the rule is created, and preserved through every
-- later edit. Editing a due date from a hotel in another country must not move
-- a colleague's series. Changing a series' calendar, if that is ever wanted,
-- belongs to an explicit control that does not exist yet.
--
-- The zone's validity is checked against `pg_timezone_names` inside
-- 20260917000200, not here: that lookup is not immutable and Postgres will not
-- accept it in a CHECK constraint.
--
-- WHY `recurred_from`, AND WHY IT IS UNIQUE. This is the whole safety story of
-- the feature. Completion must produce exactly one successor even when two
-- requests arrive at once, when a drag jitters across the done column twice,
-- or when a client retries a call whose response it never saw. Every one of
-- those is a race, and a sequence of checks inside a function loses races. A
-- unique index does not. `recurred_from` points at the occurrence that
-- generated the row, and at most one row may point at any occurrence — so
-- "one successor per completion" is a fact the database enforces rather than a
-- property the function tries to maintain. It also leaves the whole series
-- walkable as a linked list, which a plain chain id would not: a chain id
-- groups occurrences but forbids nothing.
--
-- `on delete set null` rather than cascade: deleting a finished occurrence
-- breaks the chain's history, it does not delete the live task that came after
-- it. The index is partial so the nulls that leaves behind never collide.
--
-- NO GATE WORK AND NO REALTIME WORK, deliberately, and this is the reason so
-- nobody re-derives it later: `public.tasks` is already inside both
-- restrictive gates (20260910004000 and 20260912000200 name it) and is already
-- published with `replica identity full` (20260909001100). Those are
-- properties of the TABLE. Adding columns to a table already covered by both
-- changes neither, and `gate_coverage()` output is unaffected.

alter table public.tasks
  add column if not exists repeat_unit       text,
  add column if not exists repeat_interval   integer,
  add column if not exists repeat_anchor_day integer,
  add column if not exists repeat_tz         text,
  add column if not exists recurred_from     text references public.tasks(id) on delete set null;

-- At most one successor per completed occurrence.
create unique index if not exists tasks_recurred_from_key
  on public.tasks (recurred_from) where recurred_from is not null;

-- `add constraint` has no `if not exists`, and this migration has to be a
-- no-op on a second run like every other one in this directory.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.tasks'::regclass and conname = 'tasks_repeat_shape'
  ) then
    alter table public.tasks add constraint tasks_repeat_shape check (
      -- All four move together. A unit without an interval is not a weaker
      -- rule, it is a corrupt one, and the mapping layer would have to invent
      -- a number for it.
      (repeat_unit is null and repeat_interval is null
       and repeat_anchor_day is null and repeat_tz is null)
      or (
        repeat_unit in ('day','week','month')
        and repeat_interval between 1 and 999
        and repeat_tz is not null
        -- The anchor exists for months and only for months: `day` and `week`
        -- arithmetic never clamps, so a weekday or an N-day cadence is already
        -- stable and an anchor would be a second, silent source of truth.
        and ((repeat_unit = 'month') = (repeat_anchor_day is not null))
        and (repeat_anchor_day is null or repeat_anchor_day between 1 and 31)
      )
    );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.tasks'::regclass and conname = 'tasks_repeat_needs_due_date'
  ) then
    -- A rule with nothing to measure from is a promise the app cannot keep.
    -- This is a BACKSTOP, not a workflow: every write path clears the rule
    -- itself when a due date is removed. If anyone ever reads this message,
    -- a write path has a bug and that is what should be fixed.
    alter table public.tasks add constraint tasks_repeat_needs_due_date check (
      repeat_unit is null or due_date is not null
    );
  end if;
end $$;
