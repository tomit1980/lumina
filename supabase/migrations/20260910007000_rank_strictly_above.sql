-- The rank rules were one comparison too strict, and it broke a real flow.
--
-- 20260910006000 refused any role change where `rank >= mine`. "At or above"
-- also means YOUR OWN role, so an admin could no longer edit the role they
-- themselves hold — including to REDUCE it. `tests/rls/role-writes.test.ts`
-- documents that exact case ("the caller may be editing their own powers")
-- and it went red, which is the test earning its keep: the rule was written
-- to stop escalation and had quietly forbidden de-escalation too.
--
-- WHAT THE BOUNDARY ACTUALLY NEEDS is "strictly above". Walk the cases:
--
--   * A role ABOVE you — the Owner role, seen from Admin. Refused by `>`,
--     which is the entire point and is unchanged.
--   * A PEER role, or your own. An admin can already assign the admin role
--     itself, so creating or editing something at their own rank grants
--     nobody anything they could not already have. And Rule 1 still applies:
--     whatever they write, they cannot put a permission on it that they do
--     not hold themselves. So the only thing `>=` was buying was blocking an
--     admin from tidying up their own role.
--
-- Rule 1 is what stops escalation. Rule 2/3/4 stop you reaching UPWARDS.
-- Conflating the two cost a working feature and bought no safety.

create or replace function public.enforce_role_rank()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine integer := public.actor_rank();
  granted text;
begin
  if auth.uid() is null then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' and new.rank > mine then
    raise exception 'You cannot create a role above your own';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.rank > mine then
    raise exception 'You cannot change a role above your own';
  end if;
  if tg_op = 'UPDATE' and new.rank > mine then
    raise exception 'You cannot raise a role above your own';
  end if;

  -- Unchanged, and now carrying the whole anti-escalation job on its own:
  -- only what is being ADDED is checked, so revoking is always allowed.
  if tg_op in ('INSERT', 'UPDATE') then
    select p into granted
      from unnest(new.permissions) as p
     where not public.has_permission(p)
       and (tg_op = 'INSERT' or not (p = any (old.permissions)))
     limit 1;
    if granted is not null then
      raise exception 'You cannot grant "%" — your own role does not include it', granted;
    end if;
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create or replace function public.enforce_assign_rank()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_rank integer;
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.role_id is not distinct from old.role_id then
    return new;
  end if;
  select rank into target_rank from public.roles where id = new.role_id;
  -- Strictly above, for the same reason: an admin can already hand out the
  -- admin role, so refusing a peer-ranked one was noise. Handing out OWNER
  -- is the escalation, and `>` still refuses it.
  if target_rank > public.actor_rank() then
    raise exception 'You cannot assign a role above your own';
  end if;
  return new;
end;
$$;
