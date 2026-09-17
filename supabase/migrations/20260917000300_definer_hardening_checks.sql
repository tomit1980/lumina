-- Assert the hardening of `complete_task_with_next`, rather than trusting it.
--
-- WHY THIS IS A MIGRATION AND NOT A PROBE. Every property below lives in
-- `pg_proc`, which PostgREST does not expose, so no test that talks to the API
-- can see any of it. A migration can, it runs on every database the schema
-- reaches, and it runs BEFORE the code that depends on it — which is exactly
-- the ordering a security property wants.
--
-- These are the six checks the plan asked for, minus the two that are not
-- expressible here: whether `authenticated` can CREATE SCHEMA (a database-level
-- privilege, checked separately) and who owns the function (identical for every
-- function in this schema by construction, since nothing anywhere issues
-- `alter function ... owner to`).
--
-- Any failure here should stop a deploy. That is the point of putting them in
-- the transaction rather than in a report somebody reads afterwards.
do $$
declare
  v_fn      regprocedure := 'public.complete_task_with_next(text, integer, text)'::regprocedure;
  v_secdef  boolean;
  v_config  text[];
  v_count   integer;
  v_loose   text;
begin
  -- 1. It is still SECURITY DEFINER, and still pinned to an empty search_path.
  --    A later `create or replace` that dropped either clause would silently
  --    change what runs as the owner and whose schemas resolve its names.
  select p.prosecdef, p.proconfig into v_secdef, v_config
    from pg_catalog.pg_proc p where p.oid = v_fn;

  if not v_secdef then
    raise exception 'complete_task_with_next is no longer SECURITY DEFINER.';
  end if;
  -- Postgres normalises `SET search_path = ''` to the proconfig entry
  -- `search_path=""` — quoted, not bare. Matching on the bare form looks
  -- right and never fires, which is the failure mode this whole file exists
  -- to avoid, so match the value and accept either spelling of empty.
  if v_config is null
     or not exists (
       select 1 from unnest(v_config) c
        where c in ('search_path=""', 'search_path=''''', 'search_path=')
     ) then
    raise exception
      'complete_task_with_next must be SET search_path = '''' (found: %). Without it, the caller chooses which code runs as the owner.',
      coalesce(array_to_string(v_config, ','), 'none');
  end if;

  -- 2. Exactly one overload. This function's signature changed repeatedly
  --    while it was designed; a stale one left executable — an earlier version
  --    that still accepted a client-supplied due date, say — would be the
  --    worst possible residue of the work.
  select count(*) into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'complete_task_with_next';
  if v_count <> 1 then
    raise exception 'Expected exactly one complete_task_with_next, found %.', v_count;
  end if;

  -- 3. Neither PUBLIC nor anon may execute it. Both halves, because they are
  --    two separate grants and closing one leaves the other open —
  --    20260916000500_definer_public.sql is the migration that exists because
  --    thirteen functions had only one of them.
  if has_function_privilege('public', v_fn, 'EXECUTE') then
    raise exception 'PUBLIC can still execute complete_task_with_next.';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') then
    raise exception 'anon can still execute complete_task_with_next.';
  end if;

  -- 4. ...but `authenticated` must, or the app cannot complete a recurring
  --    task at all. A revoke that overshot would look like the feature simply
  --    not working.
  if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'authenticated cannot execute complete_task_with_next.';
  end if;

  -- 5. Every helper it calls pins its OWN search_path. A hardened caller gains
  --    nothing by invoking a helper that resolves names through whatever path
  --    the session happens to carry. `= public` is acceptable here and `= ''`
  --    is better; what is not acceptable is none at all.
  select string_agg(p.proname, ', ') into v_loose
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'session_is_assured', 'password_is_current', 'can_see_project',
       'has_permission', 'project_is_viewer_only', 'user_can_see_project',
       'move_task'
     )
     and (p.proconfig is null
          or not exists (
            select 1 from unnest(p.proconfig) c where c like 'search_path=%'
          ));
  if v_loose is not null then
    raise exception
      'These helpers resolve names through the caller''s search_path: %. complete_task_with_next calls them as its owner.',
      v_loose;
  end if;
end $$;
