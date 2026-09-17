-- Completing a recurring task, and creating its one successor, in one
-- transaction.
--
-- WHY THIS IS `SECURITY DEFINER`, which is not a decision to take lightly.
-- A recurring task must keep recurring even when the person who finished this
-- occurrence cannot create tasks. The recurrence was authorised once, by
-- somebody who could, when the rule was set up; the person closing the card is
-- not the person being asked for permission. RLS has no way to express "this
-- INSERT came from a completion", so a permissive `tasks_insert` policy cannot
-- say it. Elevation is the only mechanism available.
--
-- WHAT KEEPS IT NARROW. The function does not accept the new task's content.
-- The caller supplies four things: which task was completed, where in the done
-- column it landed, and an id for the row to create. Everything that decides
-- what the new task IS — title, description, priority, owner, collaborators,
-- labels, the rule itself — and everything that decides WHEN it is due is read
-- from the source row or computed here. The most this can produce is a dated
-- copy of a row the caller can already see and already edit.
--
-- An earlier draft took the due date as a parameter, bounded by a sanity
-- check. That bound could never prove the date followed the rule; storing the
-- series' timezone made the database able to compute the date itself, and the
-- parameter went away. A parameter that cannot be validated is better removed
-- than guarded.
--
-- A DEFINER BODY SEES NO RLS AT ALL, INCLUDING BOTH RESTRICTIVE GATES. That is
-- what 20260912000100_assurance_gaps.sql exists to record: `require_assurance`
-- and `require_password_change` are policies, and policies are not consulted
-- here. Every one is re-made by hand below, in order, before anything is read
-- or written. `public.move_task` is `security invoker`, which means that when
-- it is called from in here it runs with THIS function's owner's rights, not
-- the caller's — so steps 5 to 7 are not defence in depth, they are the only
-- thing standing between a viewer and a write.
--
-- `set search_path = ''` AND EVERY NAME QUALIFIED. A definer function that
-- resolves any name through the caller's search_path hands the caller a way to
-- choose which code runs as the owner. `session_is_assured` and
-- `password_is_current` already use the empty path; this follows them rather
-- than the looser `= public` some trigger functions use. pg_catalog is still
-- searched implicitly, so built-in casts and operators resolve, but nothing in
-- `public` or `auth` does.
--
-- ONE SUCCESSOR PER OCCURRENCE IS A SCHEMA FACT, NOT A CHECK. The unique
-- partial index on `recurred_from` (20260917000100) is what guarantees it.
-- Three different things can ask for a second successor — a drag that jitters
-- across the done column, a client retrying a call whose reply it never saw,
-- and two requests arriving at once — and a sequence of IF statements loses
-- races that an index wins. `for update` on the source serialises the third;
-- the provenance lookup absorbs the first two.
--
-- THERE IS NO `BEGIN … EXCEPTION` BLOCK ANYWHERE IN THIS FUNCTION, and that is
-- deliberate. A plpgsql exception block takes a savepoint at its own BEGIN, so
-- catching an error inside one rolls back only the statements within it and
-- leaves everything before it committed. An earlier draft cleared the source's
-- rule and then caught a unique violation on the insert — returning success
-- having destroyed the recurrence and created nothing. Every anomaly here must
-- abort the whole transaction, so none is caught.
--
-- THE RULE IS CLEARED LAST. The source keeps its rule until the successor
-- provably exists, in the same transaction. This is also what makes reopening
-- a completed occurrence safe: it comes back without a rule, so completing it
-- again cannot mint a second successor.
--
-- THE RETRY PATH MUTATES NOTHING. If a successor already exists, the function
-- returns it and stops — it does not re-apply the caller's move. A committed
-- first call already moved the source; re-applying a move on a retry would let
-- a replay silently undo a legitimate later reopening, or shove the card to a
-- position the user has since changed. `p_index` is ignored on that path.

create or replace function public.complete_task_with_next(
  p_task_id text,
  p_index   integer,
  p_next_id text
)
returns table (
  next_position integer,
  next_assignee uuid,
  next_due      timestamptz,
  created       boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me          uuid := auth.uid();
  v_task        public.tasks%rowtype;
  v_succ_pos    integer;
  v_succ_assign uuid;
  v_succ_due    timestamptz;
  v_done_status text;
  v_next_status text;
  v_assignee    uuid;
  v_base        date;
  v_today       date;
  v_cand        date;
  v_month_start date;
  v_days        integer;
  v_next_due    timestamptz;
  v_found       boolean := false;
  k             integer;
begin
  -- 1-3. The session, and both restrictive gates by hand.
  if v_me is null then
    raise exception 'You must be signed in to do that.';
  end if;
  if not public.session_is_assured() then
    raise exception 'Finish signing in first.';
  end if;
  if not public.password_is_current() then
    raise exception 'Change your password first.';
  end if;

  -- 4. The source, LOCKED. Everything downstream reads a row that cannot
  --    change underneath it; without this, two concurrent completions both see
  --    "no successor yet" and both insert.
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found then
    raise exception 'That task does not exist.';
  end if;

  -- 5-7. `tasks_read` and `tasks_update`'s USING clause, by hand. The
  --      not-visible message is deliberately identical to the not-found one:
  --      a different message would turn this into an existence oracle for
  --      tasks in projects the caller cannot see.
  if not public.can_see_project(v_task.project_id) then
    raise exception 'That task does not exist.';
  end if;
  if not public.has_permission('task.edit') then
    raise exception 'Your role cannot edit tasks.';
  end if;
  if public.project_is_viewer_only(v_task.project_id) then
    raise exception 'You have view-only access to this project.';
  end if;

  -- 8. Parameter validation, BEFORE the branch below. The retry path ignores
  --    p_index, but a validation sitting behind an early return is one
  --    refactor away from being skipped. `move_task` clamps the value into
  --    the column's range itself, exactly as it does for every other caller,
  --    so this asks only that a value was supplied.
  if p_index is null then
    raise exception 'A position is required.';
  end if;
  if p_next_id is null or p_next_id = '' then
    raise exception 'An id for the next occurrence is required.';
  end if;

  -- 9. The done column, derived rather than accepted. `statuses_single_done_idx`
  --    (20260910005000) is a partial unique index guaranteeing there is at
  --    most one, so there is nothing for a caller to choose and no reason to
  --    let them try.
  select s.id into v_done_status from public.statuses s where s.is_done;
  if v_done_status is null then
    raise exception 'This workspace has no done column.';
  end if;

  -- 10. RETRY / ALREADY-SUCCEEDED. Read-only, and it returns whatever
  --     successor exists regardless of whether its id matches p_next_id: a
  --     second completion carrying a fresh id must not create a second row.
  select t.position, t.assignee_id, t.due_date
    into v_succ_pos, v_succ_assign, v_succ_due
    from public.tasks t where t.recurred_from = p_task_id;
  if found then
    return query select v_succ_pos, v_succ_assign, v_succ_due, false;
    return;
  end if;

  -- 11. Does this occurrence owe a successor at all? Without this check the
  --     function is a way to create a task without `task.create` — against any
  --     row the caller can edit, as many times as they like. It also covers a
  --     reopened occurrence, whose rule its own earlier completion cleared.
  if v_task.repeat_unit is null then
    raise exception 'That task does not repeat.';
  end if;
  if v_task.due_date is null then
    -- Defensive: `tasks_repeat_needs_due_date` forbids this combination.
    raise exception 'A repeating task must have a due date.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = v_task.repeat_tz
  ) then
    raise exception 'That rule has an unknown timezone.';
  end if;

  -- 12. Where the successor goes: the first open column, also derived.
  select s.id into v_next_status
    from public.statuses s where not s.is_done
    order by s.position, s.id limit 1;
  if v_next_status is null then
    raise exception 'There is no open column to put the next one in.';
  end if;

  -- 13. THE DATE, computed here rather than accepted. This mirrors
  --     `nextDueDate` in lib/recurrence.ts line for line, and a live test runs
  --     a table of rules through both and compares — if you change one, change
  --     the other or that test will say so.
  --
  --     Everything happens on calendar dates in the SERIES' timezone, so two
  --     people in different countries completing the same task get identical
  --     instants. Advancing by `interval * k` from the original due date (not
  --     by one step from the previous result) is what keeps a monthly task
  --     anchored: a February that clamped to the 28th does not drag March down
  --     with it.
  v_base  := (v_task.due_date at time zone v_task.repeat_tz)::date;
  v_today := (pg_catalog.now() at time zone v_task.repeat_tz)::date;

  for k in 1..4000 loop
    if v_task.repeat_unit = 'day' then
      v_cand := v_base + (v_task.repeat_interval * k);
    elsif v_task.repeat_unit = 'week' then
      v_cand := v_base + (v_task.repeat_interval * k * 7);
    else
      v_month_start := (
        pg_catalog.date_trunc('month', v_base::timestamp)
        + (v_task.repeat_interval * k) * interval '1 month'
      )::date;
      v_days := extract(
        day from (v_month_start + interval '1 month' - interval '1 day')
      )::integer;
      v_cand := v_month_start + least(v_task.repeat_anchor_day, v_days) - 1;
    end if;

    -- Strictly after today, in the series' zone. Not ">=": a weekly task
    -- finished three weeks late would otherwise regenerate as due today, which
    -- reads to the user as the feature not having worked. The cost is that a
    -- daily task finished a day late skips today, which is documented.
    if v_cand > v_today then
      v_found := true;
      exit;
    end if;
  end loop;

  if not v_found then
    -- A base so old the cadence cannot reach today inside the cap. That is a
    -- corrupt row, not a schedule.
    raise exception 'Cannot compute the next occurrence for that rule.';
  end if;

  v_next_due := v_cand::timestamp at time zone v_task.repeat_tz;

  -- 14. The owner, pruned. `tasks_check_assignee` fires on INSERT and raises
  --     if the assignee cannot see the project. Since everything here is one
  --     transaction, letting it fire would roll back the user's own
  --     completion and show them an error about somebody else's access. The
  --     occurrence lands unassigned instead, and the caller is told so by
  --     `next_assignee` coming back null. Dropping people who lost sight of a
  --     project is what `prune_collaborators_on_reparent` already does.
  v_assignee := v_task.assignee_id;
  if v_assignee is not null
     and not public.user_can_see_project(v_task.project_id, v_assignee) then
    v_assignee := null;
  end if;

  -- 15. The successor. `position` is omitted so `tasks_default_position`
  --     appends it. A unique violation here — on the primary key, or on
  --     `tasks_recurred_from_key` — aborts the transaction, uncaught, by
  --     design: step 4 already excludes concurrency, so the index firing means
  --     something is wrong that should be loud.
  insert into public.tasks (
    id, project_id, title, description, status, priority, assignee_id,
    due_date, start_time, duration_minutes, reminder_minutes, labels,
    repeat_unit, repeat_interval, repeat_anchor_day, repeat_tz,
    recurred_from, created_by, created_at
  ) values (
    p_next_id, v_task.project_id, v_task.title, v_task.description,
    v_next_status, v_task.priority, v_assignee,
    v_next_due, v_task.start_time, v_task.duration_minutes,
    v_task.reminder_minutes, v_task.labels,
    v_task.repeat_unit, v_task.repeat_interval, v_task.repeat_anchor_day,
    v_task.repeat_tz, p_task_id, v_me, pg_catalog.now()
  );

  -- 16. Collaborators, after the parent row: `check_task_collaborator` refuses
  --     a row naming the task's current owner, and the owner only exists once
  --     the insert above has landed. Anyone who has since lost sight of the
  --     project is dropped, for the same reason the owner was.
  --     Attachments are deliberately NOT copied: they are evidence of the
  --     occurrence that just finished.
  insert into public.task_collaborators (task_id, user_id)
  select p_next_id, c.user_id
    from public.task_collaborators c
   where c.task_id = p_task_id
     and c.user_id is distinct from v_assignee
     and public.user_can_see_project(v_task.project_id, c.user_id);

  -- 17. The completion itself.
  perform public.move_task(p_task_id, v_done_status, p_index);

  -- 18. And only now, the rule moves off the finished occurrence onto the new
  --     one. A finished card is a record of work, not a schedule.
  update public.tasks
     set repeat_unit = null, repeat_interval = null,
         repeat_anchor_day = null, repeat_tz = null
   where id = p_task_id;

  select t.position into v_succ_pos from public.tasks t where t.id = p_next_id;
  return query select v_succ_pos, v_assignee, v_next_due, true;
end;
$$;

-- Both halves, by full signature. `revoke ... from public` removes the
-- implicit grant every function is born with; `from anon` removes the one
-- Supabase's default privileges on this schema hand out BY NAME. Closing
-- either alone leaves the other open — 20260916000500_definer_public.sql is
-- the migration that exists because thirteen functions had only one of them.
revoke all on function public.complete_task_with_next(text, integer, text) from public, anon;
grant execute on function public.complete_task_with_next(text, integer, text) to authenticated;

-- Exactly one overload may exist. This function's signature changed several
-- times while it was being designed, and an orphaned earlier version left
-- executable — one that still accepted a client-supplied due date, say —
-- would be the worst possible residue of this work.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'complete_task_with_next';
  if v_count <> 1 then
    raise exception
      'Expected exactly one complete_task_with_next, found %. Drop the stale overload by full signature.',
      v_count;
  end if;
end $$;
