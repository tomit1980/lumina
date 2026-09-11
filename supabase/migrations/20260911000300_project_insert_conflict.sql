-- create_project_with_tasks: stop asking for a read the caller cannot pass.
--
-- WHAT WENT WRONG. The project insert used `on conflict (id) do nothing` to
-- make a retry a no-op. Postgres evaluates the target table's SELECT policy
-- for an ON CONFLICT clause - it has to, to decide what the conflicting row
-- is - and `projects_read` is `can_see_project(id)`, which for a row that does
-- not exist yet falls through every branch it has:
--
--   when has_permission('members.manage')                then true
--   when (select not restricted from projects where ...) then true   -- NULL
--   when (select created_by from projects where ...) = u then true   -- NULL
--   when exists (select 1 from project_members ...)      then true   -- false
--   else false
--
-- Only the first branch does not consult the table, so only a caller holding
-- `members.manage` passed. Owner and Admin both hold it, which is why every
-- test written from those two accounts was green and the feature looked
-- finished. A role holding `project.create` alone - the "ordinary project
-- manager" 20260906000350_fix_project_policies.sql contemplates, and the whole
-- reason task-set management is not bundled into that permission - was refused
-- with "new row violates row-level security policy", naming a policy it
-- actually satisfied.
--
-- The same caller's plain INSERT succeeded in the same session. That is what
-- located it: the difference was not the permission, it was the ON CONFLICT.
--
-- THE FIX keeps idempotency and drops the read. Check for the row first - a
-- SELECT that succeeds for a retry, because by then the project exists and is
-- visible - and insert only when it is absent. A genuine race between two
-- identical calls is caught as a unique violation and treated as success,
-- which is the shape find_or_create_dm (20260908000800_store_swap.sql:403)
-- already uses for the same reason.
--
-- The task insert keeps `on conflict do nothing`: by the time it runs the
-- project exists in this transaction, so `tasks_read`'s can_see_project is
-- satisfied and the ON CONFLICT read costs nothing.
create or replace function public.create_project_with_tasks(
  p_project jsonb,
  p_tasks   jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_project_id text := p_project ->> 'id';
  v_expected   integer := jsonb_array_length(coalesce(p_tasks, '[]'::jsonb));
  v_landed     integer;
begin
  if v_project_id is null or v_project_id = '' then
    raise exception 'A project id is required.';
  end if;

  if not exists (select 1 from public.projects p where p.id = v_project_id) then
    begin
      insert into public.projects (
        id, name, description, emoji, color, priority, restricted,
        created_by, created_at, created_from_task_set_id
      ) values (
        v_project_id,
        p_project ->> 'name',
        coalesce(p_project ->> 'description', ''),
        coalesce(p_project ->> 'emoji', '📁'),
        coalesce(p_project ->> 'color', '#7c3aed'),
        coalesce(p_project ->> 'priority', 'medium'),
        coalesce((p_project ->> 'restricted')::boolean, false),
        auth.uid(),
        coalesce((p_project ->> 'created_at')::timestamptz, now()),
        p_project ->> 'created_from_task_set_id'
      );
    exception when unique_violation then
      -- Two identical calls raced and the other one won. The row is there,
      -- which is all this call wanted.
      null;
    end;
  end if;

  -- Not a formality. A refused INSERT raises 42501 and never reaches here, but
  -- a row filtered out from under us would not - and "the insert did not
  -- error" has never been the same claim as "the row is there".
  if not exists (select 1 from public.projects p where p.id = v_project_id) then
    raise exception 'You do not have permission to create projects.';
  end if;

  if v_expected > 0 then
    -- `position` is sent explicitly and non-negative, so set_task_position's
    -- -1 sentinel never fires and the definition's order survives exactly.
    insert into public.tasks (
      id, project_id, title, description, status, priority,
      labels, position, created_by, created_at
    )
    select
      t.id, v_project_id, t.title, coalesce(t.description, ''),
      t.status, coalesce(t.priority, 'medium'),
      coalesce(t.labels, '{}'), t.position,
      auth.uid(), coalesce(t.created_at, now())
    from jsonb_to_recordset(p_tasks) as t(
      id text, title text, description text, status text,
      priority text, labels text[], position integer, created_at timestamptz
    )
    on conflict (id) do nothing;

    select count(*) into v_landed
      from public.tasks tk
     where tk.project_id = v_project_id
       and tk.id in (select x ->> 'id' from jsonb_array_elements(p_tasks) as x);

    if v_landed <> v_expected then
      raise exception
        'The project was not created: % of % tasks were refused.',
        v_expected - v_landed, v_expected;
    end if;
  end if;
end;
$$;
